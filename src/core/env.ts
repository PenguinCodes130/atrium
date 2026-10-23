import "server-only";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  ATRIUM_DATA_DIR: z.string().default("./data"),
  ATRIUM_PUBLIC_URL: z.string().url().default("http://127.0.0.1:3102"),
  ATRIUM_OWNER_EMAIL: z.string().optional(),
  ATRIUM_OWNER_PASSWORD: z.string().optional(),
  ATRIUM_RESET_OWNER_PASSWORD: z.string().optional(),
  ATRIUM_MASTER_KEY: z.string().optional(),
  ATRIUM_TRUSTED_PROXIES: z.string().optional(),
  // Architecture 13: extra origins (comma-separated, for LAN-by-IP access) that may frame /sandbox/frame.
  ATRIUM_LAN_ORIGINS: z.string().optional(),
  ATRIUM_ALLOW_DOCKER_SOCKET: z.enum(["true", "false"]).default("false"),
  ATRIUM_N8N_BASE_URL: z.string().optional(),
  ATRIUM_N8N_WEBHOOK_TOKEN: z.string().optional(),
  ATRIUM_N8N_SIGNING_SECRET: z.string().optional(),
  BETTER_AUTH_SECRET: z.string().optional(),
  ATRIUM_GOOGLE_CLIENT_ID: z.string().optional(),
  ATRIUM_GOOGLE_CLIENT_SECRET: z.string().optional(),
  ATRIUM_OIDC_DISCOVERY_URL: z.string().optional(),
  ATRIUM_OIDC_AUTHORIZATION_URL: z.string().optional(),
  ATRIUM_OIDC_TOKEN_URL: z.string().optional(),
  ATRIUM_OIDC_USERINFO_URL: z.string().optional(),
  ATRIUM_OIDC_CLIENT_ID: z.string().optional(),
  ATRIUM_OIDC_CLIENT_SECRET: z.string().optional(),
  ATRIUM_OIDC_NAME: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) cached = schema.parse(process.env);
  return cached;
}

export function dataDir(): string {
  const dir = path.resolve(env().ATRIUM_DATA_DIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Outside production, secrets that would come from the environment are generated once
// into the data folder, so a fresh checkout runs without an env file. Never used in production.
export function devSecret(name: "BETTER_AUTH_SECRET" | "ATRIUM_N8N_SIGNING_SECRET"): string {
  const fromEnv = env()[name];
  if (fromEnv) return fromEnv;
  if (env().NODE_ENV === "production") throw new Error(`${name} must be set in production`);
  const file = path.join(dataDir(), "dev-secrets.json");
  const all: Record<string, string> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  if (!all[name]) {
    all[name] = randomBytes(32).toString("base64url");
    writeFileSync(file, JSON.stringify(all, null, 2), { mode: 0o600 });
  }
  return all[name]!;
}
