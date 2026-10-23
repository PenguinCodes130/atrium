// Round 3 (design v4) unit tests: app switcher visibility and rows by viewer kind and edit right
// (with doubles for the Wave 1 hooks), the Approvals badge hook, sky band mode, reduce transparency
// and reduced motion mapping, button press values, the clock text.
import { afterEach, describe, expect, it } from "vitest";
import type { App, AppAccessResolver, Principal } from "@/core/contracts";
import { registerAppAccess, registerApprovalsCount, resetAppAccess } from "@/core/hooks";
import { switcherItems, switcherVisible } from "./app-switcher";
import { pendingApprovals, switcherData } from "./switcher-data";
import { skyMode } from "./sky-band";
import { effectiveReduceTransparency, effectiveReducedMotion } from "./preferences";
import { PRESS_OFFSET_PX, buttonClass } from "./button";
import { clockText } from "./top-bar";
import { showsSkyBand, showsTopBar } from "./shell-frame";
import { ROOM_COPY } from "./empty-room";
import { SWITCH_TRACK } from "./switch";
import { KIND_LABEL } from "./toast";

const user: Principal = { kind: "user", userId: "u1", role: "owner", via: "session" };
const member: Principal = { kind: "user", userId: "u2", role: "member", via: "session" };
const guest: Principal = { kind: "guest", guestLinkId: "g1", appId: "a1", label: "Sam", via: "guest-link" };
const agent: Principal = { kind: "agent", userId: "u1", role: "owner", via: "pat", tokenId: "t1", agentName: "claude", scopes: [] };

function app(id: string, slug: string, name: string): App {
  return { id, slug, name, access: { view: { kind: "all" } as never, edit: { kind: "owner" } as never, guests: false }, draftRev: 1, createdBy: "u1", createdAt: "", updatedAt: "" };
}
const APPS = [app("a1", "homelab", "Homelab"), app("a2", "family", "Family"), app("a3", "guest-room", "Guest room")];
const resolver = (editors: string[]): AppAccessResolver =>
  ({
    appBySlug: async (slug: string) => APPS.find((a) => a.slug === slug) ?? null,
    appById: async (id: string) => APPS.find((a) => a.id === id) ?? null,
    appsFor: async (p: Principal) => (p.kind === "guest" ? [] : APPS),
    guestValues: async () => ({}),
    canOpenApp: async () => true,
    canEditApp: async (p: Principal) => p.kind !== "guest" && editors.includes(p.userId),
    publishedControl: async () => null,
  }) as AppAccessResolver;

afterEach(() => {
  resetAppAccess();
  (globalThis as { __atriumApprovalsCount?: unknown }).__atriumApprovalsCount = undefined;
});

describe("app switcher visibility (criteria 44, 45)", () => {
  it("is drawn only for signed-in users, never for guests or signed-out viewers", () => {
    expect(switcherVisible("user")).toBe(true);
    expect(switcherVisible("guest")).toBe(false);
    expect(switcherVisible("none")).toBe(false);
  });
  it("lists the other apps, Edit this app for editors only, then Back to Atrium", () => {
    const rows = switcherItems({ currentSlug: "homelab", apps: [{ slug: "homelab", name: "Homelab" }, { slug: "family", name: "Family" }], canEdit: true });
    expect(rows.map((r) => [r.label, r.href])).toEqual([
      ["Family", "/a/family"],
      ["Edit this app", "/build/homelab"],
      ["Back to Atrium", "/"],
    ]);
    expect(switcherItems({ currentSlug: "homelab", apps: [], canEdit: false }).map((r) => r.label)).toEqual(["Back to Atrium"]);
  });
  it("with the hook unregistered (Wave 1) shows only Back to Atrium for a user, nothing for a guest or agent", async () => {
    expect(await switcherData(user, "homelab")).toEqual({ show: true, current: null, apps: [], canEdit: false });
    expect(await switcherData(guest, "homelab")).toEqual({ show: false });
    expect(await switcherData(agent, "homelab")).toEqual({ show: false });
    expect(await switcherData(null, "homelab")).toEqual({ show: false });
  });
  it("with a registered hook (double): other apps for everyone, Edit this app only for editors", async () => {
    registerAppAccess(resolver(["u1"]));
    const owner = await switcherData(user, "homelab");
    expect(owner).toMatchObject({ show: true, canEdit: true, current: { slug: "homelab", name: "Homelab" } });
    if (owner.show) expect(owner.apps.map((a) => a.slug)).toEqual(["family", "guest-room"]);
    const viewer = await switcherData(member, "homelab");
    expect(viewer).toMatchObject({ show: true, canEdit: false });
    if (viewer.show) expect(switcherItems({ currentSlug: "homelab", apps: viewer.apps, canEdit: viewer.canEdit }).some((r) => r.kind === "edit")).toBe(false);
    expect(await switcherData(guest, "homelab")).toEqual({ show: false });
  });
  it("a failing hook degrades to Back to Atrium only", async () => {
    registerAppAccess({ ...resolver([]), appsFor: async () => Promise.reject(new Error("db down")) } as AppAccessResolver);
    const d = await switcherData(user, "homelab");
    expect(d).toMatchObject({ show: true, apps: [] });
  });
});

