// app-builder services against a real temp SQLite database. components and settings are replaced by a
// local fake (tests only). Criteria refer to app-builder-spec.md section 5.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, AppDocument, ComponentNode, ControlDef, DraftOp, Principal } from "@/core/contracts";
import { newId } from "../doc";
import { agentFor, editor, fakeTheme, guestOf, outsider, owner, seedIntegration, seedUsers, setupAppsDb, themeEdits, viewer, watcher } from "./harness";

vi.mock("@/features/apps/deps", async () => (await import("./harness")).fakeDeps);

setupAppsDb();

let svc: typeof import("../service");
let versions: typeof import("@/features/versions/service");
let resolver: typeof import("../resolver");
let repo: typeof import("../repo");
let hooks: typeof import("../hooks");
let appfile: typeof import("../appfile");
let tools: typeof import("../tools");
let db: typeof import("@/core/db");
let haId: string;

beforeAll(async () => {
  db = await import("@/core/db");
  await seedUsers();
  haId = await seedIntegration(owner);
  svc = await import("../service");
  versions = await import("@/features/versions/service");
  resolver = await import("../resolver");
  repo = await import("../repo");
  hooks = await import("../hooks");
  appfile = await import("../appfile");
  tools = await import("../tools");
});

beforeEach(() => {
  hooks.registerLayoutAutoApply(undefined);
  hooks.registerVersionRetention(undefined);
});

let slugN = 0;
const slug = () => `app-${++slugN}`;

