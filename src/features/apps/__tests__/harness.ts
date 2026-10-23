// Test harness for app-builder: a throwaway SQLite database with the migrated schema (0006 holds
// app-builder's tables), seeded users and integrations, and a local
// fake of the Wave 2 cross-subsystem exports (components, themes, uploads, settings) used ONLY in tests.
// Test-only values throughout; none are real credentials.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AppDocument, ComponentNode, DataSourceDef, Principal, Problem, ShapedData, Theme } from "@/core/contracts";
import { detachInstance as realDetachInstance } from "@/features/components/library-instance";

const APP_ROOT = path.resolve(__dirname, "../../../..");

export function setupAppsDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "atrium-apps-"));
  process.env.ATRIUM_DATA_DIR = dir;
  process.env.ATRIUM_MASTER_KEY = randomBytes(32).toString("base64");
  process.env.ATRIUM_PUBLIC_URL = "http://127.0.0.1:3115";
  const env = { ...process.env, ATRIUM_DATA_DIR: dir };
  execFileSync("pnpm", ["exec", "drizzle-kit", "migrate"], { cwd: APP_ROOT, env, stdio: "ignore" });
  return dir;
}

export const owner: Extract<Principal, { kind: "user" }> = { kind: "user", userId: "u-owner", role: "owner", via: "session" };
export const editor: Extract<Principal, { kind: "user" }> = { kind: "user", userId: "u-editor", role: "member", via: "session" };
export const watcher: Extract<Principal, { kind: "user" }> = { kind: "user", userId: "u-watcher", role: "member", via: "session" };
export const outsider: Extract<Principal, { kind: "user" }> = { kind: "user", userId: "u-outsider", role: "member", via: "session" };
export const viewer: Extract<Principal, { kind: "user" }> = { kind: "user", userId: "u-viewer", role: "viewer", via: "session" };
export const agentFor = (u: Extract<Principal, { kind: "user" }>, scopes: ("atrium:read" | "atrium:edit")[] = ["atrium:read", "atrium:edit"]): Extract<Principal, { kind: "agent" }> => ({ kind: "agent", userId: u.userId, role: u.role, via: "pat", tokenId: `t-${u.userId}`, agentName: "Claude", scopes });
export const guestOf = (appId: string, id = "gl-1"): Extract<Principal, { kind: "guest" }> => ({ kind: "guest", guestLinkId: id, appId, label: "Guest room, Sam", via: "guest-link" });

export const USERS = [
  { id: owner.userId, name: "Tristan Owner", email: "owner@atrium.test", role: "owner" },
  { id: editor.userId, name: "Erin Editor", email: "editor@atrium.test", role: "member" },
  { id: watcher.userId, name: "Wes Watcher", email: "watcher@atrium.test", role: "member" },
  { id: outsider.userId, name: "Olly Outsider", email: "outsider@atrium.test", role: "member" },
  { id: viewer.userId, name: "Vic Viewer", email: "viewer@atrium.test", role: "viewer" },
] as const;

export async function seedUsers(): Promise<void> {
  const { sqlite } = await import("@/core/db");
  const now = Date.now();
  const stmt = sqlite().prepare("INSERT OR IGNORE INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)");
  USERS.forEach((u, i) => stmt.run(u.id, u.name, u.email, u.role, now + i, now + i));
}

/** A Home Assistant integration row (no secret needed: nothing here runs a command). */
export async function seedIntegration(createdBy = owner, name = "Home Assistant"): Promise<string> {
  const repo = await import("@/features/integrations/repo");
  const row = repo.insertIntegration({ packageId: "home-assistant", name, config: { baseUrl: "http://127.0.0.1:9", verifyTls: true }, status: "active", principal: createdBy });
  return row.id;
}

// ---- The local fake of components and settings (tests only) ----

