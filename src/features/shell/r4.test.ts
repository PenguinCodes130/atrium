// Round 4 (gauntlet r2 Fix List) unit tests: the canvas root box (H1), position fixed (L1), root kinds
// (L2), the glow shape and the success toast (Fix 6), the door glyph during the sweep (Fix 2), the
// crumb and instance name (Fix 9), the coming room and the live-only palette (Fix 11), ScreenHeader (Fix 4).
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { rootSelector, scopeCustomCss, scopeCustomCssWithReport, type ScopeRoot } from "./custom-css";
import { GLOW_HOLD_MS, GLOW_PEAK_MS, durations, glowKeyframes, glowOpacityAt } from "./motion";
import { createToastStore } from "./toast-store";
import { toastOffsetAvoiding } from "./toast";
import { DOOR_PASS_MS, doorLit } from "./sweep-context";
import { readableHost, DEFAULT_INSTANCE_NAME } from "./instance-name";
import { crumbsFor } from "./shell-frame";
import { comingRouteFor, isActive, ROUTES_AVAILABLE, SETTINGS, USERS_AND_SECURITY_HREF, USERS_AND_SECURITY_LABEL } from "./nav";
import { jumpItems, filterJumpItems } from "./palette-fallback";
import { EMPTY_NAV } from "./shell-context";
import { Screen, ScreenHeader } from "./screen-header";

const layerBody = (css: string) => /@layer atrium-custom\{\n([\s\S]*)\n\}$/.exec(css)?.[1] ?? css;

/** Gauntlet r2 customisation H1: each of these changed shell pixels in round 3. */
const H1_PROBES = {
  margin: "[data-atrium-canvas]{margin-top:-700px}",
  outline: "[data-atrium-canvas]{outline:200vmax solid red}",
  shadow: "[data-atrium-canvas]{box-shadow:0 0 0 200vmax red}",
  dropShadow: "[data-atrium-canvas]{filter:drop-shadow(0 -400px 0 red)}",
  reflect: "[data-atrium-canvas]{-webkit-box-reflect:above 0px}",
  wide: "[data-atrium-canvas]{width:300vw;margin-left:-100vw}",
  scopeMinWide: ":scope{min-width:300vw;margin-left:-100vw}",
} as const;

describe("Fix 1 (H1): custom CSS cannot change the canvas root's own box", () => {
  for (const [name, css] of Object.entries(H1_PROBES)) {
    it(`drops every declaration of the ${name} probe, with a reason`, () => {
      const r = scopeCustomCssWithReport(css);
      expect(r.css, name).toBe("");
      expect(r.dropped.length, name).toBeGreaterThan(0);
      for (const d of r.dropped) expect(d.reason).toMatch(/root/);
    });
  }

  it("drops the same properties on refined root selectors (class, attribute, pseudo-class, !important)", () => {
    for (const sel of ["[data-atrium-canvas].x", "[data-atrium-canvas]:hover", '[data-atrium-canvas][data-canvas-tone="light"]', ":scope:focus-within", "[data-atrium-canvas]:not(.y)"]) {
      expect(scopeCustomCss(`${sel}{margin:-10px !important;outline:9px solid red;box-shadow:0 0 0 9px red;filter:blur(2px);zoom:3;transform:scale(2);width:120%;min-inline-size:200vw}`), sel).toBe("");
    }
  });

  it("keeps root colours, fonts and safe sizes, and keeps box properties on descendants", () => {
    expect(layerBody(scopeCustomCss("[data-atrium-canvas]{color:red;background:#000;font-family:serif;letter-spacing:0.02em;width:100%;min-width:auto;--theme-accent:#f00}"))).toBe(
      "[data-atrium-canvas]{color:red;background:#000;font-family:serif;letter-spacing:0.02em;width:100%;min-width:auto;--theme-accent:#f00}",
    );
    expect(layerBody(scopeCustomCss("[data-atrium-canvas] .card{margin:-4px;box-shadow:0 0 0 4px red;filter:blur(1px);width:300px}"))).toBe("[data-atrium-canvas] .card{margin:-4px;box-shadow:0 0 0 4px red;filter:blur(1px);width:300px}");
    // a pseudo-element is inside the root's paint containment, so it is a descendant
    expect(layerBody(scopeCustomCss("[data-atrium-canvas]::before{box-shadow:0 0 0 9px red}"))).toBe("[data-atrium-canvas]::before{box-shadow:0 0 0 9px red}");
  });

  it("splits a selector list: descendants keep the declaration, the root copy loses it", () => {
    const r = scopeCustomCssWithReport(":scope, .card { margin: -20px; color: red }");
    expect(layerBody(r.css)).toBe("[data-atrium-canvas] .card{margin:-20px;color:red}\n[data-atrium-canvas]{color:red}");
    expect(r.dropped.map((d) => d.text)).toEqual(["margin: -20px"]);
  });
});

