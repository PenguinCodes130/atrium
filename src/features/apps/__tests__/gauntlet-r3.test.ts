// Gauntlet w2-r2 Fix List, round 3 (app-builder): the offline snapshot holds nothing editor-only (item 1),
// controls name their unmapped parameters (item 2), unconnected cards look the same for every audience
// and only people who can add integrations get "Connect it" (item 5), and import never relinks a deleted
// library component (item 14). Real temp SQLite; components' guest resolver and the library store are
// real; the rest of components and settings is the local fake.
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { CommandDef, ComponentNode } from "@/core/contracts";
import { editor, guestOf, owner, seedIntegration, seedUsers, setupAppsDb, viewer, watcher } from "./harness";

// A Custom API style command with one required on/off parameter (the default "Add a command" schema).
const LAMP: CommandDef = { id: "lamp.toggle", label: "Desk lamp", description: "", params: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"] }, risk: "low" };
vi.mock("@/features/integrations/commands", async (orig) => {
  const real = await orig<typeof import("@/features/integrations/commands")>();
  return { ...real, commandCatalog: (row: Parameters<typeof real.commandCatalog>[0]) => new Map([...real.commandCatalog(row), [LAMP.id, { def: LAMP }]]) as ReturnType<typeof real.commandCatalog> };
});
vi.mock("@/features/apps/deps", async () => {
  const lib = await import("@/features/library/server");
  const components = await import("@/features/components");
  return { ...(await import("./harness")).fakeDeps, resolveGuestValues: components.resolveGuestValues, libraryForDoc: lib.libraryForDoc, getLibrary: lib.getLibrary, importLibrary: lib.importLibrary, toComponentFile: lib.toComponentFile, parseComponentFile: lib.parseComponentFile, CONTAINS_CODE_NOTICE: lib.CONTAINS_CODE_NOTICE };
});

setupAppsDb();

let svc: typeof import("../service");
let versions: typeof import("@/features/versions/service");
let repo: typeof import("../repo");
let load: typeof import("../load");
let checks: typeof import("../checks");
let resolver: typeof import("../resolver");
let appfile: typeof import("../appfile");
let library: typeof import("@/features/library/server");
let haId = "";

beforeAll(async () => {
  await seedUsers();
  haId = await seedIntegration(owner);
  svc = await import("../service");
  versions = await import("@/features/versions/service");
  repo = await import("../repo");
  load = await import("../load");
  checks = await import("../checks");
  resolver = await import("../resolver");
  appfile = await import("../appfile");
  library = await import("@/features/library/server");
});

const SECRET = "light.secprobe_door_4821";

async function doorApp(slug: string) {
  const { app } = svc.createApp(owner, { name: "Door", slug });
  const d = repo.getDraft(app.id)!;
  const root = d.doc.pages[0]!.root;
  svc.applyDraftOps({ appId: app.id, by: owner, expectRev: d.rev, ops: [
    { op: "source.set", source: { name: "ha", integrationId: haId, endpointId: "states", params: { domain: "lock" }, refreshSec: 10 } },
    { op: "control.set", control: { id: "k_secdooraaa", label: "Front door", run: { kind: "command", integrationId: haId, commandId: "light.toggle", params: { entityId: SECRET } } } },
    { op: "node.add", parentId: root.id, node: { id: "c_secdoornod", type: "button", props: { label: "Front door", control: "k_secdooraaa" }, slot: { x: 0, y: 0, w: 4, h: 8 } } },
    { op: "node.add", parentId: root.id, node: { id: "c_secstataaa", type: "stat", props: { data: { $bind: "{{ ha.rows | count }}" } }, slot: { x: 4, y: 0, w: 4, h: 8 } } },
    { op: "chrome.update", patch: { css: ":scope { --secprobe-chrome: 1 }" } },
  ] });
  const review = versions.reviewDraft(owner, app.id);
  await versions.publishDraft(owner, app.id, { expectRev: review.rev });
  svc.updateAccess(owner, app.id, { view: "everyone", edit: { userIds: [editor.userId] }, guests: true });
  return repo.getApp(app.id)!;
}

describe("item 1: the offline snapshot never holds more than a guest of the app sees", () => {
  it("for the owner, an editor, a viewer and a guest, the snapshot has no run details, source definitions or navigation CSS", async () => {
    const app = await doorApp("r3-sec-snapshot");
    for (const p of [owner, editor, watcher, viewer, guestOf(app.id)]) {
      const s = await load.loadView(app.slug, undefined, p, { draft: false, render: false, snapshot: true });
      expect(s.kind).toBe("ok");
      if (s.kind !== "ok") continue;
      const text = JSON.stringify(s.rendered.doc);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(haId);
      expect(text).not.toContain('"domain"');
      expect(text).not.toContain("secprobe-chrome");
      expect(s.mode).toBe("view");
      expect(s.editor).toBe(false);
      expect(s.rendered.unmapped.every((u) => u.href === "")).toBe(true);
    }
    // The page the editor receives online still has everything (the snapshot is a separate request).
    const live = await load.loadView(app.slug, undefined, editor, { draft: false, render: false });
    expect(live.kind === "ok" && JSON.stringify(live.rendered.doc).includes(SECRET)).toBe(true);
    // Never-published apps have no snapshot, even for an editor.
    const { app: fresh } = svc.createApp(owner, { name: "Fresh", slug: "r3-fresh" });
    expect((await load.loadView(fresh.slug, undefined, owner, { draft: false, render: false, snapshot: true })).kind).toBe("not-found");
    // Someone who cannot open the app gets nothing either.
    svc.updateAccess(owner, app.id, { view: "owner", edit: "owner", guests: false });
    expect((await load.loadView(app.slug, undefined, viewer, { draft: false, render: false, snapshot: true })).kind).toBe("not-found");
  });
});

describe("item 2: a control maps every required parameter", () => {
  const lamp = (params: Record<string, unknown> | undefined) => ({ id: "k_lampaaaaaa", label: "Desk lamp", run: { kind: "command" as const, integrationId: haId, commandId: LAMP.id, ...(params ? { params: params as never } : {}) } });
  it("an unmapped required parameter is a warning while editing and an error in the review, naming it", () => {
    const editing = checks.checkControl(lamp({}), owner);
    expect(editing.map((p) => `${p.severity}|${p.code}|${p.message}|${p.where.field}`)).toEqual(["warning|control.param_missing|Desk lamp needs a value for on.|run.params.on"]);
    const publishing = checks.checkControl(lamp(undefined), owner, { publishing: true });
    expect(publishing[0]).toMatchObject({ severity: "error", code: "control.param_missing", message: "Desk lamp needs a value for on." });
  });
  it("mapped to the toggle's value or a fixed value, there is no problem", () => {
    expect(checks.checkControl(lamp({ on: { $bind: "{{ $input }}" } }), owner, { publishing: true })).toEqual([]);
    expect(checks.checkControl(lamp({ on: true }), owner, { publishing: true })).toEqual([]);
  });
  it("the review blocks publishing and points at the component that runs it", async () => {
    const { app } = svc.createApp(owner, { name: "Lamp", slug: "r3-lamp" });
    const d = repo.getDraft(app.id)!;
    svc.applyDraftOps({ appId: app.id, by: owner, expectRev: d.rev, ops: [
      { op: "control.set", control: lamp({}) },
      { op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_lamptoggle", type: "toggle", props: { label: "Desk lamp", control: "k_lampaaaaaa" }, slot: { x: 0, y: 0, w: 4, h: 8 } } },
    ] });
    const review = versions.reviewDraft(owner, app.id);
    const p = review.problems.find((x) => x.code === "control.param_missing");
    expect(p).toMatchObject({ severity: "error", where: { nodeId: "c_lamptoggle" } });
    expect(review.canPublish).toBe(false);
  });
});

describe("item 2: guests and viewers never see builder repair text", async () => {
  const { viewerRunMessage } = await import("../run-message");
  it("replaces author-facing hints for people who cannot edit, keeps them for editors", () => {
    const raw = 'Invalid parameter on: "on" is required. Fix the control\'s parameters in the builder.';
    expect(viewerRunMessage(raw, true, false)).toBe(raw);
    expect(viewerRunMessage(raw, false, true)).toBe("This control is not set up correctly yet. Ask the person who shared this app to fix it.");
    expect(viewerRunMessage(raw, false, false)).not.toContain("builder");
    expect(viewerRunMessage("This control's entityId must be a fixed value set in the builder.", false, true)).not.toContain("builder");
    expect(viewerRunMessage("Home Assistant did not answer.", false, true)).toBe("Home Assistant did not answer.");
  });
});

describe("item 5: unconnected cards look the same for every audience", () => {
  async function homelab(slug: string) {
    const { app } = svc.createApp(owner, { name: "Homelab", slug, template: "homelab", mappings: {} });
    const review = versions.reviewDraft(owner, app.id);
    await versions.publishDraft(owner, app.id, { expectRev: review.rev });
    svc.updateAccess(owner, app.id, { view: "everyone", edit: "owner", guests: true });
    return repo.getApp(app.id)!;
  }
  it("only people who can add integrations get the link; viewers and guests read Not connected yet", async () => {
    const app = await homelab("r3-homelab");
    const shape = async (p: Parameters<typeof load.loadView>[2]) => {
      const s = await load.loadView(app.slug, undefined, p, { draft: false, render: false });
      return s.kind === "ok" ? s.rendered.unmapped.map((u) => `${u.key}|${u.message}|${u.href}`).sort() : [];
    };
    expect(await shape(owner)).toEqual(["containers|No data: connect Docker|/integrations/new/docker", "nodes|No data: connect Proxmox VE|/integrations/new/proxmox", "running|No data: connect Docker|/integrations/new/docker"]);
    expect(await shape(watcher)).toEqual(["containers|No data: connect Docker|/integrations/new/docker", "nodes|No data: connect Proxmox VE|/integrations/new/proxmox", "running|No data: connect Docker|/integrations/new/docker"]);
    for (const p of [viewer, guestOf(app.id)]) expect(await shape(p)).toEqual(["containers|Not connected yet|", "nodes|Not connected yet|", "running|Not connected yet|"]);
  });
  it("a guest's components carry the calm empty status at once, and the stream's guest values agree", async () => {
    const app = await homelab("r3-homelab-g");
    const s = await load.loadView(app.slug, undefined, guestOf(app.id), { draft: false, render: false });
    expect(s.kind).toBe("ok");
    if (s.kind !== "ok") return;
    const statuses = Object.entries(s.rendered.guestStatus ?? {});
    expect(statuses.length).toBe(3); // the stat, the status list and the table
    expect(statuses.every(([k, v]) => k.endsWith(":$status") && (v as { kind: string; message: string; href?: string }).kind === "empty" && (v as { message: string }).message === "Not connected yet" && !(v as { href?: string }).href)).toBe(true);
    const page = repo.getVersion(app.id, app.publishedVersion!)!.doc.pages[0]!;
    const stream = await resolver.accessResolver.guestValues!(app.id, page.id, {});
    for (const [k, v] of statuses) expect(stream[k]).toEqual(v);
  });
});

describe("item 14: import never relinks a deleted library component", () => {
  it("a deleted component with the same id, version and content is brought back as a visible copy, and the outcome is named", async () => {
    const saved = library.saveLibrary(owner, { name: "Lamp card", description: "", tags: [], node: { id: "c_libcardaaa", type: "card", props: { title: "Lamp" }, children: [] } as ComponentNode, sources: [], controls: [] });
    const { app } = svc.createApp(owner, { name: "Uses lib", slug: "r3-uses-lib" });
    const d = repo.getDraft(app.id)!;
    svc.applyDraftOps({ appId: app.id, by: owner, expectRev: d.rev, ops: [{ op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_libinstaaa", type: `lib:${saved.id}`, props: {}, libraryRef: { componentId: saved.id, version: saved.version }, slot: { x: 0, y: 0, w: 4, h: 8 } } }] });
    const file = await appfile.exportAppFile(owner, app.id);
    const parsed = appfile.parseAppFile(file.bytes, file.filename);
    expect(appfile.planLibrary(owner, parsed.libraryFiles).map((x) => x.outcome)).toEqual(["reused"]);
    library.deleteLibrary(owner, saved.id);
    expect(appfile.planLibrary(owner, parsed.libraryFiles).map((x) => x.outcome)).toEqual(["restored"]);
    const r = appfile.importAppFile(owner, parsed, { mappings: {}, slug: "r3-imported-lib" });
    expect(r.library).toMatchObject({ reused: 0, restored: 1, imported: 0 });
    const ref = repo.getDraft(r.app.id)!.doc.pages[0]!.root.children!.find((n) => n.libraryRef)!.libraryRef!;
    expect(ref.componentId).not.toBe(saved.id);
    expect(library.listLibrary(owner).some((c) => c.id === ref.componentId)).toBe(true);
  });
});
