// Library: parameter rewriting, instances, detach, the file format and the store (temp database).
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { AppDocument, ComponentNode, LibraryComponent, Principal, ShapedData } from "@/core/contracts";
import { parameterize, expandInstance, detachInstance, instanceNodeFor, libraryDiff, findNodeDeep } from "@/features/components/library-instance";
import { resolveGuestValues } from "@/features/components/page";
import { parseComponentFile, toComponentFile, CONTAINS_CODE_NOTICE } from "./file";

const owner: Principal = { kind: "user", userId: "u_owner", role: "owner", via: "session" };
const member: Principal = { kind: "user", userId: "u_member", role: "member", via: "session" };
const other: Principal = { kind: "user", userId: "u_other", role: "member", via: "session" };
const viewer: Principal = { kind: "user", userId: "u_viewer", role: "viewer", via: "session" };
const guest: Principal = { kind: "guest", guestLinkId: "g1", appId: "a1", label: "Guest", via: "guest-link" };

const card: ComponentNode = {
  id: "c_cardaaaaaa", type: "card", name: "Server card", props: { title: "pve1" }, overrideTheme: true, style: { root: { borderRadius: 12 } },
  children: [
    { id: "c_statcpuaaa", type: "stat", props: { value: { $bind: "{{ cpu.value | round(1) }}" }, label: "CPU", unit: "%" } },
    { id: "c_buttonaaaa", type: "button", props: { label: "Restart", control: "k_xxxxxxxxxx" } },
    { id: "c_htmlaaaaaa", type: "html", name: "Mini", props: { html: "<p></p>", data: { v: { $bind: "{{ cpu.value }}" } }, controls: ["k_xxxxxxxxxx"], height: "auto" } },
  ],
};
const appDoc = { dataSources: [{ name: "cpu", integrationId: "i", endpointId: "e", refreshSec: 30 }, { name: "gpu", integrationId: "i", endpointId: "e2", refreshSec: 30 }], controls: [{ id: "k_xxxxxxxxxx", label: "Restart pve1", run: { kind: "workflow" as const, actionId: "a" } }, { id: "k_yyyyyyyyyy", label: "Restart pve2", run: { kind: "workflow" as const, actionId: "a" } }] };