describe("Approvals badge hook (criterion 13, A1.2)", () => {
  it("is 0 (badge hidden) while unregistered", async () => {
    expect(await pendingApprovals(user)).toBe(0);
  });
  it("shows the registered count, never for guests, and survives a failing hook", async () => {
    registerApprovalsCount(async () => 3);
    expect(await pendingApprovals(user)).toBe(3);
    expect(await pendingApprovals(guest)).toBe(0);
    expect(await pendingApprovals(null)).toBe(0);
    registerApprovalsCount(async () => Promise.reject(new Error("x")));
    expect(await pendingApprovals(user)).toBe(0);
    registerApprovalsCount(async () => -2);
    expect(await pendingApprovals(user)).toBe(0);
  });
});

describe("sky band mode (criteria 10, 18)", () => {
  it("drifts with the shader only with acceleration, no reduced motion and no reduce transparency", () => {
    expect(skyMode({ accelerated: true, reducedMotion: false, reduceTransparency: false })).toBe("shader");
    expect(skyMode({ accelerated: false, reducedMotion: false, reduceTransparency: false })).toBe("static");
    expect(skyMode({ accelerated: true, reducedMotion: true, reduceTransparency: false })).toBe("static");
    expect(skyMode({ accelerated: true, reducedMotion: false, reduceTransparency: true })).toBe("static");
    expect(skyMode({ accelerated: false, reducedMotion: false, reduceTransparency: false, force: "shader" })).toBe("shader");
  });
  it("never shows in the builder", () => {
    expect(showsSkyBand("/")).toBe(true);
    expect(showsSkyBand("/integrations")).toBe(true);
    expect(showsSkyBand("/build/homelab")).toBe(false);
    expect(showsSkyBand("/build")).toBe(false);
    expect(showsSkyBand("/build/homelab/kitchen")).toBe(false);
    for (const p of ["/build/homelab/versions", "/build/homelab/settings", "/build/homelab/versions/"]) expect(showsSkyBand(p), p).toBe(true);
    // Wave 2 lead (app-builder SFR 5): the builder bar replaces the top bar on the builder only.
    for (const p of ["/build/homelab", "/build/homelab/", "/build/homelab/kitchen"]) expect(showsTopBar(p), p).toBe(false);
    for (const p of ["/", "/build", "/build/homelab/versions", "/build/homelab/settings", "/integrations", "/library", "/build/a/b/c"]) expect(showsTopBar(p), p).toBe(true);
  });
});

describe("reduced motion and reduce transparency mapping (criteria 10, 31)", () => {
  it("system setting OR in-app switch; no blur support also turns glass opaque", () => {
    expect(effectiveReducedMotion(false, true)).toBe(true);
    expect(effectiveReducedMotion(true, false)).toBe(true);
    expect(effectiveReducedMotion(false, false)).toBe(false);
    expect(effectiveReduceTransparency(false, false, false)).toBe(true);
    expect(effectiveReduceTransparency(false, true, true)).toBe(true);
    expect(effectiveReduceTransparency(true, false, true)).toBe(true);
    expect(effectiveReduceTransparency(false, false, true)).toBe(false);
  });
});

describe("buttons, switch, toasts, rooms (criteria 19 to 23, 33, 34)", () => {
  it("press moves 4px into the 2px pressed shadow; primary rests on the 3px shadow", () => {
    expect(PRESS_OFFSET_PX).toBe(4);
    expect(buttonClass("primary")).toContain("shadow-window-sm");
    expect(buttonClass("primary", undefined, false, true)).toContain("shadow-pressed");
    expect(buttonClass("primary", undefined, false, true)).not.toContain("shadow-window-sm");
    expect(buttonClass("quiet", undefined, false, true)).not.toContain("shadow-pressed");
    for (const v of ["primary", "secondary", "ink", "quiet", "destructive", "destructive-confirm"] as const) {
      expect(buttonClass(v)).toContain("h-9");
      expect(buttonClass(v)).toContain("touch:h-11");
      expect(buttonClass(v)).toContain("rounded-none");
    }
  });
  it("the switch track is 44 x 24", () => {
    expect(SWITCH_TRACK).toMatchObject({ width: 44, height: 24 });
  });
  it("toast title bars name the kind", () => {
    expect(KIND_LABEL.success).toBe("success");
    expect(KIND_LABEL["secrets-locked"]).toBe("secrets locked");
  });
  it("empty rooms use the exact lines", () => {
    expect(ROOM_COPY.launcher).toEqual({ title: "Build your first app.", body: "Start from a template, or ask an agent to build one.", primary: "New app", secondary: "Start from a template" });
    expect(ROOM_COPY.page).toEqual({ title: "This room is waiting for light.", body: "Add a component to bring live data onto this page.", primary: "Add a component", secondary: "Start from a template" });
    expect(ROOM_COPY.missing.title).toBe("This room does not exist.");
    expect(ROOM_COPY.missing.primary).toBe("Go to Apps");
  });
  it("the clock reads HH:MM", () => {
    expect(clockText(new Date(2026, 9, 18, 9, 5))).toBe("09:05");
    expect(clockText(new Date(2026, 9, 18, 21, 40))).toBe("21:40");
  });
});
