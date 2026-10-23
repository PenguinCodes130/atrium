// settings round 1: theme revalidation, resolution, canvas CSS, saved themes, sharing, drafts, tools.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { controlRoom, dusk, themeCanvasCss } from "@/features/shell";
import type { Theme } from "@/core/contracts";
import { AGENT, MEMBER, OWNER, VIEWER, doc, fakePort, freshDataDir, useInstance } from "./harness";
import { EVIL, hostileTheme } from "./fixtures";

async function boot() {
  vi.resetModules();
  useInstance(freshDataDir());
  const store = await import("@/features/themes/store");
  const resolve = await import("@/features/themes/resolve");
  const share = await import("@/features/themes/share");
  const drafts = await import("@/features/themes/drafts");
  const port = await import("@/features/settings/app-port");
  const tools = await import("@/features/settings/tools");
  const hooks = await import("@/core/hooks");
  const { db } = await import("@/core/db");
  const schema = await import("@/db/schema/themes");
  const audit = await import("@/db/schema/audit");
  return { store, resolve, share, drafts, port, tools, hooks, db, schema, audit };
}

describe("revalidateTheme (spec 3.5, AC 24, 25)", () => {
  it("keeps a valid built-in unchanged and counts nothing", async () => {
    const { revalidateTheme } = await import("@/features/themes/revalidate");
    for (const t of [controlRoom, dusk]) {
      const r = revalidateTheme(t);
      expect(r.replaced).toBe(0);
      expect(r.theme).toEqual(t);
    }
  });
  it("replaces every hostile value with Control Room's and clamps numbers", async () => {
    const { revalidateTheme } = await import("@/features/themes/revalidate");
    const r = revalidateTheme(hostileTheme());
    const t = r.theme;
    expect(r.replaced).toBeGreaterThan(40);
    expect(t.id).toBe("control-room");
    expect(t.mode).toBe("light");
    expect(t.tokens.color).toEqual(controlRoom.tokens.color);
    expect(t.tokens.chrome).toEqual(controlRoom.tokens.chrome);
    expect(t.tokens.shape).toEqual({ radiusPx: 32, controlRadiusPx: 999 });
    expect(t.tokens.space.gapPx).toBe(4);
    expect(t.tokens.space.padPx).toBe(40);
    expect(t.tokens.type.scale).toBe(1.3);
    expect(t.tokens.type.headingWeight).toBe(800);
    expect(t.tokens.surface.opacity).toBe(1);
    expect(t.tokens.wallpaper.dim).toBe(0.6);
    expect(t.tokens.wallpaper.grain).toBe(0);
    expect(t.tokens.type.body).toBe(controlRoom.tokens.type.body);
    expect(t.fonts).toBeUndefined();
    expect(t.dark?.color).toEqual(controlRoom.dark!.color);
    // Every string token value is now a checked colour, family or keyword.
    const strings: string[] = [];
    const walk = (v: unknown) => (typeof v === "string" ? strings.push(v) : v && typeof v === "object" ? Object.values(v).forEach(walk) : 0);
    walk({ ...t, customCss: undefined, name: undefined, author: undefined });
    for (const v of strings) for (const bad of ["}", ";", "<", ":root{", "{"]) expect(v.includes(bad), `${bad} in ${v}`).toBe(false);
  });
  it("counts N exactly for a theme with three bad values", async () => {
    const { revalidateTheme } = await import("@/features/themes/revalidate");
    const raw = JSON.parse(JSON.stringify(controlRoom)) as { tokens: { color: { accent: string }; shape: { radiusPx: number }; type: { display: string } } };
    raw.tokens.color.accent = "url(x)";
    raw.tokens.shape.radiusPx = 50;
    raw.tokens.type.display = "Comic Sans";
    expect(revalidateTheme(raw).replaced).toBe(3);
  });
});

