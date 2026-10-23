// Gauntlet w2-r1 Fix List, round 2 (app-builder): templates with skipped integrations (item 2), the app
// file shipping its library components (item 3), the review listing only real changes (item 8) and CSS
// removal warnings (item 9). Real temp SQLite; components and settings are the local fake, except the
// library store, which is real here so the app file can export and import components.
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { App, ComponentNode, Principal } from "@/core/contracts";
import { owner, seedIntegration, seedUsers, setupAppsDb } from "./harness";

vi.mock("@/features/apps/deps", async () => {
  const lib = await import("@/features/library/server");
  return { ...(await import("./harness")).fakeDeps, libraryForDoc: lib.libraryForDoc, getLibrary: lib.getLibrary, importLibrary: lib.importLibrary, toComponentFile: lib.toComponentFile, parseComponentFile: lib.parseComponentFile, CONTAINS_CODE_NOTICE: lib.CONTAINS_CODE_NOTICE };
});

setupAppsDb();

let svc: typeof import("../service");
let versions: typeof import("@/features/versions/service");
let repo: typeof import("../repo");
let appfile: typeof import("../appfile");
let checks: typeof import("../checks");
let resolver: typeof import("../resolver");
let load: typeof import("../load");
let library: typeof import("@/features/library/server");
let db: typeof import("@/core/db");
let zip: typeof import("../zip");

beforeAll(async () => {
  await seedUsers();
  await seedIntegration(owner);
  db = await import("@/core/db");
  svc = await import("../service");
  versions = await import("@/features/versions/service");
  repo = await import("../repo");
  appfile = await import("../appfile");
  checks = await import("../checks");
  resolver = await import("../resolver");
  load = await import("../load");
  library = await import("@/features/library/server");
  zip = await import("../zip");
});

const node = (type: ComponentNode["type"], props: ComponentNode["props"], id: string): ComponentNode => ({ id, type, props, slot: { x: 0, y: 0, w: 3, h: 8 } });

describe("item 2: a template with skipped integrations shows No data and can publish", () => {
  it("keeps each skipped source as an unmapped placeholder with one warning that points at its component, and publishes", async () => {
    const { app } = svc.createApp(owner, { name: "Homelab", slug: "r2-homelab", template: "homelab", mappings: { docker: null, proxmox: null } });
    const doc = repo.getDraft(app.id)!.doc;
    expect(doc.dataSources.map((s) => `${s.name}:${s.integrationId}`).sort()).toEqual(["containers:$unmapped:docker", "nodes:$unmapped:proxmox", "running:$unmapped:docker"]);
    const review = versions.reviewDraft(owner, app.id);
    const unmapped = review.problems.filter((p) => p.code === "source.unmapped");
    expect(unmapped).toHaveLength(3);
    expect(unmapped.every((p) => p.severity === "warning" && !!p.where.nodeId)).toBe(true);
    expect(unmapped.map((p) => p.message).sort()).toEqual([
      'containers shows "No data" until you connect Docker.',
      'nodes shows "No data" until you connect Proxmox VE.',
      'running shows "No data" until you connect Docker.',
    ]);
    expect(review.problems.filter((p) => p.severity === "error")).toEqual([]);
    expect(review.canPublish).toBe(true);
    const { version } = await versions.publishDraft(owner, app.id, { expectRev: review.rev });
    expect(version).toBe(1);
  });

  it("never streams an unmapped source, and the page render lists it with its No data message and where to connect it", async () => {
    const { app } = svc.createApp(owner, { name: "Homelab", slug: "r2-homelab-2", template: "homelab", mappings: {} });
    const d = repo.getDraft(app.id)!.doc;
    const page = d.pages[0]!;
    expect(await resolver.pageSources.page(app.id, page.id, owner, true)).toEqual([]);
    const r = await load.renderPage(repo.getApp(app.id)!, d, page, "editor", { connectLinks: true });
    expect(r.sources).toEqual([]);
    expect(r.unmapped.map((u) => `${u.key}|${u.message}|${u.href}`).sort()).toEqual([
      "containers|No data: connect Docker|/integrations/new/docker",
      "nodes|No data: connect Proxmox VE|/integrations/new/proxmox",
      "running|No data: connect Docker|/integrations/new/docker",
    ]);
  });

  it("the Family wall opens as a composed page filling the 12 columns", () => {
    const { app } = svc.createApp(owner, { name: "Wall", slug: "r2-wall", template: "family-wall" });
    const root = repo.getDraft(app.id)!.doc.pages[0]!.root;
    const kids = root.children ?? [];
    expect(kids.length).toBeGreaterThanOrEqual(5);
    const rows = new Map<number, number>();
    for (const k of kids) rows.set(k.slot!.y, (rows.get(k.slot!.y) ?? 0) + k.slot!.w);
    expect([...rows.values()].every((w) => w === 12)).toBe(true); // every row spans the canvas
  });

  it("the Guest room template's controls are at least 56px tall (item 13)", () => {
    const { app } = svc.createApp(owner, { name: "Guests", slug: "r2-guests", template: "guest-room" });
    const kids = repo.getDraft(app.id)!.doc.pages[0]!.root.children ?? [];
    const controls = kids.filter((k) => k.type === "toggle" || k.type === "button");
    expect(controls).toHaveLength(2);
    for (const c of controls) {
      expect(c.style?.root?.minHeight).toBe(56);
      expect(c.slot!.h * 8).toBeGreaterThanOrEqual(56 + 8); // the cell holds the 56px control and its gap
    }
  });
});

