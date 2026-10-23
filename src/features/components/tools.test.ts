// Agent tools (criteria 67, 68) against a local fake of app-builder's draft backend (tests only).
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { AppDocument, ComponentNode, DraftOp, Principal, ToolDef } from "@/core/contracts";
import { AtriumError } from "@/core/errors";

const member: Principal = { kind: "agent", userId: "u_member", role: "member", via: "pat", tokenId: "t1", agentName: "Claude", scopes: ["atrium:read", "atrium:edit"] };
const signal = new AbortController().signal;

class FakeConflict extends AtriumError {
  constructor(readonly currentRev: number) {
    super("Someone else changed this draft first.", 409, "conflict");
  }
}

function makeDoc(): AppDocument {
  return {
    format: "atrium-app", formatVersion: 1, app: { name: "Lab", homePage: "p_aaaaaaaaaa", pageOrder: ["p_aaaaaaaaaa"] }, theme: { themeId: "control-room" }, chrome: { layout: "none" },
    dataSources: [{ name: "cpu", integrationId: "i1", endpointId: "e1", refreshSec: 30 }],
    controls: [{ id: "k_lampaaaaaa", label: "Lamp", run: { kind: "command", integrationId: "i1", commandId: "light.toggle" } }],
    pages: [{ id: "p_aaaaaaaaaa", slug: "home", title: "Home", inNav: true, root: { id: "c_rootaaaaaa", type: "grid", props: {}, children: [{ id: "c_htmlaaaaaa", type: "html", name: "Block", props: { html: "", data: {}, controls: [], height: "auto" } }] } }],
  };
}

let tools: ToolDef<any, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
let state: { rev: number; doc: AppDocument; applied: DraftOp[][] };
const call = (name: string, input: unknown) => {
  const t = tools.find((x) => x.name === name)!;
  return t.handler({ principal: member, signal }, t.input.parse(input));
};

function walk(n: ComponentNode, fn: (n: ComponentNode) => void) {
  fn(n);
  n.children?.forEach((c) => walk(c, fn));
}

beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "atrium-ctools-"));
  process.env.ATRIUM_DATA_DIR = dir;
  const app = path.resolve(__dirname, "../../..");
  execFileSync("pnpm", ["exec", "drizzle-kit", "migrate"], { cwd: app, env: { ...process.env, ATRIUM_DATA_DIR: dir }, stdio: "ignore" });
  const mod = await import("./tools");
  tools = mod.componentTools;
  state = { rev: 1, doc: makeDoc(), applied: [] };
  mod.registerComponentToolsBackend({
    getDraft: () => ({ rev: state.rev, doc: structuredClone(state.doc) }),
    applyOps: (_p, _a, ops, expectRev) => {
      if (expectRev !== undefined && expectRev !== state.rev) throw new FakeConflict(state.rev);
      const changed: string[] = [];
      for (const op of ops) {
        if (op.op === "node.add") walk(state.doc.pages[0]!.root, (n) => { if (n.id === op.parentId) (n.children ??= []).push(op.node); });
        if (op.op === "node.update") walk(state.doc.pages[0]!.root, (n) => { if (n.id === op.nodeId) Object.assign(n, op.patch); });
        changed.push("nodeId" in op ? op.nodeId : "node" in op ? op.node.id : "");
      }
      state.applied.push(ops);
      state.rev += 1;
      return { rev: state.rev, changed };
    },
    readSource: async (d) => (d.name === "cpu" ? { state: "fresh", data: { kind: "stat", value: 41.27, label: "CPU", unit: "%" } } : { state: "empty" }),
  });
}, 120_000);

