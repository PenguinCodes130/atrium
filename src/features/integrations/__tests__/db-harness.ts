// A throwaway SQLite database with the real schema for service-level tests. Call before importing
// anything that reads env() or opens the database.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function setupTestDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "atrium-int-"));
  process.env.ATRIUM_DATA_DIR = dir;
  process.env.ATRIUM_MASTER_KEY = randomBytes(32).toString("base64"); // test-only key
  process.env.ATRIUM_PUBLIC_URL = "http://127.0.0.1:3113";
  const app = path.resolve(__dirname, "../../../..");
  execFileSync("pnpm", ["exec", "drizzle-kit", "migrate"], { cwd: app, env: { ...process.env, ATRIUM_DATA_DIR: dir }, stdio: "ignore" });
  return dir;
}