describe("item 3: the app file ships its library components", () => {
  async function appWithInstance(slug: string): Promise<{ app: App; componentId: string }> {
    const comp = library.saveLibrary(owner, { name: "CPU card", node: { id: "c_cpucardaaa", type: "card", props: { title: "CPU" }, children: [{ id: "c_cputextaaa", type: "text", props: { text: "cpu" } }] }, sources: [], controls: [] });
    const { app } = svc.createApp(owner, { name: "Shared", slug });
    const d = repo.getDraft(app.id)!;
    const inst: ComponentNode = { id: "c_instanceaa", type: `lib:${comp.id}` as ComponentNode["type"], name: "CPU card", props: {}, libraryRef: { componentId: comp.id, version: comp.version }, slot: { x: 0, y: 0, w: 4, h: 12 } };
    await svc.applyOps(app.id, d.rev, [{ op: "node.add", parentId: d.doc.pages[0]!.root.id, node: inst }], owner);
    await versions.publishDraft(owner, app.id, { expectRev: repo.getDraft(app.id)!.rev });
    return { app: repo.getApp(app.id)!, componentId: comp.id };
  }

  it("exports library/<id>@<version>.json; a second instance without the component imports it, relinks the instance, and the review is clean", async () => {
    const { app, componentId } = await appWithInstance("r2-shared");
    const out = await appfile.exportAppFile(owner, app.id);
    const paths = zip.readZip(out.bytes).map((e) => e.path);
    expect(paths).toContain(`library/${componentId}@1.json`);
    // "A second instance": the component is not here.
    db.sqlite().prepare("DELETE FROM library_version WHERE component_id = ?").run(componentId);
    db.sqlite().prepare("DELETE FROM library_component WHERE id = ?").run(componentId);
    const parsed = appfile.parseAppFile(out.bytes, "shared.atrium-app.zip");
    expect(parsed.libraryFiles.map((f) => `${f.id}@${f.version}`)).toEqual([`${componentId}@1`]);
    const r = appfile.importAppFile(owner, parsed, { name: "Shared copy", mappings: {} });
    expect(r.library).toMatchObject({ reused: 0 }); // round 3 (item 14): a deleted local copy counts as "restored", never reused
    expect(r.library.imported + r.library.restored).toBe(1);
    const doc = repo.getDraft(r.app.id)!.doc;
    const inst = doc.pages[0]!.root.children!.find((n) => n.libraryRef)!;
    expect(Object.keys(library.libraryForDoc(doc))).toEqual([`${inst.libraryRef!.componentId}@1`]);
    const review = versions.reviewDraft(owner, r.app.id);
    expect(review.problems.filter((p) => p.code === "library.missing")).toEqual([]);
  });

  it("reuses a component that is already here, and a dangling library reference blocks publishing", async () => {
    const { app } = await appWithInstance("r2-shared-2");
    const out = await appfile.exportAppFile(owner, app.id);
    const r = appfile.importAppFile(owner, appfile.parseAppFile(out.bytes), { name: "Shared again", mappings: {} });
    expect(r.library).toMatchObject({ imported: 0, reused: 1, restored: 0 });

    const { app: broken } = svc.createApp(owner, { name: "Broken", slug: "r2-broken" });
    const d = repo.getDraft(broken.id)!;
    await svc.applyOps(broken.id, d.rev, [{ op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_danglingaa", type: "lib:l_nowhereaaa" as ComponentNode["type"], props: {}, libraryRef: { componentId: "l_nowhereaaa", version: 3 }, slot: { x: 0, y: 0, w: 4, h: 8 } } }], owner);
    const review = versions.reviewDraft(owner, broken.id);
    const missing = review.problems.find((p) => p.code === "library.missing");
    expect(missing).toMatchObject({ severity: "error", where: { nodeId: "c_danglingaa" } });
    expect(review.canPublish).toBe(false);
  });

  it("a library file that is not a component refuses the whole import, naming the file", () => {
    const tree = { "app.json": { format: "atrium-app", formatVersion: 1, slug: "x", app: { name: "X", homePage: "p_aaaaaaaaaa", pageOrder: ["p_aaaaaaaaaa"] } }, "pages/home.json": { id: "p_aaaaaaaaaa", slug: "home", title: "Home", inNav: true, root: { id: "c_aaaaaaaaaa", type: "grid", props: {}, children: [] } }, "library/l_bad@1.json": { format: "nope" } };
    expect(() => appfile.parseAppFile(tree, "x.atrium-app.zip")).toThrow(/library\/l_bad@1\.json is not a library component/);
  });
});

describe("item 8: the publish review lists only real changes", () => {
  it("after a publish, one label edit gives exactly one line (no phantom theme change)", async () => {
    const { app } = svc.createApp(owner, { name: "Blank", slug: "r2-blank" });
    let d = repo.getDraft(app.id)!;
    await svc.applyOps(app.id, d.rev, [{ op: "node.add", parentId: d.doc.pages[0]!.root.id, node: node("stat", { label: "Disk free" }, "c_diskstatab") }], owner);
    await versions.publishDraft(owner, app.id, { expectRev: repo.getDraft(app.id)!.rev });
    expect(repo.getVersion(app.id, 1)!.doc.theme).toHaveProperty("inline"); // the version holds a snapshot
    d = repo.getDraft(app.id)!;
    await svc.applyOps(app.id, d.rev, [{ op: "node.update", nodeId: "c_diskstatab", patch: { props: { label: "Disk free (NAS)" } } }], owner);
    const lines = versions.reviewDraft(owner, app.id).groups.flatMap((g) => g.lines.map((l) => l.text));
    expect(lines).toEqual(["Changed stat Disk free (NAS)"]);
  });

  it("a real theme change still shows", async () => {
    const { sameTheme } = await import("@/features/versions/diff");
    expect(sameTheme({ themeId: "dusk" }, { inline: { id: "dusk" } as never })).toBe(true);
    expect(sameTheme({ themeId: "dusk" }, { inline: { id: "solid" } as never })).toBe(false);
    expect(sameTheme({ themeId: "dusk" }, { themeId: "solid" })).toBe(false);
  });
});

describe("item 9: removed CSS is reported", () => {
  it("the review warns how many CSS rules were removed from node and navigation CSS", async () => {
    const { app } = svc.createApp(owner, { name: "Css", slug: "r2-css" });
    const d = repo.getDraft(app.id)!;
    await svc.applyOps(app.id, d.rev, [
      { op: "chrome.update", patch: { css: ":scope { position: fixed; top: -900px }" } },
      { op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { ...node("text", { text: "x" }, "c_csstextaaa"), css: ":scope { position: fixed }" } },
    ], owner as Principal);
    const warn = versions.reviewDraft(owner, app.id).problems.find((p) => p.code === "css.removed");
    expect(warn).toMatchObject({ severity: "warning", message: "2 CSS rules were removed", where: { nodeId: "c_csstextaaa" } });
    expect(checks.cssWarnings(repo.getDraft(app.id)!.doc)).toHaveLength(1);
  });
});