function auditCount(event: string, appId: string): number {
  return (db.sqlite().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event = ? AND target_id = ?").get(event, appId) as { n: number }).n;
}

function draftOf(appId: string): { rev: number; doc: AppDocument } {
  const d = repo.getDraft(appId)!;
  return { rev: d.rev, doc: d.doc };
}

function rootOf(appId: string): string {
  return draftOf(appId).doc.pages[0]!.root.id;
}

const node = (type: ComponentNode["type"], props: ComponentNode["props"], id: string): ComponentNode => ({ id, type, props, slot: { x: 0, y: 0, w: 3, h: 8 } });
const lampControl = (id = "k_lampaaaaaa", entity: unknown = "light.lamp"): ControlDef => ({ id, label: "Bedroom lamp", run: { kind: "command", integrationId: haId, commandId: "light.toggle", params: { entityId: entity as string } } });

function newApp(by: Principal = owner, name = "Lounge"): App {
  return svc.createApp(by, { name, slug: slug() }).app;
}

function insertGuestLink(appId: string, createdBy: string, id: string): void {
  const now = Date.now();
  db.sqlite()
    .prepare("INSERT INTO guest_link (id, app_id, label, token_hash, created_by, created_by_name, created_at, expires_at, pin_fail_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)")
    .run(id, appId, `link ${id}`, `hash-${id}`, createdBy, "x", now, now + 86400000);
}
function linkRevoked(id: string): boolean {
  return (db.sqlite().prepare("SELECT revoked_at FROM guest_link WHERE id = ?").get(id) as { revoked_at: number | null }).revoked_at != null;
}

async function publishedApp(access: App["access"]): Promise<{ app: App; lampNode: string; doc: AppDocument }> {
  const app = newApp(owner, "Guest room");
  const root = rootOf(app.id);
  svc.applyDraftOps({
    appId: app.id,
    by: owner,
    ops: [
      { op: "source.set", source: { name: "ha", integrationId: haId, endpointId: "states", refreshSec: 10 } },
      { op: "control.set", control: lampControl() },
      { op: "node.add", parentId: root, node: node("toggle", { label: "Lamp", control: "k_lampaaaaaa", state: { $bind: '{{ ha.find("entity_id", "light.lamp").state }}' } }, "c_lampnodeaa") },
    ],
  });
  svc.updateAccess(owner, app.id, access);
  const d = draftOf(app.id);
  await versions.publishDraft(owner, app.id, { expectRev: d.rev, note: "first" });
  return { app: repo.getApp(app.id)!, lampNode: "c_lampnodeaa", doc: d.doc };
}

describe("creating apps (criteria 1, 4, 5)", () => {
  it("a viewer is refused, and so is an agent without edit scope", () => {
    expect(() => svc.createApp(viewer, { name: "Mine", slug: slug() })).toThrow(/Only owners and members/);
    expect(() => svc.createApp(agentFor(editor, ["atrium:read"]), { name: "Mine", slug: slug() })).toThrow(/Only owners and members/);
  });
  it("refuses a taken, long or invalid slug at the slug field and creates nothing", () => {
    const a = newApp();
    const before = repo.listApps().length;
    for (const bad of [a.slug, "a".repeat(41), "Bad_Slug"]) {
      try {
        svc.createApp(owner, { name: "X", slug: bad });
        throw new Error("not refused");
      } catch (err) {
        expect((err as { field?: string }).field).toBe("slug");
      }
    }
    expect(repo.listApps().length).toBe(before);
  });
  it("Guest room from the template: mapped, no published version, draft only, one app.created", () => {
    const { app, rev } = svc.createApp(editor, { name: "Guest room", slug: "guest-room", template: "guest-room", mappings: { ha: haId } });
    expect(app.publishedVersion).toBeUndefined();
    expect(rev).toBe(1);
    expect(app.access).toEqual({ view: "owner", edit: { userIds: [editor.userId] }, guests: false });
    const d = draftOf(app.id).doc;
    // The editor may not bind the owner's unshared integration: the source stays as an unmapped placeholder
    // (gauntlet w2-r1 item 2), so its components show "No data: connect Home Assistant".
    expect(d.dataSources.map((s) => s.integrationId)).toEqual(["$unmapped:home-assistant"]);
    expect(auditCount("app.created", app.id)).toBe(1);
    const own = svc.createApp(owner, { name: "Guest room 2", slug: "guest-room-2", template: "guest-room", mappings: { ha: haId } });
    const od = draftOf(own.app.id).doc;
    expect(od.dataSources[0]!.integrationId).toBe(haId);
    expect(od.controls.every((c) => c.run.kind === "command" && c.run.integrationId === haId)).toBe(true);
  });
});

describe("app access answers (criteria 32, 43)", () => {
  it("matches the rules for every principal", async () => {
    const { app, lampNode } = await publishedApp({ view: { userIds: [watcher.userId] }, edit: { userIds: [editor.userId, viewer.userId] }, guests: true });
    const other = await publishedApp({ view: "owner", edit: "owner", guests: true });
    const r = resolver.accessResolver;
    const pageId = draftOf(app.id).doc.pages[0]!.id;
    const cases: [string, Principal, { open: boolean; edit: boolean }][] = [
      ["owner", owner, { open: true, edit: true }],
      ["member in edit list", editor, { open: true, edit: true }],
      ["member in view list only", watcher, { open: true, edit: false }],
      ["viewer in edit list", viewer, { open: true, edit: false }],
      ["unshared member", outsider, { open: false, edit: false }],
      ["guest of the app", guestOf(app.id), { open: true, edit: false }],
      ["guest of another app", guestOf(other.app.id), { open: false, edit: false }],
      ["agent for owner", agentFor(owner), { open: true, edit: true }],
      ["agent for editor", agentFor(editor), { open: true, edit: true }],
      ["read-only agent for editor", agentFor(editor, ["atrium:read"]), { open: true, edit: false }],
      ["agent for watcher", agentFor(watcher), { open: true, edit: false }],
      ["agent for viewer", agentFor(viewer), { open: true, edit: false }],
      ["agent for outsider", agentFor(outsider), { open: false, edit: false }],
    ];
    for (const [label, p, want] of cases) {
      expect([label, await r.canOpenApp(p, app.id)]).toEqual([label, want.open]);
      expect([label, await r.canEditApp(p, app.id)]).toEqual([label, want.edit]);
      const list = (await r.appsFor(p)).map((a) => a.id);
      expect([label, list.includes(app.id)]).toEqual([label, p.kind === "guest" ? false : want.open]);
      const ctl = await r.publishedControl(app.id, "k_lampaaaaaa", lampNode, { draft: false, principal: p });
      expect([label, !!ctl]).toEqual([label, want.open]);
      const draftCtl = await r.publishedControl(app.id, "k_lampaaaaaa", lampNode, { draft: true, principal: p });
      expect([label, !!draftCtl]).toEqual([label, want.edit && p.kind === "user"]);
      const sources = await resolver.pageSources.page(app.id, pageId, p, false);
      expect([label, sources === null ? null : sources.map((s) => s.name)]).toEqual([label, want.open ? ["ha"] : null]);
    }
    expect(await r.appsFor(guestOf(app.id))).toEqual([]);
    // A control id and node that do not belong together answer null.
    expect(await r.publishedControl(app.id, "k_lampaaaaaa", draftOf(app.id).doc.pages[0]!.root.id, { draft: false, principal: owner })).toBeNull();
  });

  it("a never-published app is not open to a guest, and a deleted app to nobody", async () => {
    const app = newApp();
    svc.updateAccess(owner, app.id, { view: "everyone", edit: "owner", guests: true });
    expect(await resolver.accessResolver.canOpenApp(guestOf(app.id), app.id)).toBe(false);
    expect(await resolver.accessResolver.canOpenApp(outsider, app.id)).toBe(true);
    svc.deleteApp(owner, app.id, "Lounge");
    expect(await resolver.accessResolver.canOpenApp(owner, app.id)).toBe(false);
  });

  it("guest values come from the published version only, resolved per node (criterion 39)", async () => {
    const { app, lampNode } = await publishedApp({ view: "owner", edit: "owner", guests: true });
    const pageId = draftOf(app.id).doc.pages[0]!.id;
    const rows = Array.from({ length: 48 }, (_, i) => ({ entity_id: i === 0 ? "light.lamp" : `light.other_${i}`, state: i % 2 ? "on" : "off" }));
    const values = await resolver.accessResolver.guestValues(app.id, pageId, { ha: { kind: "table", columns: [], rows } });
    expect(values).toEqual({ [`${lampNode}:state`]: "off" });
    expect(JSON.stringify(values)).not.toContain("light.other_");
  });
});

describe("the shared draft (criteria 9, 10, 15, 16, 46)", () => {
  it("bumps rev by one, refuses a stale rev with the current one, and a refused batch changes nothing", () => {
    const app = newApp();
    const root = rootOf(app.id);
    const r1 = svc.applyDraftOps({ appId: app.id, by: owner, expectRev: 1, ops: [{ op: "node.add", parentId: root, node: node("stat", { label: "CPU" }, "c_statnodeaa") }] });
    expect(r1.rev).toBe(2);
    expect(() => svc.applyDraftOps({ appId: app.id, by: owner, expectRev: 1, ops: [{ op: "node.remove", nodeId: "c_statnodeaa" }] })).toThrow(expect.objectContaining({ code: "conflict", currentRev: 2 }));
    expect(() => svc.applyDraftOps({ appId: app.id, by: owner, ops: [{ op: "node.update", nodeId: "c_statnodeaa", patch: { props: { decimals: "two" } } }] })).toThrow(expect.objectContaining({ code: "invalid" }));
    expect(draftOf(app.id).rev).toBe(2);
  });

  it("an agent removing one node while a person edits another: the person's edit applies; an edit on the removed node is dropped", () => {
    const app = newApp();
    const root = rootOf(app.id);
    svc.applyDraftOps({ appId: app.id, by: owner, ops: [{ op: "node.add", parentId: root, node: node("stat", { label: "A" }, "c_aaaaaaaaaa") }, { op: "node.add", parentId: root, node: node("stat", { label: "B" }, "c_bbbbbbbbbb") }] });
    const seen = draftOf(app.id).rev;
    svc.applyDraftOps({ appId: app.id, by: agentFor(owner), expectRev: seen, ops: [{ op: "node.remove", nodeId: "c_aaaaaaaaaa" }] });
    // The person's pending edit was made at `seen`: conflict, then the builder resends on the newer draft.
    const edit: DraftOp[] = [{ op: "node.update", nodeId: "c_bbbbbbbbbb", patch: { props: { label: "B2" } } }];
    let rev = seen;
    try {
      svc.applyDraftOps({ appId: app.id, by: owner, expectRev: rev, ops: edit });
    } catch (err) {
      rev = (err as { currentRev: number }).currentRev;
    }
    expect(svc.applyDraftOps({ appId: app.id, by: owner, expectRev: rev, ops: edit }).rev).toBe(rev + 1);
    // An edit whose target the agent removed is refused naming the node, so the builder drops it.
    try {
      svc.applyDraftOps({ appId: app.id, by: owner, ops: [{ op: "node.update", nodeId: "c_aaaaaaaaaa", patch: { props: { label: "A2" } } }] });
      throw new Error("not refused");
    } catch (err) {
      expect((err as { problems: { code: string; where: { nodeId?: string } }[] }).problems[0]).toMatchObject({ code: "node.missing", where: { nodeId: "c_aaaaaaaaaa" } });
    }
  });

  it("a control whose target comes from input or a binding is refused naming the field", () => {
    const app = newApp();
    for (const entity of ["{{ $input }}", { $bind: "{{ $input }}" }, ""]) {
      try {
        svc.applyDraftOps({ appId: app.id, by: owner, ops: [{ op: "control.set", control: lampControl("k_badtargeta", entity) }] });
        throw new Error("not refused");
      } catch (err) {
        expect((err as { problems: { where: { field?: string } }[] }).problems[0]!.where.field).toBe("run.params.entityId");
      }
    }
    expect(draftOf(app.id).doc.controls).toEqual([]);
  });

  it("a member who did not set up the integration cannot bind its commands", () => {
    const app = svc.createApp(editor, { name: "Mine", slug: slug() }).app;
    expect(() => svc.applyDraftOps({ appId: app.id, by: editor, ops: [{ op: "control.set", control: lampControl() }] })).toThrow(expect.objectContaining({ code: "invalid" }));
  });

  it("a data source below the endpoint's minimum refresh is refused naming refreshSec", () => {
    const app = newApp();
    try {
      svc.applyDraftOps({ appId: app.id, by: owner, ops: [{ op: "source.set", source: { name: "ha", integrationId: haId, endpointId: "states", refreshSec: 2 } }] });
      throw new Error("not refused");
    } catch (err) {
      const p = (err as { problems: { code: string; where: { field?: string }; message: string }[] }).problems[0]!;
      expect(p.code).toBe("source.refresh_below_min");
      expect(p.where.field).toBe("refreshSec");
      expect(p.message).toMatch(/at least 5 seconds/);
    }
  });

  it("audits every agent change, and a person's at most once per 10 minutes", () => {
    const app = newApp();
    const root = rootOf(app.id);
    for (let i = 0; i < 3; i++) svc.applyDraftOps({ appId: app.id, by: owner, ops: [{ op: "node.add", parentId: root, node: node("text", { text: `p${i}` }, newId("c")) }] });
    for (let i = 0; i < 3; i++) svc.applyDraftOps({ appId: app.id, by: agentFor(owner), ops: [{ op: "node.add", parentId: root, node: node("text", { text: `a${i}` }, newId("c")) }] });
    const rows = db.sqlite().prepare("SELECT actor_kind AS k, COUNT(*) AS n FROM audit_log WHERE event = 'app.draft_changed' AND target_id = ? GROUP BY actor_kind").all(app.id) as { k: string; n: number }[];
    expect(Object.fromEntries(rows.map((r) => [r.k, r.n]))).toEqual({ user: 1, agent: 3 });
  });

  it("nodes added by an agent are tagged until the next publish (criterion 14)", async () => {
    const app = newApp();
    svc.applyDraftOps({ appId: app.id, by: agentFor(owner), ops: [{ op: "node.add", parentId: rootOf(app.id), node: node("text", { text: "hi" }, "c_agentnodea") }] });
    expect(versions.agentNodeIds(app.id)).toEqual(["c_agentnodea"]);
    const review = versions.reviewDraft(owner, app.id);
    expect(review.authors).toContainEqual({ kind: "agent", name: "Claude", count: 1 });
    await versions.publishDraft(owner, app.id, { expectRev: review.rev });
    expect(versions.agentNodeIds(app.id)).toEqual([]);
  });
});

describe("session-only operations refuse agents with a reason (criteria 25, 31)", () => {
  const agents: [string, Principal][] = [
    ["MCP agent", { ...agentFor(owner), via: "mcp-oauth" }],
    ["bearer token", agentFor(owner)],
    ["built-in agent", { kind: "builtin-agent", userId: owner.userId, role: "owner", conversationId: "c1" }],
  ];
  for (const [label, p] of agents) {
    it(`${label}: publish, restore, access, delete and discard are refused`, async () => {
      const { app } = await publishedApp({ view: "owner", edit: "owner", guests: false });
      const rev = draftOf(app.id).rev;
      await expect(versions.publishDraft(p, app.id, { expectRev: rev })).rejects.toThrow(/Only a signed-in person can publish/);
      await expect(versions.restoreVersion(p, app.id, 1, { expectRev: rev })).rejects.toThrow(/Only a signed-in person can restore/);
      expect(() => svc.updateAccess(p, app.id, { view: "everyone", edit: "owner", guests: true })).toThrow(/Only a signed-in person can change who can open/);
      expect(() => svc.deleteApp(p, app.id, app.name)).toThrow(/Only a signed-in person can delete/);
      expect(() => svc.discardDraft(p, app.id)).toThrow(/Only a signed-in person can discard/);
      expect(repo.getApp(app.id)!.publishedVersion).toBe(1);
    });
  }
});

describe("publish and versions (criteria 21, 23, 24, 26, 27, 28, 29)", () => {
  it("publishes version N+1 with note and author, and audits it", async () => {
    const { app } = await publishedApp({ view: "owner", edit: "owner", guests: false });
    svc.applyDraftOps({ appId: app.id, by: owner, ops: [{ op: "node.add", parentId: rootOf(app.id), node: node("text", { text: "hi" }, "c_textnodeaa") }] });
    const r = await versions.publishDraft(owner, app.id, { expectRev: draftOf(app.id).rev, note: "Added a greeting" });
    expect(r.version).toBe(2);
    const v = repo.getVersion(app.id, 2)!;
    expect(v).toMatchObject({ note: "Added a greeting", publishedBy: owner.userId, publishedByName: "Tristan Owner", source: "publish" });
    expect(auditCount("app.published", app.id)).toBe(2);
    expect(repo.getApp(app.id)!.publishedVersion).toBe(2);
  });

  it("refuses when the draft changed after the review opened, and creates no version", async () => {
    const { app } = await publishedApp({ view: "owner", edit: "owner", guests: false });
    const review = versions.reviewDraft(owner, app.id);
    svc.applyDraftOps({ appId: app.id, by: agentFor(owner), ops: [{ op: "node.add", parentId: rootOf(app.id), node: node("text", { text: "x" }, "c_sneakyaaaa") }] });
    await expect(versions.publishDraft(owner, app.id, { expectRev: review.rev })).rejects.toThrow("The draft changed; review again");
    expect(repo.listVersions(app.id).length).toBe(1);
  });

  it("the review lists controls with integration and command, authors, and blocks on a validation error", async () => {
    const app = newApp();
    svc.applyDraftOps({ appId: app.id, by: owner, ops: [{ op: "control.set", control: lampControl() }, { op: "node.add", parentId: rootOf(app.id), node: node("toggle", { label: "Lamp", control: "k_lampaaaaaa" }, "c_lampnodeaa") }] });
    svc.applyDraftOps({ appId: app.id, by: agentFor(owner), ops: [{ op: "node.add", parentId: rootOf(app.id), node: node("button", { label: "Gone", control: "k_nothereaaa" }, "c_brokenaaaa") }] });
    const review = versions.reviewDraft(owner, app.id);
    expect(review.controls).toEqual([expect.objectContaining({ label: "Bedroom lamp", integration: "Home Assistant", command: "home-assistant · light.toggle light.lamp", change: "added", draftOnly: true })]);
    expect(review.authors.map((a) => `${a.kind}:${a.name}`)).toEqual(["person:Tristan Owner", "agent:Claude"]);
    expect(review.problems.some((x) => x.severity === "error" && x.code === "control.missing")).toBe(true);
    expect(review.canPublish).toBe(false);
    await expect(versions.publishDraft(owner, app.id, { expectRev: review.rev })).rejects.toThrow(/problem/);
  });

  it("a guest-enabled app whose html block binds a whole 48-row source warns in the review (criterion 22)", async () => {
    const { guestWarnings } = await import("../checks");
    const doc = draftOf(newApp().id).doc;
    doc.dataSources.push({ name: "ha", integrationId: haId, endpointId: "states", refreshSec: 10 });
    doc.pages[0]!.root.children = [node("html", { html: "<p></p>", data: { all: { $bind: "{{ ha }}" } }, controls: [] }, "c_htmlblocka")];
    expect(guestWarnings(doc, true, () => 48).map((p) => p.message)).toEqual(["Guests will receive 48 rows of ha"]);
    expect(guestWarnings(doc, false, () => 48)).toEqual([]);
  });

  it("snapshots the theme: editing it later leaves the published version unchanged", async () => {
    const app = newApp();
    svc.applyDraftOps({ appId: app.id, by: owner, ops: [{ op: "theme.set", theme: { themeId: "my-theme" } }, { op: "node.add", parentId: rootOf(app.id), node: node("text", { text: "x" }, "c_themenodea") }] });
    themeEdits.set("my-theme", "#111111");
    await versions.publishDraft(owner, app.id, { expectRev: draftOf(app.id).rev });
    themeEdits.set("my-theme", "#FF0000");
    const v = repo.getVersion(app.id, 1)!;
    expect(v.doc.theme).toEqual({ inline: fakeTheme("my-theme", "#111111") });
    expect(draftOf(app.id).doc.theme).toEqual({ themeId: "my-theme" });
  });

  it("restore publishes a copy tagged restore, resets the draft and audits app.restored", async () => {
    const { app } = await publishedApp({ view: "owner", edit: "owner", guests: false });
    svc.applyDraftOps({ appId: app.id, by: owner, ops: [{ op: "control.remove", controlId: "k_lampaaaaaa" }, { op: "node.remove", nodeId: "c_lampnodeaa" }] });
    await versions.publishDraft(owner, app.id, { expectRev: draftOf(app.id).rev });
    svc.applyDraftOps({ appId: app.id, by: owner, ops: [{ op: "node.add", parentId: rootOf(app.id), node: node("text", { text: "unpublished" }, "c_unpubaaaaa") }] });
    const review = versions.reviewRestore(owner, app.id, 1);
    expect(review.controls.map((c) => c.label)).toEqual(["Bedroom lamp"]); // the control v1 would bring back
    expect(review.discardsDraftChanges).toBe(true);
    const r = await versions.restoreVersion(owner, app.id, 1, { expectRev: review.rev });
    expect(r.version).toBe(3);
    expect(repo.getVersion(app.id, 3)).toMatchObject({ source: "restore", restoredFrom: 1 });
    expect(draftOf(app.id).doc.pages[0]!.root.children!.map((n) => n.id)).toEqual(["c_lampnodeaa"]);
    expect(repo.pendingChanges(app.id)).toEqual([]);
    expect(auditCount("app.restored", app.id)).toBe(1);
  });

  it("retention keep 20: the 26th publish removes only the oldest version", async () => {
    hooks.registerVersionRetention(() => 20);
    const app = newApp();
    const root = rootOf(app.id);
    for (let i = 1; i <= 25; i++) {
      svc.applyDraftOps({ appId: app.id, by: owner, ops: [{ op: "node.add", parentId: root, node: node("text", { text: `v${i}` }, newId("c")) }] });
      await versions.publishDraft(owner, app.id, { expectRev: draftOf(app.id).rev });
    }
    const before = repo.listVersions(app.id).map((v) => v.version);
    expect(before.length).toBe(20);
    svc.applyDraftOps({ appId: app.id, by: owner, ops: [{ op: "node.update", nodeId: root, patch: { name: "last" } }] });
    const r = await versions.publishDraft(owner, app.id, { expectRev: draftOf(app.id).rev });
    expect(r.pruned).toEqual([Math.min(...before)]);
  });

  it("discard resets to the live document; a never-published app is refused", async () => {
    const app = newApp();
    expect(() => svc.discardDraft(owner, app.id)).toThrow("Nothing published to go back to. Delete the app instead.");
    const p = await publishedApp({ view: "owner", edit: "owner", guests: false });
    svc.applyDraftOps({ appId: p.app.id, by: owner, ops: [{ op: "node.remove", nodeId: "c_lampnodeaa" }] });
    svc.discardDraft(owner, p.app.id);
    expect(draftOf(p.app.id).doc.pages[0]!.root.children!.length).toBe(1);
  });
});

describe("layout auto-apply (criterion 30)", () => {
  it("with the switch on, a move-only batch creates an agent-layout version with only moves", async () => {
    const { app } = await publishedApp({ view: "owner", edit: "owner", guests: false });
    hooks.registerLayoutAutoApply((p) => p.kind === "agent");
    const root = rootOf(app.id);
    const r = svc.applyDraftOps({ appId: app.id, by: agentFor(owner), ops: [{ op: "node.move", nodeId: "c_lampnodeaa", parentId: root, slot: { x: 6, y: 0, w: 3, h: 8 } }] });
    expect(r.version).toBe(2);
    const v = repo.getVersion(app.id, 2)!;
    expect(v.source).toBe("agent-layout");
    const { diffDocuments } = await import("@/features/versions/diff");
    const d = diffDocuments(repo.getVersion(app.id, 1)!.doc, v.doc);
    expect(d.nodes).toEqual({ added: [], removed: [], moved: ["c_lampnodeaa"], props: [], style: [], code: [] });
    const other = svc.applyDraftOps({ appId: app.id, by: agentFor(owner), ops: [{ op: "node.move", nodeId: "c_lampnodeaa", parentId: root, slot: { x: 0, y: 0, w: 3, h: 8 } }, { op: "node.update", nodeId: "c_lampnodeaa", patch: { name: "x" } }] });
    expect(other.version).toBeUndefined();
    hooks.registerLayoutAutoApply(undefined);
    const off = svc.applyDraftOps({ appId: app.id, by: agentFor(owner), ops: [{ op: "node.move", nodeId: "c_lampnodeaa", parentId: root, slot: { x: 3, y: 0, w: 3, h: 8 } }] });
    expect(off.version).toBeUndefined();
    expect(repo.listVersions(app.id).length).toBe(2);
  });
});

describe("audience, guest links and delete (criteria 31, 33, 34, 35)", () => {
  it("access changes are saved and audited", () => {
    const app = newApp();
    svc.updateAccess(owner, app.id, { view: "everyone", edit: { userIds: [editor.userId] }, guests: false });
    expect(repo.getApp(app.id)!.access).toEqual({ view: "everyone", edit: { userIds: [editor.userId] }, guests: false });
    expect(auditCount("app.access_changed", app.id)).toBe(1);
  });
  it("turning guests off revokes every link; turning them on revives none", () => {
    const app = newApp();
    svc.updateAccess(owner, app.id, { view: "owner", edit: "owner", guests: true });
    insertGuestLink(app.id, owner.userId, `gl-${app.id}-1`);
    insertGuestLink(app.id, owner.userId, `gl-${app.id}-2`);
    const r = svc.updateAccess(owner, app.id, { view: "owner", edit: "owner", guests: false });
    expect(r.revokedLinks).toBe(2);
    svc.updateAccess(owner, app.id, { view: "owner", edit: "owner", guests: true });
    expect(linkRevoked(`gl-${app.id}-1`) && linkRevoked(`gl-${app.id}-2`)).toBe(true);
  });
  it("removing a member's edit right revokes that member's links on the app only", () => {
    const app = newApp();
    const other = newApp();
    svc.updateAccess(owner, app.id, { view: "owner", edit: { userIds: [editor.userId] }, guests: true });
    svc.updateAccess(owner, other.id, { view: "owner", edit: { userIds: [editor.userId] }, guests: true });
    insertGuestLink(app.id, editor.userId, `gl-${app.id}-e`);
    insertGuestLink(app.id, owner.userId, `gl-${app.id}-o`);
    insertGuestLink(other.id, editor.userId, `gl-${other.id}-e`);
    svc.updateAccess(owner, app.id, { view: { userIds: [editor.userId] }, edit: "owner", guests: true });
    expect(linkRevoked(`gl-${app.id}-e`)).toBe(true);
    expect(linkRevoked(`gl-${app.id}-o`)).toBe(false);
    expect(linkRevoked(`gl-${other.id}-e`)).toBe(false);
  });
  it("delete: owner or creator only, after typing the name; gone from every list, links revoked, audited", () => {
    const app = svc.createApp(editor, { name: "Editor's app", slug: slug() }).app;
    svc.updateAccess(owner, app.id, { view: "everyone", edit: { userIds: [editor.userId, watcher.userId] }, guests: true });
    insertGuestLink(app.id, editor.userId, `gl-${app.id}-d`);
    expect(() => svc.deleteApp(watcher, app.id, app.name)).toThrow(/Only the owner and the person who created/);
    expect(() => svc.deleteApp(editor, app.id, "wrong")).toThrow(/Type the app's name/);
    svc.deleteApp(editor, app.id, app.name);
    for (const p of [owner, editor, watcher, outsider]) expect(svc.appsFor(p).some((a) => a.id === app.id)).toBe(false);
    expect(linkRevoked(`gl-${app.id}-d`)).toBe(true);
    expect(auditCount("app.deleted", app.id)).toBe(1);
  });
});

describe("the Atrium app file (criteria 44, 45)", () => {
  it("exports app, theme, data, controls and pages with sorted keys, and nothing private", async () => {
    const { app } = await publishedApp({ view: { userIds: [watcher.userId] }, edit: { userIds: [editor.userId] }, guests: true });
    const out = await appfile.exportAppFile(owner, app.id);
    expect(out.filename).toBe(`${app.slug}.atrium-app.zip`);
    const { readZip } = await import("../zip");
    const entries = readZip(out.bytes);
    const paths = entries.map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(["app.json", "theme.json", "data.json", "controls.json", "pages/home.json"]));
    const text = entries.map((e) => Buffer.from(e.data).toString("utf8")).join("\n");
    for (const banned of [owner.userId, editor.userId, watcher.userId, haId, "accessView", "guest", "http://127.0.0.1:9", "tokenHash"]) expect(text).not.toContain(banned);
    const data = JSON.parse(Buffer.from(entries.find((e) => e.path === "data.json")!.data).toString("utf8"));
    expect(data[0].integration).toEqual({ name: "Home Assistant", packageId: "home-assistant" });
    const raw = Buffer.from(entries.find((e) => e.path === "app.json")!.data).toString("utf8");
    const { stableJson } = await import("../doc");
    expect(raw).toBe(stableJson(JSON.parse(raw)));
    expect(Object.keys(JSON.parse(raw))).toEqual([...Object.keys(JSON.parse(raw))].sort());
    expect(raw.split("\n")[1]).toMatch(/^ {2}"/);
    expect(auditCount("app.exported", app.id)).toBe(1);
  });

  it("imports as a new app with a draft only, mapping integrations; a malformed file is refused naming file and problem", async () => {
    const { app } = await publishedApp({ view: "owner", edit: "owner", guests: false });
    const out = await appfile.exportAppFile(owner, app.id);
    const parsed = appfile.parseAppFile(out.bytes, "lounge.atrium-app.zip");
    expect(parsed.integrations.map((i) => i.key)).toEqual(["home-assistant::Home Assistant"]);
    const r = appfile.importAppFile(owner, parsed, { name: "Imported lounge", mappings: { "home-assistant::Home Assistant": haId } });
    expect(r.app.publishedVersion).toBeUndefined();
    const d = draftOf(r.app.id).doc;
    expect(d.dataSources[0]!.integrationId).toBe(haId);
    expect(d.pages[0]!.root.children![0]!.id).not.toBe("c_lampnodeaa");
    expect(auditCount("app.imported", r.app.id)).toBe(1);
    const count = repo.listApps().length;
    expect(() => appfile.parseAppFile(Buffer.from("not a zip at all, sorry"), "bad.atrium-app.zip")).toThrow(/bad\.atrium-app\.zip could not be imported: it is not a zip file/);
    expect(() => appfile.parseAppFile({ "app.json": { format: "other" } }, "x.zip")).toThrow(/x\.zip could not be imported: app\.json/);
    expect(repo.listApps().length).toBe(count);
    // Publishing the imported draft tags the version "import" (A4.3).
    svc.applyDraftOps({ appId: r.app.id, by: owner, ops: [{ op: "app.update", patch: { name: "Imported lounge" } }] });
    await versions.publishDraft(owner, r.app.id, { expectRev: draftOf(r.app.id).rev });
    expect(repo.getVersion(r.app.id, 1)!.source).toBe("import");
  });
});

describe("agent tools (criterion 46)", () => {
  it("offer no publish, restore, run, access, delete or guest-link tool", () => {
    const names = tools.appTools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["apps.list", "apps.get", "apps.templates", "apps.create", "apps.update", "pages.add", "pages.update", "pages.remove", "pages.move", "drafts.apply", "drafts.changes", "versions.list", "versions.get", "versions.diff", "app_files.export", "app_files.import", "validate", "data_sources.set", "data_sources.remove", "controls.set", "controls.remove"]));
    expect(names.filter((n) => /publish|restore|run|access|delete|guest|discard/.test(n))).toEqual([]);
  });

  it("every edit tool leaves the published version unchanged and shows up in the next review with the agent named", async () => {
    const { app } = await publishedApp({ view: "owner", edit: "owner", guests: false });
    const live = JSON.stringify(repo.getVersion(app.id, 1)!.doc);
    const agent = agentFor(owner);
    const call = async (name: string, input: unknown) => (tools.appTools.find((t) => t.name === name)! as unknown as { handler: (c: unknown, i: unknown) => Promise<unknown> }).handler({ principal: agent, signal: new AbortController().signal }, input);
    await call("apps.update", { appId: app.id, name: "Renamed by agent" });
    await call("pages.add", { appId: app.id, title: "Lights" });
    const pageId = draftOf(app.id).doc.pages[1]!.id;
    await call("pages.update", { appId: app.id, pageId, patch: { title: "Lamps" } });
    await call("pages.move", { appId: app.id, pageId, index: 0 });
    await call("drafts.apply", { appId: app.id, ops: [{ op: "node.add", parentId: rootOf(app.id), node: node("text", { text: "agent" }, "c_agenttoola") }] });
    await call("data_sources.set", { appId: app.id, source: { name: "lights", integrationId: haId, endpointId: "states", refreshSec: 10 } });
    await call("data_sources.remove", { appId: app.id, name: "lights" });
    await call("controls.set", { appId: app.id, control: { id: "k_agentctlaa", label: "Porch", run: { kind: "command", integrationId: haId, commandId: "light.toggle", params: { entityId: "light.porch" } } } });
    await call("controls.remove", { appId: app.id, controlId: "k_agentctlaa" });
    await call("pages.remove", { appId: app.id, pageId });
    const created = (await call("apps.create", { name: "Agent app" })) as { appId: string };
    expect(repo.getApp(created.appId)!.publishedVersion).toBeUndefined();
    const files = await call("app_files.export", { appId: app.id });
    const imported = (await call("app_files.import", { files, mappings: {} })) as { appId: string };
    expect(repo.getApp(imported.appId)!.publishedVersion).toBeUndefined();
    expect(JSON.stringify(repo.getVersion(app.id, 1)!.doc)).toBe(live);
    expect(repo.getApp(app.id)!.publishedVersion).toBe(1);
    const review = versions.reviewDraft(owner, app.id);
    expect(review.authors).toContainEqual(expect.objectContaining({ kind: "agent", name: "Claude" }));
    expect(review.changes.length).toBeGreaterThanOrEqual(10);
    const v = (await call("validate", { appId: app.id })) as { ok: boolean };
    expect(typeof v.ok).toBe("boolean");
  });

  it("refuses agent edits on apps their user cannot edit", async () => {
    const { app } = await publishedApp({ view: { userIds: [watcher.userId] }, edit: "owner", guests: false });
    const t = tools.appTools.find((x) => x.name === "drafts.apply")! as unknown as { handler: (c: unknown, i: unknown) => Promise<unknown> };
    await expect(t.handler({ principal: agentFor(watcher), signal: new AbortController().signal }, { appId: app.id, ops: [{ op: "node.remove", nodeId: "c_lampnodeaa" }] })).rejects.toThrow(/view this app but not change it/);
  });
});