describe("Fix 13 (L1): position fixed is dropped with a reason", () => {
  it("anywhere in the canvas", () => {
    const r = scopeCustomCssWithReport(".x{position:fixed;inset:0} .y{position: FIXED !important} .z{position:sticky;top:0}");
    expect(layerBody(r.css)).toBe("[data-atrium-canvas] .x{inset:0}\n[data-atrium-canvas] .z{position:sticky;top:0}");
    expect(r.dropped.filter((d) => /position: fixed/.test(d.reason))).toHaveLength(2);
  });
});

describe("Fix 13 (L2): one sanitiser for canvas, frame and node roots", () => {
  const kinds: [ScopeRoot, string][] = [
    [{ kind: "canvas" }, "[data-atrium-canvas]"],
    [{ kind: "frame", id: "homelab" }, '[data-atrium-app-frame="homelab"]'],
    [{ kind: "node", id: "n_42-a" }, '[data-node="n_42-a"]'],
  ];
  for (const [root, sel] of kinds) {
    it(`${root.kind}: scopes to ${sel}, :scope names the root, and replays the round 1 escapes`, () => {
      expect(rootSelector(root)).toBe(sel);
      expect(layerBody(scopeCustomCss(".a{color:red} :scope > b{color:blue}", { root }))).toBe(`${sel} .a{color:red}\n${sel} > b{color:blue}`);
      // E1 to E3 from gauntlet r1, plus the H1 root box probe written with :scope
      expect(scopeCustomCss(":root{--bg:red}", { root }), "E1").toBe("");
      expect(scopeCustomCss('html:has([data-atrium-canvas]) [data-shell="topbar"]{display:none}', { root }), "E2").toBe("");
      expect(scopeCustomCss(":scope{position:fixed;inset:0;z-index:9999}", { root }), "E3").toBe("");
      expect(scopeCustomCss(":scope{margin-top:-700px;outline:200vmax solid red}", { root }), "H1").toBe("");
      // other roots' markers may not be named
      expect(scopeCustomCss('[data-node="other"] .x{color:red}', { root })).toBe("");
      expect(scopeCustomCss('[data-atrium-app-frame="x"] .x{color:red}', { root })).toBe("");
    });
  }
  it("refuses invalid ids", () => {
    for (const id of ['x"]{}', "", "a b", "a".repeat(65)]) {
      const r = scopeCustomCssWithReport(".a{color:red}", { root: { kind: "node", id } });
      expect(r.css).toBe("");
      expect(r.dropped[0]?.reason).toMatch(/invalid root id/);
    }
  });
  it("frame and node CSS cannot name the canvas marker", () => {
    expect(scopeCustomCss("[data-atrium-canvas] .x{color:red}", { root: { kind: "node", id: "n1" } })).toBe("");
  });
});

