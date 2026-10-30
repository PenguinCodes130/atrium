// Wave 2.10b components (operator try-out spec F6 and F4, criteria 12 and 14): the icon set and its
// picker catalogue, Scale in place of the px size (spec section 9), the inspector's fold titles, hints
// and reasons. The screen tests are tests/e2e/components/q-w210b-friction.spec.ts.
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AppDocument, ComponentNode, RenderContext } from "@/core/contracts";

vi.mock("./actions", () => ({ compileNodeStylesAction: async () => ({}) }));

const { ICON_PATHS } = await import("./render/icons");
const { ICON_CATEGORIES, PICKER_CATEGORIES, PICKER_ICONS, searchIcons } = await import("./render/icon-catalogue");
const { iconSize, iconSizeVars, scaleForPx, SCALE_DEFAULT } = await import("./render/icon-scale");
const { fieldReason } = await import("./inspector/reasons");
const { foldTitle } = await import("./inspector/more");
const { propsSchemas, ICON_NAMES } = await import("./catalogue/schemas");
const { META } = await import("./catalogue/meta");
const { fieldsFor } = await import("./inspector/fields");
const { InspectorPanels } = await import("./inspector/inspector");
const { newNode } = await import("./insert");

function ctx(mode: RenderContext["mode"]): RenderContext {
  return {
    mode, principal: { kind: "user", userId: "u", role: "owner", via: "session" }, appId: "a", pageId: "p_aaaaaaaaaa", version: "draft",
    values: { $data: {}, $sources: {}, $page: { id: "p_aaaaaaaaaa", slug: "home", title: "Home" }, $app: { id: "a", slug: "a", name: "A" }, $user: { kind: "user" } } as never,
    runControl: async () => ({ ok: true }), confirm: async () => true, navigate: () => {},
  };
}
const docu = (n: ComponentNode): AppDocument => ({ format: "atrium-app", formatVersion: 1, app: { name: "G", homePage: "p_aaaaaaaaaa", pageOrder: ["p_aaaaaaaaaa"] }, theme: { themeId: "control-room" }, chrome: { layout: "none" }, dataSources: [], controls: [], pages: [{ id: "p_aaaaaaaaaa", slug: "h", title: "H", inNav: true, root: { id: "c_rootaaaaaa", type: "grid", props: {}, children: [n] } }] });
const panel = (n: ComponentNode) => renderToStaticMarkup(h(InspectorPanels, { node: n, doc: docu(n), onChange: () => {}, ctx: ctx("edit"), onConnectData: () => {} }));
const env = { valueNow: null, bound: false, pages: [{ id: "p_aaaaaaaaaa", slug: "home" }], children: 0 };

describe("F6: the icon set and the picker catalogue", () => {
  it("has at least 200 built-in icons, each a drawable 24px path set", () => {
    const names = Object.keys(ICON_PATHS);
    expect(names.length).toBeGreaterThanOrEqual(200);
    expect(ICON_NAMES).toEqual(names);
    for (const n of names) {
      expect(n, n).toMatch(/^[a-z][a-z0-9-]{0,40}$/);
      const paths = ICON_PATHS[n]!;
      expect(paths.length, n).toBeGreaterThan(0);
      for (const d of paths) {
        expect(d, n).toMatch(/^M/);
        expect(d, n).not.toMatch(/NaN|undefined/);
      }
    }
  });
  it("puts every icon in exactly one category, with no Other left over", () => {
    const seen = new Map<string, string>();
    for (const c of ICON_CATEGORIES) for (const n of c.names) {
      expect(seen.has(n), `${n} is in ${seen.get(n)} and ${c.id}`).toBe(false);
      seen.set(n, c.id);
      expect(n in ICON_PATHS, `${c.id} names ${n}, which is not drawn`).toBe(true);
    }
    expect(PICKER_CATEGORIES.some((c) => c.id === "other")).toBe(false);
    expect(new Set(PICKER_ICONS).size).toBe(Object.keys(ICON_PATHS).length);
    expect(PICKER_CATEGORIES.length).toBeGreaterThanOrEqual(6);
  });
  it("finds icons by name, by meaning and by category; names that start with the text come first", () => {
    expect(searchIcons("server")[0]).toBe("server");
    expect(searchIcons("serv")).toContain("server");
    expect(searchIcons("plex")).toContain("film");
    expect(searchIcons("temperature")).toContain("thermometer");
    expect(searchIcons("cloud up")).toEqual(["cloud-upload"]);
    expect(searchIcons("weather").length).toBeGreaterThan(5);
    expect(searchIcons("plexx")).toEqual([]);
    expect(searchIcons("").length).toBe(PICKER_ICONS.length);
  });
});

