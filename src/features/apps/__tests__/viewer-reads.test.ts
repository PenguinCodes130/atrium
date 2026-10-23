// Gauntlet w2-r1 Fix List item 1 (security): a non-editor must never read control run details (command
// params, target ids, workflow input), data source definitions or chrome CSS through the versions read,
// the app file export, or the agent read tools. Editors still get the whole document.
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { App, ComponentNode, Principal } from "@/core/contracts";
import { agentFor, editor, guestOf, owner, seedIntegration, seedUsers, setupAppsDb, viewer, watcher } from "./harness";

vi.mock("@/features/apps/deps", async () => (await import("./harness")).fakeDeps);

setupAppsDb();

let svc: typeof import("../service");
let versions: typeof import("@/features/versions/service");
let repo: typeof import("../repo");
let appfile: typeof import("../appfile");
let tools: typeof import("../tools");
let zip: typeof import("../zip");
let haId: string;

const SECRET_TARGET = "light.secprobe_door_4821";
const CHROME_CSS = ":scope { --secprobe-chrome: 1 }";

beforeAll(async () => {
  await seedUsers();
  haId = await seedIntegration(owner);
  svc = await import("../service");
  versions = await import("@/features/versions/service");
  repo = await import("../repo");
  appfile = await import("../appfile");
  tools = await import("../tools");
  zip = await import("../zip");
});

const node = (type: ComponentNode["type"], props: ComponentNode["props"], id: string): ComponentNode => ({ id, type, props, slot: { x: 0, y: 0, w: 3, h: 8 } });

/** A published app with a command control fixing a literal target, a data source with params, and chrome CSS. */
async function seeded(slug: string): Promise<App> {
  const { app } = svc.createApp(owner, { name: "Front door", slug });
  const root = repo.getDraft(app.id)!.doc.pages[0]!.root.id;
  svc.applyDraftOps({
    appId: app.id,
    by: owner,
    ops: [
      { op: "source.set", source: { name: "ha", integrationId: haId, endpointId: "states", params: { domain: "lock" }, refreshSec: 10 } },
      { op: "control.set", control: { id: "k_secdoorabc", label: "Front door", run: { kind: "command", integrationId: haId, commandId: "light.toggle", params: { entityId: SECRET_TARGET } } } },
      { op: "node.add", parentId: root, node: node("button", { label: "Front door", control: "k_secdoorabc" }, "c_secdoornod") },
      { op: "chrome.update", patch: { css: CHROME_CSS } },
    ],
  });
  // view: the viewer-role user and a member without edit; edit: one member.
  svc.updateAccess(owner, app.id, { view: { userIds: [viewer.userId, watcher.userId] }, edit: { userIds: [editor.userId] }, guests: true });
  await versions.publishDraft(owner, app.id, { expectRev: repo.getDraft(app.id)!.rev });
  return repo.getApp(app.id)!;
}

async function exportText(p: Principal, appId: string): Promise<string> {
  const out = await appfile.exportAppFile(p, appId);
  return zip
    .readZip(out.bytes)
    .map((e) => Buffer.from(e.data).toString("utf8"))
    .join("\n");
}

function tool(name: string) {
  const t = tools.appTools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return (principal: Principal, input: unknown) => (t.handler as (ctx: { principal: Principal }, input: unknown) => Promise<unknown>)({ principal }, input);
}

const NON_EDITORS: [string, Principal][] = [
  ["viewer (role viewer, in the view list)", viewer],
  ["member without edit (in the view list)", watcher],
  ["agent acting for the viewer", agentFor(viewer, ["atrium:read"])],
];

describe("non-editors never read control run details (gauntlet w2-r1 item 1)", () => {
  it("versions read: viewers and members without edit get the viewer projection; editors and the owner get the whole document", async () => {
    const app = await seeded("sec-viewdoc-1");
    for (const [label, p] of NON_EDITORS) {
      const text = JSON.stringify(versions.getVersionDoc(p, app.id, 1));
      expect(text, label).not.toContain(SECRET_TARGET);
      expect(text, label).not.toContain(haId);
      expect(text, label).not.toContain("lock");
      expect(text, label).not.toContain("secprobe-chrome");
      expect(text, label).toContain("Front door"); // the label still shows
    }
    for (const p of [owner, editor]) {
      const text = JSON.stringify(versions.getVersionDoc(p, app.id, 1));
      expect(text).toContain(SECRET_TARGET);
      expect(text).toContain("secprobe-chrome");
    }
  });

  it("a guest reading versions gets its page projection only (and the route refuses guests before this)", async () => {
    const app = await seeded("sec-viewdoc-2");
    const text = JSON.stringify(versions.getVersionDoc(guestOf(app.id), app.id, 1));
    expect(text).not.toContain(SECRET_TARGET);
    expect(text).not.toContain(haId);
  });

  it("app file export: non-editors get a file without run details; editors get the full file; guests are refused", async () => {
    const app = await seeded("sec-viewdoc-3");
    for (const [label, p] of NON_EDITORS) {
      const text = await exportText(p, app.id);
      expect(text, label).not.toContain(SECRET_TARGET);
      expect(text, label).not.toContain("secprobe-chrome");
      expect(text, label).not.toContain('"domain"');
    }
    for (const p of [owner, editor]) {
      const text = await exportText(p, app.id);
      expect(text).toContain(SECRET_TARGET);
      expect(text).toContain("secprobe-chrome");
    }
    await expect(appfile.exportAppFile(guestOf(app.id), app.id)).rejects.toThrow(/Guests cannot export/);
  });

  it("agent read tools (apps.get, versions.get, app_files.export) apply the same projection", async () => {
    const app = await seeded("sec-viewdoc-4");
    const reader = agentFor(viewer, ["atrium:read"]);
    for (const name of ["apps.get", "versions.get", "app_files.export"]) {
      const input = name === "versions.get" ? { appId: app.id, version: 1 } : { appId: app.id };
      expect(JSON.stringify(await tool(name)(reader, input)), name).not.toContain(SECRET_TARGET);
      expect(JSON.stringify(await tool(name)(agentFor(editor), input)), name).toContain(SECRET_TARGET);
    }
  });
});