const CONTAINERS = new Set(["grid", "stack", "card", "tabs", "section", "repeat"]);
const ROOT = /\{\{\s*([a-z][a-z0-9_]*)/g;

function templatesOf(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => templatesOf(x, out));
  else if (v && typeof v === "object") {
    const b = (v as { $bind?: unknown }).$bind;
    if (typeof b === "string") out.push(b);
    else Object.values(v).forEach((x) => templatesOf(x, out));
  }
  return out;
}

function nodesOf(n: ComponentNode, out: ComponentNode[] = []): ComponentNode[] {
  out.push(n);
  for (const c of n.children ?? []) nodesOf(c, out);
  return out;
}

export const fakeTheme = (id: string, accent = "#E9B949"): Theme => ({ atriumTheme: "2", id, name: id, author: "test", version: "1", mode: "light", tokens: { color: { accent } } as never });
export const themeEdits = new Map<string, string>();

export const fakeDeps = {
  componentDefs: () => [],
  getComponentDef: (type: string) => (type.startsWith("lib:") || type.startsWith("pkg:") ? undefined : { type, container: CONTAINERS.has(type) }),
  validateNodes: (doc: AppDocument): Problem[] => {
    const out: Problem[] = [];
    for (const page of doc.pages)
      for (const n of nodesOf(page.root)) {
        if (n.type === "stat" && n.props.decimals !== undefined && typeof n.props.decimals !== "number") out.push({ severity: "error", code: "props.invalid", where: { pageId: page.id, nodeId: n.id, field: "decimals" }, message: "decimals must be a number" });
        if (!["grid", "stack", "card", "tabs", "section", "repeat", "stat", "chart", "table", "list", "status", "gauge", "progress", "heading", "text", "image", "icon", "link", "divider", "spacer", "clock", "button", "toggle", "slider", "select", "html"].includes(n.type) && !n.type.startsWith("lib:")) out.push({ severity: "error", code: "type.unknown", where: { pageId: page.id, nodeId: n.id }, message: `Unknown component type ${n.type}` });
      }
    return out;
  },
  sourcesUsed: (doc: AppDocument, pageId: string): DataSourceDef[] => {
    const page = doc.pages.find((p) => p.id === pageId);
    if (!page) return [];
    const names = new Set<string>();
    for (const n of nodesOf(page.root)) for (const t of templatesOf(n.props)) for (const m of t.matchAll(ROOT)) names.add(m[1]!);
    return doc.dataSources.filter((s) => names.has(s.name));
  },
  resolveGuestValues: (doc: AppDocument, pageId: string, sources: Record<string, ShapedData>): Record<string, unknown> => {
    // A tiny resolver for `{{ src.find("entity_id", "x").state }}` and `{{ src.value }}`, enough for the guest tests.
    const page = doc.pages.find((p) => p.id === pageId);
    const out: Record<string, unknown> = {};
    if (!page) return out;
    for (const n of nodesOf(page.root))
      for (const [prop, v] of Object.entries(n.props)) {
        const t = v && typeof v === "object" ? (v as { $bind?: string }).$bind : undefined;
        if (!t) continue;
        const find = /\{\{\s*([a-z_]+)\.find\("([a-z_]+)",\s*"([^"]+)"\)\.([a-z_]+)\s*\}\}/.exec(t);
        if (find) {
          const s = sources[find[1]!];
          const row = s && s.kind === "table" ? s.rows.find((r) => r[find[2]!] === find[3]) : undefined;
          out[`${n.id}:${prop}`] = row ? row[find[4]!] : null;
        }
      }
    return out;
  },
  insertCatalogue: () => [],
  suggestComponent: () => ({ id: "c_aaaaaaaaaa", type: "stat", props: {} }),
  resolveTheme: async () => ({ theme: fakeTheme("control-room") }),
  snapshotTheme: async (ref: { themeId?: string; inline?: Theme }) => (ref.inline ? ref.inline : fakeTheme(ref.themeId ?? "control-room", themeEdits.get(ref.themeId ?? "") ?? "#E9B949")),
  canvasThemeCss: () => "",
  readUpload: () => null,
  saveUpload: (_p: Principal, _b: Buffer, name: string) => ({ id: "x", path: `/uploads/${"b".repeat(20)}.png`, name, mime: "image/png", kind: "image", size: 1 }),
  signImageUrl: () => null,
  registerAppPort: () => {},
  getInstanceSettings: () => ({ versionRetention: "all" }),
  compileDocumentCss: () => ({}),
  compileChromeCss: (chrome: { css?: string }) => ({ css: "", removed: /position:\s*fixed/.test(chrome.css ?? "") ? ["position: fixed (not allowed in app CSS)"] : [] }),
  compileNodeCss: (node: { css?: string }) => ({ css: "", removed: /position:\s*fixed/.test(node.css ?? "") ? ["position: fixed (not allowed in app CSS)"] : [] }),
  canvasThemeCssWithReport: () => ({ css: "", dropped: [] }),
  // Wave 2 lead wiring: the real detach (pure), no library store, no tool registry.
  detachInstance: realDetachInstance,
  libraryForDoc: () => ({}),
  importLibrary: () => {
    throw new Error("no library store in the fake");
  },
  toComponentFile: (c: unknown) => `${JSON.stringify(c, null, 2)}\n`,
  parseComponentFile: () => ({ ok: false as const, problem: "no library store in the fake" }),
  CONTAINS_CODE_NOTICE: "Contains code.",
  registerLibraryDeleteHandler: () => {},
  registerComponentToolsBackend: () => {},
};