describe("canvas CSS (AC 24, 28; carried M2)", () => {
  it("one rule per canvas selector, no :root/html/body/shell selectors, clamped values", async () => {
    const { canvasStylesheet, canvasThemeCssWithReport, blockThemeValues } = await import("@/features/themes/resolve");
    const css = canvasStylesheet(hostileTheme() as unknown as Theme, "k1");
    const sel = '[data-atrium-canvas][data-canvas-key="k1"]';
    expect(css.split(`${sel}{`).length - 1).toBe(1);
    expect(css).not.toMatch(/:root\s*\{|(^|[\s,}])html\s*\{|(^|[\s,}])body\s*\{/);
    // Shell names may appear only as descendants of the canvas root, which they never are.
    for (const line of css.split(/[{}]/)) if (/data-top-bar|data-app-switcher|data-toaster|data-draft-preview-bar|dialog/.test(line)) for (const sel of line.split(",")) expect(sel.trim().startsWith("[data-atrium-canvas]"), sel).toBe(true);
    expect(css).not.toContain("@import");
    expect(css).not.toContain("evil.example");
    expect(css).not.toMatch(/position:\s*fixed/);
    expect(css).not.toContain("<");
    expect(css).toContain("--theme-radius:32px");
    expect(css).toContain(`--theme-accent:${controlRoom.tokens.color.accent}`);
    // The scoped custom CSS keeps only canvas-scoped rules.
    const scoped = canvasThemeCssWithReport(hostileTheme() as unknown as Theme);
    expect(scoped.css).toContain("[data-atrium-canvas] .card");
    expect(scoped.dropped.length).toBeGreaterThan(4);
    // Values sent to an HTML block hold no unchecked string.
    const block = blockThemeValues(hostileTheme() as unknown as Theme);
    for (const v of Object.values(block)) for (const bad of ["}", ";", "<", "{"]) expect(v.includes(bad), `${v}`).toBe(false);
    expect(JSON.stringify(block)).not.toContain(EVIL);
  });
  it("matches app-shell's token rule for a valid theme", async () => {
    const { canvasStylesheet } = await import("@/features/themes/resolve");
    expect(canvasStylesheet(dusk, "k2").startsWith(themeCanvasCss(dusk, "k2"))).toBe(true);
  });
  it("auto mode writes the dark set under the dark preference (AC 23)", async () => {
    const { canvasStylesheet } = await import("@/features/themes/resolve");
    const auto = { ...controlRoom, id: "auto-test", mode: "auto" as const };
    const css = canvasStylesheet(auto, "k3");
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain(`--theme-surface:${controlRoom.dark!.color!.surface}`);
  });
});

describe("saved themes, resolution and usage", () => {
  let m: Awaited<ReturnType<typeof boot>>;
  beforeEach(async () => {
    m = await boot();
  });

  it("resolves page over app, inline copies, and a missing theme to Control Room with the notice (AC 20, 21, 22)", async () => {
    const saved = m.store.createTheme(OWNER, { ...dusk, name: "Rack" });
    const d = doc({ themeId: "solid" }, [{ id: "p_a" }, { id: "p_b", theme: { themeId: saved.id } }]);
    expect((await m.resolve.resolveTheme(d, "p_a")).theme.id).toBe("solid");
    expect((await m.resolve.resolveTheme(d, "p_b")).theme.name).toBe("Rack");
    const snap = await m.resolve.snapshotTheme({ themeId: saved.id });
    await m.store.deleteTheme(OWNER, saved.id);
    expect(await m.resolve.resolveTheme(d, "p_b")).toEqual({ theme: controlRoom, notice: "Theme missing, showing Control Room" });
    const published = doc({ inline: snap });
    expect((await m.resolve.resolveTheme(published)).theme.name).toBe("Rack");
  });

  it("a new app's default theme is Control Room (AC 12)", async () => {
    const { DEFAULT_THEME_ID } = await import("@/features/themes/revalidate");
    expect(DEFAULT_THEME_ID).toBe("control-room");
    expect((await m.resolve.resolveTheme(doc({ themeId: DEFAULT_THEME_ID }))).theme).toEqual(controlRoom);
  });

  it("refuses out-of-range values naming the range (AC 15)", async () => {
    const bad = JSON.parse(JSON.stringify(controlRoom));
    bad.tokens.shape.radiusPx = 40;
    bad.tokens.surface.opacity = 0.2;
    bad.tokens.type.scale = 2;
    let err: { code?: string; issues: { message: string }[] } | undefined;
    try { m.store.createTheme(OWNER, bad); } catch (e) { err = e as typeof err; }
    expect(err?.code).toBe("invalid_theme");
    const msgs = err!.issues.map((i: { message: string }) => i.message).join(" | ");
    expect(msgs).toContain("Radius (px) must be between 0 and 32");
    expect(msgs).toContain("Surface opacity must be between 0.3 and 1");
    expect(msgs).toContain("Type scale must be between 0.85 and 1.3");
  });

  it("viewers cannot edit; built-ins cannot be edited or deleted; ids never collide with built-ins", async () => {
    expect(() => m.store.createTheme(VIEWER, controlRoom)).toThrow(/owners and members/);
    expect(() => m.store.updateTheme(OWNER, "dusk", dusk, 1)).toThrow(/Built-in/);
    await expect(m.store.deleteTheme(OWNER, "control-room")).rejects.toThrow(/Built-in/);
    const t = m.store.createTheme(MEMBER, { ...controlRoom, id: "control-room" });
    expect(t.id).toMatch(/^t-[a-z2-7]{10}$/);
  });

  it("stale saves are refused and nothing is overwritten (state Stale)", async () => {
    const t = m.store.createTheme(OWNER, { ...controlRoom, name: "Mine" });
    m.store.updateTheme(OWNER, t.id, { ...t.theme, name: "Mine 2" }, 1);
    expect(() => m.store.updateTheme(MEMBER, t.id, { ...t.theme, name: "Mine 3" }, 1)).toThrow("This theme changed since you opened it");
    expect(m.store.getSavedTheme(t.id)!.name).toBe("Mine 2");
  });

  it("audits save, import and delete as settings.updated with target type theme (A4.4)", async () => {
    const t = m.store.createTheme(OWNER, { ...controlRoom, name: "Audited" });
    await m.store.deleteTheme(OWNER, t.id);
    const rows = m.db().select().from(m.audit.auditLog).all().filter((r) => r.targetType === "theme");
    expect(rows.map((r) => (r.detail as { action: string }).action)).toEqual(["created", "deleted"]);
    expect(rows.every((r) => r.event === "settings.updated")).toBe(true);
  });

  it("a value written straight into storage is replaced on read and counted (AC 25)", async () => {
    const t = m.store.createTheme(OWNER, { ...controlRoom, name: "Raw" });
    const raw = JSON.parse(JSON.stringify(t.theme));
    raw.tokens.color.accent = EVIL;
    raw.tokens.shape.radiusPx = 400;
    m.db().update(m.schema.themes).set({ theme: raw }).run();
    const back = m.store.getSavedTheme(t.id)!;
    expect(back.invalid).toBe(2);
    expect(back.theme.tokens.color.accent).toBe(controlRoom.tokens.color.accent);
    expect(back.theme.tokens.shape.radiusPx).toBe(32);
  });

  it("delete is refused while app drafts reference the theme, naming both apps (AC 19)", async () => {
    const t = m.store.createTheme(OWNER, { ...controlRoom, name: "Shared" });
    const fp = fakePort([
      { appId: "a1", name: "Homelab", draft: doc({ themeId: t.id }) },
      { appId: "a2", name: "Family wall", draft: doc({ themeId: "solid" }, [{ id: "p_x", theme: { themeId: t.id } }]) },
    ]);
    m.port.registerAppPort(fp.port);
    await expect(m.store.deleteTheme(OWNER, t.id)).rejects.toThrow(/Homelab, Family wall/);
    fp.state[0]!.draft = doc({ themeId: "dusk" });
    fp.state[1]!.draft = doc({ themeId: "dusk" });
    await m.store.deleteTheme(OWNER, t.id);
    expect(m.store.getSavedTheme(t.id)).toBeNull();
  });

  it("'Update apps using this theme' points drafts at the saved theme and never touches the published doc (AC 18)", async () => {
    const t = m.store.createTheme(OWNER, { ...controlRoom, name: "Lit" });
    const snap = await m.resolve.snapshotTheme({ themeId: t.id });
    const pub = doc({ inline: snap });
    const fp = fakePort([{ appId: "a1", name: "Homelab", draft: doc({ themeId: "dusk" }), published: pub }, { appId: "a2", name: "Other", draft: doc({ themeId: "dusk" }), published: doc({ themeId: "solid" }) }]);
    m.port.registerAppPort(fp.port);
    const uses = await m.store.themeUsage(t.id);
    expect(uses).toEqual([{ appId: "a1", slug: "a1", name: "Homelab", draft: false, published: true }]);
    const before = JSON.stringify(fp.state[0]!.published);
    const r = await m.store.updateAppsUsingTheme(OWNER, t.id);
    expect(r.updated.map((u) => u.name)).toEqual(["Homelab"]);
    expect(fp.state[0]!.draft.theme).toEqual({ themeId: t.id });
    expect(JSON.stringify(fp.state[0]!.published)).toBe(before);
  });

  it("saving a theme changes what drafts resolve to and leaves a published snapshot identical (AC 17)", async () => {
    const t = m.store.createTheme(OWNER, { ...controlRoom, name: "Live" });
    const pub = doc({ inline: await m.resolve.snapshotTheme({ themeId: t.id }) });
    const draft = doc({ themeId: t.id });
    const pubCssBefore = m.resolve.canvasStylesheet((await m.resolve.resolveTheme(pub)).theme, "k");
    m.store.updateTheme(OWNER, t.id, { ...t.theme, tokens: { ...t.theme.tokens, color: { ...t.theme.tokens.color, accent: "#2F6FB0" } } }, 1);
    expect((await m.resolve.resolveTheme(draft)).theme.tokens.color.accent).toBe("#2F6FB0");
    expect(m.resolve.canvasStylesheet((await m.resolve.resolveTheme(pub)).theme, "k")).toBe(pubCssBefore);
  });
});

describe("theme files (AC 26, 27, 29)", () => {
  let m: Awaited<ReturnType<typeof boot>>;
  beforeEach(async () => {
    m = await boot();
  });

  it("export then import twice gives a new id and '<name>' then '<name> (2)', same values", async () => {
    const { bytes, fileName } = m.share.exportTheme("dusk");
    expect(fileName).toBe("dusk.atrium-theme");
    const a = m.share.importTheme(OWNER, bytes);
    const b = m.share.importTheme(OWNER, bytes);
    expect(a.name).toBe("Dusk (2)");
    expect(b.name).toBe("Dusk (3)");
    const t = m.store.createTheme(OWNER, { ...controlRoom, name: "Paper" });
    const f = m.share.exportTheme(t.id).bytes;
    const c = m.share.importTheme(MEMBER, f);
    expect(c.name).toBe("Paper (2)");
    expect(c.id).not.toBe(t.id);
    expect(c.theme.tokens).toEqual(t.theme.tokens);
    expect(m.resolve.canvasStylesheet({ ...c.theme, id: "x", name: "x" }, "k")).toBe(m.resolve.canvasStylesheet({ ...t.theme, id: "x", name: "x" }, "k"));
  });

  it("imports a v3 file with surface tint as the surface colour and new fields from Control Room", async () => {
    const v3 = {
      atriumTheme: "1", id: "old", name: "Old glass", author: "Me", version: "1",
      tokens: { wallpaper: { kind: "color", value: "#202020", blurPx: 0, dim: 0 }, surface: { material: "glass", tint: "#334455", opacity: 0.8, blurPx: 20, border: true }, text: { primary: "#111111", muted: "#333333" }, accent: "#E9B949", font: { ui: "Inter", numbers: "tabular" }, radiusPx: 12, gapPx: 16, density: "comfortable", shadow: 1, lightDrift: false },
    };
    const t = m.share.importTheme(OWNER, Buffer.from(JSON.stringify(v3)));
    expect(t.theme.tokens.color.surface).toBe("#334455");
    expect(t.theme.tokens.chrome).toEqual(controlRoom.tokens.chrome);
    expect(t.theme.tokens.motion.enter).toBe(controlRoom.tokens.motion.enter);
    expect(t.theme.tokens.type.mono).toBe(controlRoom.tokens.type.mono);
  });

  it("refuses an HTML file, a scripted SVG and damaged JSON, and saves nothing", async () => {
    const { writeZip } = await import("@/features/settings/zip");
    const tj = Buffer.from(JSON.stringify(dusk));
    const before = m.store.listSavedThemes().length;
    const html = writeZip([{ name: "theme.json", data: tj }, { name: "assets/page.png", data: Buffer.from("<!doctype html><html><body>x</body></html>") }]);
    expect(() => m.share.importTheme(OWNER, html)).toThrow(/page\.png.*This file type is not allowed/);
    const svg = writeZip([{ name: "theme.json", data: tj }, { name: "assets/a.svg", data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') }]);
    expect(() => m.share.importTheme(OWNER, svg)).toThrow(/a\.svg.*scripts/);
    const broken = writeZip([{ name: "theme.json", data: Buffer.from("{ not json") }]);
    expect(() => m.share.importTheme(OWNER, broken)).toThrow(/not valid JSON/);
    expect(() => m.share.importTheme(OWNER, Buffer.from("PK\u0003\u0004garbage"))).toThrow(/damaged/);
    expect(() => m.share.importTheme(OWNER, Buffer.from('{"hello":1}'))).toThrow(/not a theme file/);
    expect(m.store.listSavedThemes().length).toBe(before);
  });
});

describe("theme drafts and tools (AC 30, 31)", () => {
  let m: Awaited<ReturnType<typeof boot>>;
  beforeEach(async () => {
    m = await boot();
  });

  it("themes.create makes a draft naming the agent; only a signed-in person publishes; both audited", async () => {
    const tool = m.tools.settingsTools.find((t) => t.name === "themes.create")!;
    const out = await tool.handler({ principal: AGENT, signal: new AbortController().signal }, { theme: { ...controlRoom, name: "Agent theme" } });
    expect(out.draftId).toBeTruthy();
    expect(m.store.listSavedThemes()).toHaveLength(0);
    const drafts = m.drafts.listThemeDrafts();
    expect(drafts[0]!.proposedBy).toBe("Claude");
    expect(() => m.drafts.publishThemeDraft(AGENT, out.draftId)).toThrow(/signed-in person/);
    const saved = m.drafts.publishThemeDraft(MEMBER, out.draftId);
    expect(saved.name).toBe("Agent theme");
    const out2 = await tool.handler({ principal: AGENT, signal: new AbortController().signal }, { theme: { ...dusk, name: "Nope" } });
    m.drafts.discardThemeDraft(OWNER, out2.draftId);
    const events = m.db().select().from(m.audit.auditLog).all().map((r) => r.event);
    expect(events).toEqual(expect.arrayContaining(["draft.created", "draft.published", "draft.discarded"]));
    const names = m.tools.settingsTools.map((t) => t.name);
    expect(names).toEqual(["themes.list", "themes.get", "themes.create", "themes.update", "themes.apply"]);
    expect(names.some((n) => /delete|publish/.test(n))).toBe(false);
  });

  it("themes.apply sets the app or page theme through applyOps and returns conflict on a stale rev", async () => {
    const fp = fakePort([{ appId: "a1", name: "Homelab", draft: doc({ themeId: "control-room" }, [{ id: "p_a" }, { id: "p_b" }]) }]);
    m.port.registerAppPort(fp.port);
    m.hooks.registerAppAccess({ canEditApp: async () => true } as never);
    const apply = m.tools.settingsTools.find((t) => t.name === "themes.apply")!;
    const ctx = { principal: AGENT, signal: new AbortController().signal };
    expect(await apply.handler(ctx, { appId: "a1", themeId: "dusk" })).toEqual({ rev: 2, changed: ["theme"] });
    expect(await apply.handler(ctx, { appId: "a1", pageId: "p_b", themeId: "solid", expectRev: 2 })).toEqual({ rev: 3, changed: ["pages.p_b.theme"] });
    expect(fp.state[0]!.draft.theme).toEqual({ themeId: "dusk" });
    expect(fp.state[0]!.draft.pages[1]!.theme).toEqual({ themeId: "solid" });
    await expect(apply.handler(ctx, { appId: "a1", themeId: "solid", expectRev: 1 })).rejects.toMatchObject({ code: "conflict", rev: 3 });
    expect(fp.calls).toHaveLength(2);
  });
});
