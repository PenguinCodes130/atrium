// Test harness for settings unit tests: a fresh data folder with every table (drizzle-kit migrate into a
// temp folder, done once per test file and then copied), a fixed environment, fresh module imports, and
// a local fake of app-builder's port (tests only; shipped code never fakes it).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppDocument, DraftOp, Principal } from "@/core/contracts";

const APP_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
let template: string | undefined;

export function freshDataDir(): string {
  if (!template) {
    template = mkdtempSync(path.join(os.tmpdir(), "atrium-settings-template-"));
    // The migrations hold every table (0006 has the Wave 2 tables).
    for (const cmd of [["migrate"]]) execFileSync("pnpm", ["exec", "drizzle-kit", ...cmd], { cwd: APP_ROOT, env: { ...process.env, ATRIUM_DATA_DIR: template }, stdio: "pipe" });
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), "atrium-settings-test-"));
  for (const f of ["atrium.db", "atrium.db-wal", "atrium.db-shm"]) if (existsSync(path.join(template, f))) copyFileSync(path.join(template, f), path.join(dir, f));
  return dir;
}

/** Point the app at a data folder (and optionally a master key) for the next fresh import. */
export function useInstance(dir: string, extra: Record<string, string | undefined> = {}) {
  const g = globalThis as Record<string, unknown>;
  for (const k of ["__atriumBootstrap", "__atriumVaultAlerted", "__atriumVaultListeners", "__atriumSettingsAppPort", "__atriumAppAccess"]) delete g[k];
  for (const k of Object.keys(process.env)) if (k.startsWith("ATRIUM_") || k === "BETTER_AUTH_SECRET") delete process.env[k];
  Object.assign(process.env, {
    NODE_ENV: "test",
    ATRIUM_DATA_DIR: dir,
    ATRIUM_PUBLIC_URL: "http://127.0.0.1:3116",
    BETTER_AUTH_SECRET: "unit-test-settings-secret-not-a-real-credential",
  });
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

export const OWNER: Principal = { kind: "user", userId: "u-owner", role: "owner", via: "session" };
export const MEMBER: Principal = { kind: "user", userId: "u-member", role: "member", via: "session" };
export const VIEWER: Principal = { kind: "user", userId: "u-viewer", role: "viewer", via: "session" };
export const AGENT: Principal = { kind: "agent", userId: "u-member", role: "member", via: "pat", tokenId: "tok1", agentName: "Claude", scopes: ["atrium:read", "atrium:edit"] };

export function doc(themeRef: AppDocument["theme"], pages: { id: string; theme?: AppDocument["theme"] }[] = [{ id: "p_home" }]): AppDocument {
  return {
    format: "atrium-app",
    formatVersion: 1,
    app: { name: "Test", homePage: pages[0]!.id, pageOrder: pages.map((p) => p.id) },
    theme: themeRef,
    chrome: { layout: "topbar" },
    dataSources: [],
    controls: [],
    pages: pages.map((p) => ({ id: p.id, slug: p.id.slice(2), title: p.id, inNav: true, ...(p.theme ? { theme: p.theme } : {}), root: { id: `c_${p.id}`, type: "stack", props: {}, children: [] } })),
  };
}

/** A local fake of app-builder's port: an in-memory app list with real applyOps semantics for theme ops. */
export function fakePort(apps: { appId: string; name: string; draft: AppDocument; published?: AppDocument }[]) {
  const state = apps.map((a) => ({ ...a, rev: 1, published: a.published ? { version: 1, doc: a.published } : undefined }));
  const calls: { appId: string; rev: number; ops: DraftOp[] }[] = [];
  return {
    calls,
    state,
    port: {
      async listApps() {
        return state.map((a) => ({ appId: a.appId, slug: a.appId, name: a.name, draftRev: a.rev, draft: a.draft, ...(a.published ? { published: a.published } : {}) }));
      },
      async getApp(id: string) {
        const a = state.find((x) => x.appId === id);
        return a ? { appId: a.appId, slug: a.appId, name: a.name, draftRev: a.rev, draft: a.draft, ...(a.published ? { published: a.published } : {}) } : null;
      },
      async applyOps(appId: string, rev: number, ops: DraftOp[]) {
        const a = state.find((x) => x.appId === appId)!;
        if (rev !== a.rev) throw Object.assign(new Error("conflict"), { code: "conflict", rev: a.rev });
        calls.push({ appId, rev, ops });
        for (const op of ops) {
          if (op.op === "theme.set") a.draft = { ...a.draft, theme: op.theme };
          if (op.op === "page.update") a.draft = { ...a.draft, pages: a.draft.pages.map((p) => (p.id === op.pageId ? { ...p, ...op.patch } as typeof p : p)) };
        }
        a.rev++;
        return { rev: a.rev };
      },
    },
  };
}