describe("library delete detaches instances in drafts (Wave 2 lead wiring, components SFR-6, A4.1)", () => {
  it("replaces every pinned instance with a plain copy at the same place, in one draft change per app", () => {
    const a = newApp(owner, "Library one");
    const b = newApp(owner, "Library two");
    const lib = {
      id: "l_aaaaaaaaaa", name: "CPU card", tags: [], version: 2, containsCode: false, source: "local" as const, createdBy: "u-owner", createdAt: "", updatedAt: "",
      node: { id: "c_libroot01", type: "stat", props: { label: { $bind: "{{ $param.label }}" }, value: 1 } } as ComponentNode,
      params: [{ name: "label", kind: "text" as const, label: "Label", default: "CPU" }],
    };
    const instance = (id: string, label: string): ComponentNode => ({ id, type: "lib:l_aaaaaaaaaa", name: "CPU card", props: { label }, libraryRef: { componentId: "l_aaaaaaaaaa", version: 2 }, slot: { x: 3, y: 0, w: 3, h: 8 } });
    const other = node("text", { text: "keep me" }, "c_keepmeaaa");
    for (const [app, kids] of [[a, [other, instance("c_instaaaaa", "GPU")]], [b, [instance("c_instbbbbb", "Disk"), instance("c_instccccc", "Net")]]] as const) {
      const d = draftOf(app.id);
      const doc = structuredClone(d.doc);
      doc.pages[0]!.root.children = [...kids];
      db.transaction((tx) => repo.writeDraft(tx, app.id, d.rev, doc, owner));
    }
    const revA = draftOf(a.id).rev;
    const n = svc.detachLibraryInstances("l_aaaaaaaaaa", [lib], owner);
    expect(n).toBe(3);
    const kidsA = draftOf(a.id).doc.pages[0]!.root.children!;
    expect(kidsA.map((k) => k.type)).toEqual(["text", "stat"]);
    expect(kidsA[1]!.libraryRef).toBeUndefined();
    expect(kidsA[1]!.props.label).toBe("GPU");
    expect(kidsA[1]!.slot).toEqual({ x: 3, y: 0, w: 3, h: 8 });
    expect(draftOf(a.id).rev).toBe(revA + 1);
    expect(draftOf(b.id).doc.pages[0]!.root.children!.map((k) => [k.type, k.props.label])).toEqual([["stat", "Disk"], ["stat", "Net"]]);
    const change = repo.pendingChanges(a.id).at(-1)!;
    expect(change.summary).toBe("Detached one copy of CPU card (deleted from the library)");
    expect(change.by).toEqual(owner);
    // Nothing left to detach: a second run changes nothing.
    expect(svc.detachLibraryInstances("l_aaaaaaaaaa", [lib], owner)).toBe(0);
    expect(draftOf(a.id).rev).toBe(revA + 1);
  });
});