describe("F6: Scale replaces the px size (spec section 9)", () => {
  it("reads Scale, then an older fill icon (50%), then a stored px size; nothing set is 50%", () => {
    expect(iconSize({ scale: 80 })).toEqual({ kind: "scale", scale: 80 });
    expect(iconSize({ scale: 10 })).toEqual({ kind: "scale", scale: 25 });
    expect(iconSize({ scale: 400 })).toEqual({ kind: "scale", scale: 100 });
    expect(iconSize({ size: 24, fill: true })).toEqual({ kind: "scale", scale: SCALE_DEFAULT });
    expect(iconSize({ size: 32 })).toEqual({ kind: "px", px: 32 });
    expect(iconSize({ size: 32, scale: 60 })).toEqual({ kind: "scale", scale: 60 });
    expect(iconSize({})).toEqual({ kind: "scale", scale: SCALE_DEFAULT });
  });
  it("a stored px size becomes the Scale that draws the same size in its box", () => {
    expect(scaleForPx(32, 64)).toBe(50);
    expect(scaleForPx(24, 48)).toBe(50);
    expect(scaleForPx(81, 81)).toBe(100);
    expect(scaleForPx(8, 100)).toBe(25);
    expect(iconSizeVars({ kind: "px", px: 32 })["--atr-icon-cell"]).toBe("min(32px, min(100cqw, 100cqh))");
    expect(iconSizeVars({ kind: "scale", scale: 25 })["--atr-icon-cell"]).toBe("calc(min(100cqw, 100cqh) * 0.25)");
  });
  it("the schema takes Scale 25 to 100 and any icon reference; a new icon carries Scale 50, never a px size", () => {
    const s = propsSchemas.icon;
    expect(s.safeParse({ name: "router", scale: 25 }).success).toBe(true);
    expect(s.safeParse({ name: "router", scale: 24 }).success).toBe(false);
    expect(s.safeParse({ name: "router", scale: 101 }).success).toBe(false);
    expect(s.safeParse({ name: "/uploads/abc/logo.png" }).success).toBe(true);
    expect(s.safeParse({ name: "pkg:docker" }).success).toBe(true);
    expect(s.safeParse({ name: "server", size: 32, fill: true }).success, "older icons stay valid").toBe(true);
    const n = newNode("icon");
    expect(n.props.scale).toBe(50);
    expect("size" in n.props).toBe(false);
    expect(META.icon.defaults).not.toHaveProperty("size");
  });
  it("the icon inspector has the visual picker and Scale, and no px size or fill switch", () => {
    const m = panel({ id: "c_iconaaaaaa", type: "icon", props: { name: "router", scale: 70 } });
    expect(m).toContain('data-icon-pick="name"');
    expect(m).toContain('data-field="scale"');
    expect(m).toMatch(/type="range"[^>]*min="25"[^>]*max="100"/);
    expect(m).not.toContain('data-field="size"');
    expect(m).not.toContain('data-field="fill"');
    expect(m).not.toMatch(/In px/i);
    expect(m).not.toContain("<select");
  });
});