describe("Fix 6: the connection and publish glow (design v4 Note 1)", () => {
  it("reaches full gold within 120ms, holds to 450ms, is back by 900ms", () => {
    expect(GLOW_PEAK_MS).toBe(120);
    expect(GLOW_HOLD_MS).toBe(450);
    expect(durations.glow.ms).toBe(900);
    expect(glowKeyframes.opacity).toEqual([0, 1, 1, 0]);
    expect(glowKeyframes.times).toEqual([0, 120 / 900, 450 / 900, 1]);
    expect(glowOpacityAt(0)).toBe(0);
    expect(glowOpacityAt(60)).toBeGreaterThan(0.6);
    expect(glowOpacityAt(120)).toBeCloseTo(1, 5);
    for (const t of [150, 250, 350, 450]) expect(glowOpacityAt(t)).toBe(1);
    expect(glowOpacityAt(550)).toBeGreaterThan(0.75);
    expect(glowOpacityAt(675)).toBeLessThan(glowOpacityAt(550));
    expect(glowOpacityAt(850)).toBeLessThan(0.1);
    expect(glowOpacityAt(900)).toBe(0);
  });

  it("the success toast waits 300ms (pushAfter), and can be dismissed before it shows", () => {
    let now = 0;
    const timers: { at: number; fn: () => void; id: number }[] = [];
    let seq = 0;
    const clock = {
      now: () => now,
      setTimeout: (fn: () => void, ms: number) => {
        const id = ++seq;
        timers.push({ at: now + ms, fn, id });
        return id;
      },
      clearTimeout: (h: unknown) => {
        const i = timers.findIndex((t) => t.id === h);
        if (i >= 0) timers.splice(i, 1);
      },
    };
    const advance = (ms: number) => {
      now += ms;
      for (const t of [...timers].sort((a, b) => a.at - b.at)) if (t.at <= now && timers.includes(t)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    };
    const store = createToastStore(clock);
    const id = store.pushAfter({ kind: "success", title: "Connected" }, 300);
    advance(299);
    expect(store.getSnapshot().visible).toHaveLength(0);
    advance(1);
    expect(store.getSnapshot().visible.map((t) => t.id)).toEqual([id]);
    const gone = store.pushAfter({ kind: "success", title: "Never" }, 300);
    store.dismiss(gone);
    advance(400);
    expect(store.getSnapshot().visible.map((t) => t.title)).toEqual(["Connected"]);
  });

  it("the toast stack moves above any title bar it would cover, and accepts window bodies", () => {
    const stack = { width: 360, height: 110, right: 1256 };
    // no title bar near: stays at the 24px edge
    expect(toastOffsetAvoiding(stack, [{ top: 300, bottom: 328, left: 860, right: 1240 }], 800)).toBe(24);
    // a title bar at y 700 under the stack: the stack sits 8px above that bar
    expect(toastOffsetAvoiding(stack, [{ top: 700, bottom: 728, left: 860, right: 1240 }], 800)).toBe(800 - 700 + 8);
    // two rows: it climbs above the second bar it would then cover
    expect(toastOffsetAvoiding(stack, [{ top: 700, bottom: 728, left: 860, right: 1240 }, { top: 560, bottom: 588, left: 860, right: 1240 }], 800)).toBe(800 - 560 + 8);
    // bars to the left of the stack do not matter
    expect(toastOffsetAvoiding(stack, [{ top: 700, bottom: 728, left: 40, right: 400 }], 800)).toBe(24);
  });
});

describe("Fix 2: door glyphs light as the sweep passes", () => {
  it("dim until the band arrives, lit while it passes, then lit only if live", () => {
    expect([doorLit(true, "pending"), doorLit(true, "passing"), doorLit(true, "done")]).toEqual([false, true, true]);
    expect([doorLit(false, "pending"), doorLit(false, "passing"), doorLit(false, "done")]).toEqual([false, true, false]);
    expect(DOOR_PASS_MS).toBeGreaterThan(0);
  });
});

describe("Fix 9: instance name and crumbs", () => {
  it("a bare IP or localhost reads as Atrium; host names are kept", () => {
    for (const h of ["127.0.0.1", "10.77.99.5", "[::1]", "::1", "localhost", "atrium.localhost"]) expect(readableHost(h), h).toBe(DEFAULT_INSTANCE_NAME);
    expect(readableHost("atrium.home")).toBe("atrium.home");
    expect(readableHost("Dash.Example.com")).toBe("dash.example.com");
  });
  it("every segment but the last links back; user names keep their case", () => {
    expect(crumbsFor("/", "Apps", "Atrium", [])).toEqual([{ label: "Atrium", href: "/" }, { label: "apps" }]);
    expect(crumbsFor("/integrations", "Integrations", "Atrium", [])).toEqual([{ label: "Atrium", href: "/" }, { label: "integrations", href: "/integrations" }]);
    expect(crumbsFor("/integrations/abc", "QB r2 Prometheus", "atrium.home", [])).toEqual([
      { label: "atrium.home", href: "/" },
      { label: "integrations", href: "/integrations" },
      { label: "QB r2 Prometheus" },
    ]);
    expect(crumbsFor("/nope", "Not found", "Atrium", [])).toEqual([{ label: "Atrium", href: "/" }, { label: "not found" }]);
    expect(crumbsFor("/build/homelab/versions", "Versions", "Atrium", [])).toEqual([{ label: "Atrium", href: "/" }, { label: "apps", href: "/" }, { label: "homelab", href: "/build/homelab" }, { label: "versions" }]);
    expect(crumbsFor("/build/homelab/settings", null, "Atrium", [])).toEqual([{ label: "Atrium", href: "/" }, { label: "apps", href: "/" }, { label: "homelab", href: "/build/homelab" }, { label: "settings" }]);
  });
});

describe("Fix 11, updated in round 5 (A4.4): Settings is /settings; unbuilt rooms say they are coming", () => {
  it("Settings points at /settings and is active on every settings screen; Users and security is /settings/security", () => {
    expect(SETTINGS.href).toBe("/settings");
    expect(ROUTES_AVAILABLE.settings).toBe(true);
    expect(isActive("/settings", SETTINGS.href)).toBe(true);
    expect(isActive("/settings/users", SETTINGS.href)).toBe(true);
    expect(isActive("/settings/security", SETTINGS.href)).toBe(true);
    expect(isActive("/account", SETTINGS.href)).toBe(false);
    expect(isActive("/settingsx", SETTINGS.href)).toBe(false);
    expect(USERS_AND_SECURITY_HREF).toBe("/settings/security");
    expect(USERS_AND_SECURITY_LABEL).toBe("Users and security");
  });
  it("settings r2 (w2-r1 item 14): the crumbs on /settings/users and /settings/security match the tab", () => {
    expect(crumbsFor("/settings/users", "Users", "Atrium", [])).toEqual([{ label: "Atrium", href: "/" }, { label: "settings", href: "/settings" }, { label: "Users" }]);
    expect(crumbsFor("/settings/security", "Security", "Atrium", [])).toEqual([{ label: "Atrium", href: "/" }, { label: "settings", href: "/settings" }, { label: "Security" }]);
    expect(crumbsFor("/settings", "Settings", "Atrium", [])).toEqual([{ label: "Atrium", href: "/" }, { label: "settings", href: "/settings" }]);
    expect(crumbsFor("/settings/themes", "Themes", "Atrium", [])).toEqual([{ label: "Atrium", href: "/" }, { label: "settings", href: "/settings" }, { label: "Themes" }]);
  });
  it("/settings, /approvals, /library and /audit are coming rooms, anything else is not found", () => {
    expect(comingRouteFor("/settings")?.label).toBe("Settings");
    expect(comingRouteFor("/settings/notifications")?.label).toBe("Settings");
    expect(comingRouteFor("/approvals")?.label).toBe("Approvals");
    // The library shipped in Wave 2: an unknown /library address is a missing room, not a coming one (components w2-r2 Fix 8).
    expect(comingRouteFor("/library")).toBeNull();
    expect(comingRouteFor("/library/nope")).toBeNull();
    expect(comingRouteFor("/audit/2026")?.label).toBe("Audit");
    expect(comingRouteFor("/settingsx")).toBeNull();
    expect(comingRouteFor("/nope")).toBeNull();
  });
  it("the palette lists only live destinations, and finds Credentials by cred and token", () => {
    const items = jumpItems({ ...EMPTY_NAV, user: { email: "o@x" } });
    const hrefs = items.map((i) => i.href);
    expect(hrefs).toEqual(["/", "/integrations", "/library", "/settings", "/settings/security", "/integrations/new", "/integrations/credentials", "/integrations/credentials#new"]);
    for (const off of ["/approvals", "/audit", "/account"]) expect(hrefs).not.toContain(off);
    expect(filterJumpItems(items, "cred").map((i) => i.label)).toEqual(["Credentials", "New credential"]);
    expect(filterJumpItems(items, "token").map((i) => i.label)).toEqual(["Credentials", "New credential"]);
    // Round 5: one name, "Users and security", for the screen the account menu also opens.
    expect(filterJumpItems(items, "2fa").map((i) => i.label)).toEqual(["Users and security"]);
    expect(filterJumpItems(items, "allowlist").map((i) => i.label)).toEqual(["Users and security"]);
    expect(items.filter((i) => i.label === "Users and security")).toHaveLength(1);
  });
});

describe("Fix 4: ScreenHeader", () => {
  it("renders the title as the one h1 at type-title-1, the lead, the action and boxed tabs", () => {
    const html = renderToStaticMarkup(
      createElement(Screen, null,
        createElement(ScreenHeader, {
          title: "Integrations",
          lead: "Services Atrium reads from.",
          action: createElement("a", { href: "/integrations/new" }, "Add integration"),
          tabs: [{ label: "Services", href: "/integrations", active: true }, { label: "Credentials", href: "/integrations/credentials" }],
        }),
      ),
    );
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toMatch(/<h1 class="type-title-1[^"]*"[^>]*data-screen-title[^>]*>Integrations<\/h1>/);
    expect(html).toMatch(/class="mt-3 type-body-lg text-fg-2" data-screen-lead="[^"]*">Services Atrium reads from\./);
    expect(html).toMatch(/data-screen-action="(true|)"/);
    expect(html).toMatch(/aria-current="page"[^>]*>(<span[^>]*>)?Services(<\/span>)?<\/a>/);
    // Settings criterion 46 (Wave 2 e2e regression): each sub-tab is a 44px hit area around the 32px box.
    expect(html).toMatch(/aria-current="page" class="group inline-flex h-11 items-center"[^>]*><span class="inline-flex h-8 [^"]*touch:h-11 bg-fg text-bg" data-screen-tab-box="[^"]*">Services<\/span><\/a>/);
    expect(html).toMatch(/data-screen="(true|)"/);
    expect(html).toContain("screen-x");
  });
  it("omits the lead, action and tabs when not given", () => {
    const html = renderToStaticMarkup(createElement(ScreenHeader, { title: "Credentials" }));
    expect(html).not.toContain("data-screen-lead");
    expect(html).not.toContain("data-screen-action");
    expect(html).not.toContain("data-screen-tabs");
  });
});