describe("components tools", () => {
  it("every 3.7 tool exists with its 9b.1 scope and effect", () => {
    const want: Record<string, [string, string]> = {
      "components.catalog": ["atrium:read", "none"], "components.schema": ["atrium:read", "none"], "components.add": ["atrium:edit", "draft"], "components.update": ["atrium:edit", "draft"],
      "components.move": ["atrium:edit", "draft"], "components.remove": ["atrium:edit", "draft"], "components.find": ["atrium:read", "none"], "components.suggest": ["atrium:read", "none"],
      "bindings.test": ["atrium:read", "none"], "styles.set": ["atrium:edit", "draft"], "styles.tokens": ["atrium:read", "none"], "html.set": ["atrium:edit", "draft"],
      "library.list": ["atrium:read", "none"], "library.get": ["atrium:read", "none"], "library.save": ["atrium:edit", "none"], "library.insert": ["atrium:edit", "draft"], "library.update_instance": ["atrium:edit", "draft"],
    };
    for (const [name, [scope, effect]] of Object.entries(want)) {
      const t = tools.find((x) => x.name === name);
      expect(t, name).toBeDefined();
      expect([t!.scope, t!.effect], name).toEqual([scope, effect]);
      expect(t!.description.length).toBeGreaterThan(20);
    }
    expect(tools.some((t) => /publish|run_control|controls\.run|secret/.test(t.name))).toBe(false);
  });
  it("adds a component to the draft and returns the new revision and id", async () => {
    const r = (await call("components.add", { appId: "a", parentId: "c_rootaaaaaa", type: "stat", props: { data: { $bind: "{{ cpu }}" } } })) as { rev: number; changed: string[]; nodeId: string };
    expect(r.rev).toBe(2);
    expect(r.changed).toContain(r.nodeId);
    expect(state.applied.at(-1)![0]!.op).toBe("node.add");
  });
  it("answers conflict with the current revision for a stale expected revision", async () => {
    await expect(call("components.add", { appId: "a", parentId: "c_rootaaaaaa", type: "text", expectRev: 1 })).rejects.toMatchObject({ code: "conflict", currentRev: state.rev });
  });
  it("answers invalid naming the field for a bad prop", async () => {
    await expect(call("components.add", { appId: "a", parentId: "c_rootaaaaaa", type: "chart", props: { kind: "pie" } })).rejects.toMatchObject({ code: "invalid", problems: [expect.objectContaining({ where: expect.objectContaining({ field: "kind" }) })] });
  });
  it("bindings.test returns the same value and error text as the Data panel's engine", async () => {
    const { evaluateTemplate } = await import("./bindings");
    const ok = (await call("bindings.test", { appId: "a", template: "{{ cpu.value | round(1) }}%" })) as { ok: boolean; value: unknown };
    expect(ok).toMatchObject({ ok: true, value: "41.3%" });
    const bad = (await call("bindings.test", { appId: "a", template: "{{ cpu.value + }}" })) as { ok: boolean; error: { message: string } };
    const local = evaluateTemplate("{{ cpu.value + }}", { $data: {}, $page: { id: "", slug: "", title: "" }, $app: { id: "", slug: "", name: "" }, $user: { kind: "user" } } as never);
    expect(bad.ok).toBe(false);
    expect(!local.ok && local.error.message).toBe(bad.error.message);
  });
  it("suggests components bound to a source that pass validate", async () => {
    const r = (await call("components.suggest", { appId: "a", source: "cpu" })) as { components: ComponentNode[] };
    expect(r.components[0]!.type).toBe("stat");
    expect(JSON.stringify(r.components[0]!.props)).toContain("{{ cpu }}");
  });
  it("refuses an html field over 64 KB naming the limit", async () => {
    await expect(call("html.set", { appId: "a", nodeId: "c_htmlaaaaaa", js: "x".repeat(70_000) })).rejects.toMatchObject({ code: "invalid", message: expect.stringMatching(/64 KB/) });
  });
  it("styles.set reports what the sanitiser removed", async () => {
    const r = (await call("styles.set", { appId: "a", nodeId: "c_htmlaaaaaa", css: ".x { position: fixed }" })) as { removed: string[] };
    expect(r.removed.join(" ")).toMatch(/position: fixed/);
  });
  it("saves to the library and inserts an instance; outputs carry no secrets", async () => {
    const saved = (await call("library.save", { appId: "a", nodeId: "c_rootaaaaaa", name: "Whole grid" })) as { componentId: string; version: number };
    expect(saved.version).toBe(1);
    const got = (await call("library.get", { componentId: saved.componentId })) as { component: Record<string, unknown> };
    expect(got.component.createdBy).toBeUndefined();
    const ins = (await call("library.insert", { appId: "a", componentId: saved.componentId, parentId: "c_rootaaaaaa" })) as { nodeId: string };
    expect(ins.nodeId).toMatch(/^c_/);
    const all = JSON.stringify(await Promise.all(["components.catalog", "library.list"].map((n) => call(n, {}))));
    expect(all).not.toMatch(/token|password|secret|apiKey/i);
  });
});
