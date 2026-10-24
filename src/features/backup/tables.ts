// Which tables a backup carries (architecture 12, Amendment 2, Amendment 4 A4.4). Allow-list first:
// a table is exported only when it is named here, so a new table holding tokens or sessions can never
// slip into a backup by default. `unclassifiedTables()` names every table that is in neither list, so a
// test and the lead's integration check catch a new table that needs a decision.
import "server-only";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { sqlite } from "@/core/db";
import { SYSTEM_INTEGRATION_ID } from "@/features/integrations/repo";

/** Exported, in an order that keeps foreign keys happy on insert (parents first). */
export const DATA_TABLES = [
  "user", "allowlist", "setting", "theme", "theme_draft", "upload",
  "integration", "custom_endpoint", "custom_command", "declarative_package", "credential", "integration_credential",
  // Wave 2.8 recipes (Amendment 9): no secrets by spec criterion 14.
  "recipe",
  // Wave 2.9 (A10.5): kind, open address and headline stats per integration; no secrets.
  "integration_service",
  // app-builder and components (Wave 2): names as the lead prep expects them; confirm after the wave.
  "app", "app_draft", "app_version", "draft_change", "library_component",
  // Later waves (section 12): routes, channels, action definitions.
  "route", "channel", "action_def",
] as const;

/** Included unless the owner switches the audit log off (section 12: control runs travel with the audit log). */
export const AUDIT_TABLES = ["audit_log", "control_run"] as const;

/**
 * Never exported (section 12 and A4.4): sessions, Better Auth accounts (password hashes) and
 * verification rows, TOTP secrets, OAuth clients and tokens, guest links and sessions, invite and reset
 * links, sealed secrets (values travel only in secrets.enc), the cache, one-time credential links,
 * package problems, rate-limit buckets, agent tokens, render tickets and push subscriptions. `read_check`
 * (Wave 2.8) is derived: the daily live check rebuilds it.
 */
export const NEVER_TABLES = [
  "session", "account", "verification", "two_factor", "auth_rate_limit",
  "oauth_client", "oauth_resource", "oauth_client_resource", "oauth_refresh_token", "oauth_access_token", "oauth_consent", "oauth_client_assertion",
  "guest_link", "guest_session", "account_link", "secret", "endpoint_cache", "credential_link", "package_problem", "read_check",
  "agent_token", "render_ticket", "push_subscription", "__drizzle_migrations", "sqlite_sequence",
] as const;

export function existingTables(): string[] {
  return (sqlite().prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
}

export function unclassifiedTables(): string[] {
  const known = new Set<string>([...DATA_TABLES, ...AUDIT_TABLES, ...NEVER_TABLES]);
  return existingTables().filter((t) => !known.has(t));
}

export function columnsOf(table: string): { name: string; notnull: boolean; dflt: unknown; pk: boolean }[] {
  return (sqlite().prepare(`PRAGMA table_info("${table.replace(/"/g, "")}")`).all() as { name: string; notnull: number; dflt_value: unknown; pk: number }[]).map((c) => ({ name: c.name, notnull: !!c.notnull, dflt: c.dflt_value, pk: c.pk > 0 }));
}

/**
 * A10.6: the built-in `atrium` integration is recreated at startup, so a backup never carries it (or a
 * row hanging off it), and an import keeps this instance's own. The column that names it, or null.
 */
export function builtInColumn(table: string): "id" | "integration_id" | null {
  if (table === "integration") return "id";
  return columnsOf(table).some((c) => c.name === "integration_id") ? "integration_id" : null;
}

/** A WHERE clause (with its argument) that leaves out the built-in integration's rows. */
export function notBuiltIn(table: string): { where: string; args: string[] } {
  const col = builtInColumn(table);
  return col ? { where: `WHERE "${col}" IS NOT ?`, args: [SYSTEM_INTEGRATION_ID] } : { where: "", args: [] };
}

export function isBuiltInRow(table: string, row: Record<string, unknown>): boolean {
  const col = builtInColumn(table);
  return !!col && row[col] === SYSTEM_INTEGRATION_ID;
}

type Journal = { entries: { idx: number; tag: string }[] };
function journal(): Journal {
  const p = path.resolve(process.cwd(), "src/db/migrations/meta/_journal.json");
  if (!existsSync(p)) return { entries: [] };
  return JSON.parse(readFileSync(p, "utf8")) as Journal;
}

/** The latest migration id this Atrium knows (manifest `schemaVersion`). */
export function schemaVersion(): string {
  const e = journal().entries;
  return e.length ? e[e.length - 1]!.tag : "none";
}

/** "same", "older" (we can migrate it) or "newer" (refuse) for a backup's schemaVersion. */
export function compareSchema(v: string): "same" | "older" | "newer" {
  const tags = journal().entries.map((x) => x.tag);
  if (v === schemaVersion()) return "same";
  return tags.includes(v) ? "older" : "newer";
}