describe("F4: fold titles, hints and reasons", () => {
  it("titles a fold with what it holds", () => {
    expect(foldTitle(["Decimal places", "Change", "Warning from"])).toBe("More: decimal places, change, warning from");
    expect(foldTitle(["CPU label"])).toBe("More: CPU label");
    expect(foldTitle([])).toBe("More");
  });
  it("no built-in component's inspector has a fold titled More settings, and every fold names a setting it holds", () => {
    for (const type of Object.keys(META)) {
      const props: Record<string, unknown> = {};
      const m = panel({ id: "c_nodeaaaaaa", type: type as ComponentNode["type"], props: props as ComponentNode["props"], children: [] });
      expect(m, type).not.toContain(">More settings<");
      for (const t of m.matchAll(/data-fold-title="true">([^<]*)</g)) expect(t[1]!.length, `${type}: ${t[1]}`).toBeGreaterThan(6);
    }
  });
  it("every built-in prop has a written hint", () => {
    for (const type of Object.keys(META)) for (const f of fieldsFor(type as never)) expect(f.hint.trim().length, `${type}.${f.key}`).toBeGreaterThan(5);
  });
  it("names why a setting cannot show now, and gives the hint back once it can", () => {
    expect(fieldReason("resource-bar", "clockFormat", { clock: false }, env)).toBe("Needs Show a clock on");
    expect(fieldReason("resource-bar", "clockFormat", { clock: true }, env)).toBeNull();
    expect(fieldReason("resource-bar", "searchUrl", {}, env)).toBe("Needs Show a search box on");
    expect(fieldReason("clock", "seconds", { show: "date" }, env)).toBe("Needs Show set to Time, or Time and date");
    expect(fieldReason("clock", "seconds", { show: "both" }, env)).toBeNull();
    expect(fieldReason("video", "sound", { controls: false }, env)).toBe("Needs Show controls on");
    expect(fieldReason("stat", "warn", { warn: 90 }, { ...env, valueNow: 42 })).toBe("Shows once the value reaches 90 (it is 42 now)");
    expect(fieldReason("stat", "warn", { warn: 10 }, { ...env, valueNow: 42 })).toBeNull();
    expect(fieldReason("stat", "warn", { warn: 10, bad: 20 }, { ...env, valueNow: 42 })).toBe("Problem from wins while the value is past it");
    expect(fieldReason("stat", "showUpdated", { showUpdated: true }, env)).toBe("Needs live data: a typed value has no update time");
    expect(fieldReason("stat", "showUpdated", { showUpdated: true }, { ...env, bound: true })).toBeNull();
    expect(fieldReason("icon", "label", {}, env)).toMatch(/screen readers/);
    expect(fieldReason("service-tile", "newTab", {}, env)).toBe("Needs an Opens address (http or https)");
    expect(fieldReason("service-tile", "href", { href: "nope" }, env)).toMatch(/opens nothing/);
    expect(fieldReason("link", "page", { page: "nowhere" }, env)).toMatch(/No page/);
    expect(fieldReason("link", "page", { page: "home" }, env)).toMatch(/Opens that page/);
    expect(fieldReason("group", "columns", {}, env)).toBe("Needs tiles inside the group");
    expect(fieldReason("stack", "wrap", {}, { ...env, children: 2 })).toBe("Needs Direction set to Side by side");
    expect(fieldReason("table", "maxRows", { maxRows: 10, data: [1, 2, 3] }, { ...env, dataKind: "list" })).toBe("Needs table data in Rows from");
    expect(fieldReason("table", "maxRows", { maxRows: 10 }, { ...env, dataKind: "table" })).toBeNull();
    expect(fieldReason("progress", "value", { value: 37, min: 1, max: 1 }, { ...env, valueNow: 37 })).toMatch(/^Needs Full at above Empty at/);
    expect(fieldReason("progress", "value", { value: 37 }, { ...env, valueNow: 37 })).toBeNull();
    expect(fieldReason("divider", "spacing", {}, { ...env, parentType: "grid" })).toMatch(/In a grid/);
    expect(fieldReason("gauge", "max", { max: 10 }, env)).toBeNull();
  });
});