describe("parameters (criterion 59, pure part)", () => {
  const { node, params } = parameterize(card, appDoc, [{ nodeId: "c_cardaaaaaa", prop: "title", name: "title", kind: "text" }]);
  it("turns data sources and controls into parameters", () => {
    expect(params.map((p) => `${p.kind}:${p.name}`)).toEqual(["text:title", "data:cpu", "control:control1"]);
    expect(params.find((p) => p.name === "control1")!.default).toBe("k_xxxxxxxxxx");
    expect(params.find((p) => p.name === "title")!.default).toBe("pve1");
    const json = JSON.stringify(node);
    expect(json).toContain("{{ $param.cpu.value | round(1) }}");
    expect(json).not.toMatch(/"\{\{ cpu/);
    expect(json).not.toContain('"k_xxxxxxxxxx"');
  });
  const lib: LibraryComponent = { id: "l_aaaaaaaaaa", name: "Server card", tags: [], version: 1, node, params, containsCode: true, source: "local", createdBy: "u", createdAt: "", updatedAt: "" };
  it("an instance with another source renders that source (criterion 60)", () => {
    const inst = { ...instanceNodeFor(lib), id: "c_instanceaa", props: { cpu: "gpu", control1: "k_yyyyyyyyyy", title: "pve2" } };
    const d: AppDocument = { format: "atrium-app", formatVersion: 1, app: { name: "B", homePage: "p_aaaaaaaaaa", pageOrder: ["p_aaaaaaaaaa"] }, theme: { themeId: "control-room" }, chrome: { layout: "none" }, ...appDoc, pages: [{ id: "p_aaaaaaaaaa", slug: "h", title: "H", inNav: true, root: { id: "c_rootaaaaaa", type: "stack", props: {}, children: [inst] } }] };
    const values = resolveGuestValues(d, "p_aaaaaaaaaa", { cpu: { kind: "stat", value: 10, label: "c" }, gpu: { kind: "stat", value: 77.77, label: "g" } } as Record<string, ShapedData>, { library: { "l_aaaaaaaaaa@1": lib } });
    expect(Object.entries(values).find(([k]) => k.endsWith(":value"))?.[1]).toBe(77.8);
    const expanded = expandInstance(inst, lib);
    expect(JSON.stringify(expanded)).toContain('"control":"k_yyyyyyyyyy"');
    expect(JSON.stringify(expanded)).toContain('"controls":["k_yyyyyyyyyy"]');
    expect(expanded.id).toMatch(/^c_[a-z2-7]{10}$/);
    expect(expandInstance(inst, lib).id).toBe(expanded.id); // stable
    expect(findNodeDeep(d.pages[0]!.root, expanded.children![1]!.id, { "l_aaaaaaaaaa@1": lib })?.type).toBe("button");
  });
  it("detach leaves a plain subtree with fresh ids and no library reference (criterion 61)", () => {
    const inst = { ...instanceNodeFor(lib), props: { cpu: "gpu", control1: "k_yyyyyyyyyy", title: "pve2" } };
    const plain = detachInstance(inst, lib);
    const json = JSON.stringify(plain);
    expect(json).not.toContain("$param");
    expect(json).not.toContain("libraryRef");
    expect(json).toContain("{{ gpu.value | round(1) }}");
    expect(plain.props.title).toBe("pve2");
    const ids: string[] = [];
    const walk = (n: ComponentNode) => { ids.push(n.id); n.children?.forEach(walk); };
    walk(plain);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("c_cardaaaaaa");
  });
  it("describes version changes as readable lines", () => {
    const v2 = { node: { ...node, children: [...(node.children ?? []), { id: "c_newtextaaa", type: "text" as const, props: { text: "hi" } }] }, params };
    expect(libraryDiff(lib, v2)).toContain("Adds text c_newtextaaa".replace("c_newtextaaa", "text"));
  });
});

describe("component file (criteria 63, 64)", () => {
  it("round-trips without the creator", () => {
    const c: LibraryComponent = { id: "l_bbbbbbbbbb", name: "Card", description: "d", tags: ["x"], version: 3, node: card, params: [], containsCode: true, source: "local", createdBy: "u_secret_person", createdAt: "2026-10-18T00:00:00.000Z", updatedAt: "2026-10-18T00:00:00.000Z" };
    const text = toComponentFile(c);
    expect(text).not.toContain("u_secret_person");
    expect(text).not.toContain("createdBy");
    const r = parseComponentFile(text);
    expect(r.ok).toBe(true);
  });
  it("refuses malformed files naming the problem", () => {
    expect(parseComponentFile("{nope")).toEqual({ ok: false, problem: "This file is not valid JSON." });
    expect(parseComponentFile(JSON.stringify({ format: "atrium-app" }))).toMatchObject({ ok: false, problem: expect.stringMatching(/not an Atrium component file/) });
    const r = parseComponentFile(JSON.stringify({ format: "atrium-component", formatVersion: 1, id: "l_x", name: "x", tags: [], version: 1, node: { id: "c", type: "stat" }, params: [], containsCode: false, source: "local", createdAt: "", updatedAt: "" }));
    expect(r).toMatchObject({ ok: false, problem: expect.stringMatching(/node\.props/) });
  });
  it("has the code notice text", () => {
    expect(CONTAINS_CODE_NOTICE).toBe("Contains code. It runs in the sandbox and sees only the data you give it.");
  });
});

describe("library store (criteria 59, 61, 63 to 66) on a temp database", () => {
  let repo: typeof import("./repo");
  let auditRows: () => { event: string; detail: string | null }[];
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "atrium-lib-"));
    process.env.ATRIUM_DATA_DIR = dir;
    const app = path.resolve(__dirname, "../../..");
    execFileSync("pnpm", ["exec", "drizzle-kit", "migrate"], { cwd: app, env: { ...process.env, ATRIUM_DATA_DIR: dir }, stdio: "ignore" });
    repo = await import("./repo");
    const { sqlite } = await import("@/core/db");
    auditRows = () => sqlite().prepare("select event, detail from audit_log order by at").all() as { event: string; detail: string | null }[];
  }, 120_000);

  const input = (extra: Partial<Parameters<typeof import("./repo").saveLibrary>[1]> = {}) => ({ name: "Server card", description: "CPU and restart", tags: ["homelab"], node: card, sources: ["cpu", "gpu"], controls: appDoc.controls.map((c) => ({ id: c.id, label: c.label })), ...extra });

  it("saves version 1, then version 2, writing library.saved", () => {
    const v1 = repo.saveLibrary(member, input());
    expect(v1.version).toBe(1);
    expect(v1.params.map((p) => p.kind).sort()).toEqual(["control", "data"]);
    expect(v1.containsCode).toBe(true);
    const v2 = repo.saveLibrary(member, input({ componentId: v1.id }));
    expect(v2.version).toBe(2);
    expect(auditRows().filter((r) => r.event === "library.saved").length).toBe(2);
    expect(repo.getLibrary(member, v1.id, 1).component.version).toBe(1);
    expect(repo.getLibrary(member, v1.id).latest.version).toBe(2);
  });
  it("is shared, but only the creator and the owner update or delete", async () => {
    const c = repo.saveLibrary(member, input({ name: "Mine" }));
    expect(repo.listLibrary(other).some((x) => x.id === c.id && !x.canUpdate)).toBe(true);
    expect(repo.listLibrary(owner).find((x) => x.id === c.id)!.canUpdate).toBe(true);
    expect(() => repo.saveLibrary(other, input({ componentId: c.id }))).toThrow(/Only the person/);
    await expect(repo.deleteLibrary(other, c.id)).rejects.toThrow(/Only the person/);
  });
  it("viewers and guests get no library (criterion 66)", () => {
    expect(() => repo.listLibrary(viewer)).toThrow(/Viewers/);
    expect(() => repo.listLibrary(guest)).toThrow(/Guests/);
  });
  it("exports and re-imports an identical component marked imported, writing library.imported", () => {
    const c = repo.saveLibrary(member, input({ name: "Exported" }));
    const file = toComponentFile(c);
    const parsed = parseComponentFile(file);
    if (!parsed.ok) throw new Error(parsed.problem);
    // The same file into the same instance gets a new id (the original still exists).
    const imp = repo.importLibrary(owner, parsed.file);
    expect(imp.source).toBe("imported");
    expect(imp.id).not.toBe(c.id);
    const strip = (x: LibraryComponent) => ({ description: x.description, tags: x.tags, version: x.version, node: x.node, params: x.params, containsCode: x.containsCode });
    expect(strip(imp)).toEqual(strip(c));
    // The name is taken by the original, so the copy is "Exported (2)" (gauntlet w2-r1 Fix 15).
    expect(imp.name).toBe("Exported (2)");
    expect(auditRows().some((r) => r.event === "library.imported")).toBe(true);
  });
  it("import identity: the file names its origin; re-import offers an update or saves name (2), (3) (Fix 15)", () => {
    const c = repo.saveLibrary(member, input({ name: "cu-card" }));
    const parsed = parseComponentFile(toComponentFile(c));
    if (!parsed.ok) throw new Error(parsed.problem);
    expect(repo.importMatch(member, parsed.file)).toMatchObject({ id: c.id, name: "cu-card", version: 1, canUpdate: true });
    expect(repo.importMatch(other, parsed.file)!.canUpdate).toBe(false);
    expect(repo.freeName("cu-card")).toBe("cu-card (2)");
    const a = repo.importLibrary(member, parsed.file);
    const b = repo.importLibrary(member, parsed.file);
    expect([a.name, b.name]).toEqual(["cu-card (2)", "cu-card (3)"]);
    // Update: the file becomes the next version of the component it came from, same id.
    const up = repo.importLibrary(member, parsed.file, { mode: "update" });
    expect(up.id).toBe(c.id);
    expect(up.version).toBe(2);
    expect(() => repo.importLibrary(other, parsed.file, { mode: "update" })).toThrow(/Only the person/);
    const row = auditRows().filter((r) => r.event === "library.imported").pop()!;
    expect(JSON.parse(row.detail!)).toMatchObject({ updated: true, version: 2 });
  });
  it("deletes, detaching instances through the registered handler, writing library.deleted with the count", async () => {
    const c = repo.saveLibrary(member, input({ name: "Doomed" }));
    repo.registerLibraryDeleteHandler(async (id) => (id === c.id ? 3 : 0));
    const r = await repo.deleteLibrary(owner, c.id);
    expect(r.detached).toBe(3);
    expect(repo.listLibrary(member).some((x) => x.id === c.id)).toBe(false);
    // Pinned published apps keep rendering: the version is still readable.
    expect(repo.getLibrary(member, c.id, 1).deleted).toBe(true);
    const row = auditRows().find((x) => x.event === "library.deleted")!;
    expect(JSON.parse(row.detail!)).toMatchObject({ detached: 3 });
  });
});
