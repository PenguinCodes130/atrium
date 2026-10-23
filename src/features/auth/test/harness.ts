// Test harness for auth unit tests: a fresh data folder with the schema migrated, a fixed environment,
// and a tiny cookie-jar client that calls the real /api/auth handler in-process.
import { execFileSync } from "node:child_process";
import { mkdtempSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { markPeerStampInstalledForTests, stampValue } from "../server/peer";

export const PUBLIC_URL = "http://127.0.0.1:3111";
const APP_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
let template: string | undefined;

/**
 * A data folder with every table from the generated migrations. Done once per test file, then copied.
 */
export function freshDataDir(): string {
  if (!template) {
    template = mkdtempSync(path.join(os.tmpdir(), "atrium-auth-template-"));
    for (const cmd of [["migrate"]]) {
      execFileSync("pnpm", ["exec", "drizzle-kit", ...cmd], {
        cwd: APP_ROOT,
        env: { ...process.env, ATRIUM_DATA_DIR: template },
        stdio: "pipe",
      });
    }
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), "atrium-auth-test-"));
  mkdirSync(dir, { recursive: true });
  for (const f of ["atrium.db", "atrium.db-wal", "atrium.db-shm"]) {
    if (existsSync(path.join(template, f))) copyFileSync(path.join(template, f), path.join(dir, f));
  }
  return dir;
}

export type TestEnv = Partial<Record<string, string | undefined>>;

/** Sets the process environment for the next fresh import of the app modules. */
export function setEnv(vars: TestEnv) {
  // Process-wide state the app keeps on globalThis (bootstrap promise, vault alert): reset per boot.
  const g = globalThis as Record<string, unknown>;
  for (const k of ["__atriumBootstrap", "__atriumVaultAlerted", "__atriumVaultListeners"]) delete g[k];
  for (const k of Object.keys(process.env)) if (k.startsWith("ATRIUM_") || k === "BETTER_AUTH_SECRET") delete process.env[k];
  Object.assign(process.env, {
    NODE_ENV: "test",
    ATRIUM_PUBLIC_URL: PUBLIC_URL,
    BETTER_AUTH_SECRET: "unit-test-auth-secret-not-a-real-credential-000",
    ...vars,
  });
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k];
  // In-process requests have no socket: behave as the real server does with the peer stamp installed.
  markPeerStampInstalledForTests(true);
}

export class Client {
  jar = new Map<string, string>();
  /** Extra headers on every request (for example X-Forwarded-For when `ip` is a trusted proxy). */
  extra: Record<string, string> = {};
  /** `ip` is the socket peer, stamped the way the server's peer stamp does (server/peer.ts). */
  constructor(
    private handler: (req: Request) => Promise<Response>,
    public ip = "203.0.113.10",
  ) {}

  cookieHeader(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  headers(extra: Record<string, string> = {}): Headers {
    const h = new Headers({ origin: PUBLIC_URL, "x-atrium-peer": stampValue(this.ip), ...this.extra, ...extra });
    if (this.jar.size) h.set("cookie", this.cookieHeader());
    return h;
  }

  absorb(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const i = pair!.indexOf("=");
      const name = pair!.slice(0, i).trim();
      const value = pair!.slice(i + 1).trim();
      const expired = attrs.some((a) => /max-age=0\b/i.test(a.trim())) || value === "";
      if (expired) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  async call(method: string, url: string, body?: unknown, extra: Record<string, string> = {}): Promise<Response> {
    const h = this.headers(body === undefined ? extra : { "content-type": "application/json", ...extra });
    const res = await this.handler(new Request(new URL(url, PUBLIC_URL), { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" }));
    this.absorb(res);
    return res;
  }

  post(url: string, body: unknown = {}) {
    return this.call("POST", url, body);
  }
  get(url: string) {
    return this.call("GET", url);
  }
}

export { totp, secretFromUri } from "./totp";
