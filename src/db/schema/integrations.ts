// Owned by the integrations subsystem (architecture v3 sections 3, 3.1, 6.2 and 9b).
// Secret values never live here: they are sealed in the vault's `secret` table.
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const integrations = sqliteTable(
  "integration",
  {
    id: text("id").primaryKey(),
    packageId: text("package_id").notNull(),
    name: text("name").notNull(),
    config: text("config", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    // Custom API only: the secret fields found by curl parsing (labels and placements, never values).
    secretFields: text("secret_fields", { mode: "json" }).$type<{ key: string; label: string; hint: string; auth: unknown }[]>().notNull().default([]),
    status: text("status", { enum: ["draft", "active", "disabled"] }).notNull(),
    // v3 (section 3.1): off by default; only the owner and the creator may bind an unshared integration.
    shared: integer("shared", { mode: "boolean" }).notNull().default(false),
    lastHealth: text("last_health", { mode: "json" }).$type<{ status: "ok" | "degraded" | "down"; latencyMs: number; message?: string; version?: string; checkedAt: string } | null>(),
    createdBy: text("created_by", { enum: ["user", "agent", "builtin-agent"] }).notNull(),
    createdById: text("created_by_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("integration_package_idx").on(t.packageId)],
);

export const customEndpoints = sqliteTable(
  "custom_endpoint",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id").notNull().references(() => integrations.id, { onDelete: "cascade" }),
    endpointId: text("endpoint_id").notNull(),
    record: text("record", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("custom_endpoint_unique_idx").on(t.integrationId, t.endpointId)],
);

export const declarativePackages = sqliteTable("declarative_package", {
  id: text("id").primaryKey(),
  manifest: text("manifest", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  endpoints: text("endpoints", { mode: "json" }).$type<unknown[]>().notNull(),
  // v3 (section 3.1): the published CustomCommand records (commands.json) and a pending change, if any.
  commands: text("commands", { mode: "json" }).$type<unknown[]>().notNull().default([]),
  draftCommands: text("draft_commands", { mode: "json" }).$type<unknown[] | null>(),
  status: text("status", { enum: ["draft", "active"] }).notNull(),
  createdBy: text("created_by", { enum: ["user", "agent", "builtin-agent"] }).notNull(),
  createdById: text("created_by_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const packageProblems = sqliteTable("package_problem", {
  id: text("id").primaryKey(), // sha256(source, packageId, reason)
  packageId: text("package_id").notNull(),
  source: text("source", { enum: ["official", "declarative", "community"] }).notNull(),
  reason: text("reason").notNull(),
  firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
  alertedAt: integer("alerted_at", { mode: "timestamp_ms" }),
  resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
});

export const credentialLinks = sqliteTable("credential_link", {
  id: text("id").primaryKey(), // sha256 of the link token; the token itself is never stored
  integrationId: text("integration_id").notNull().references(() => integrations.id, { onDelete: "cascade" }),
  createdById: text("created_by_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  usedAt: integer("used_at", { mode: "timestamp_ms" }),
});

// v3 (section 3.1): a Custom API integration's own commands. `record` is the published command
// (null until first published); `draft` is a pending addition or change shown under
// "This integration can change" until a signed-in owner or creator publishes it.
export const customCommands = sqliteTable(
  "custom_command",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id").notNull().references(() => integrations.id, { onDelete: "cascade" }),
    commandId: text("command_id").notNull(),
    record: text("record", { mode: "json" }).$type<Record<string, unknown> | null>(),
    draft: text("draft", { mode: "json" }).$type<Record<string, unknown> | null>(),
    updatedById: text("updated_by_id").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("custom_command_unique_idx").on(t.integrationId, t.commandId)],
);

// v3 (section 6.2): one row per control run that reached its runner. Refusals are audited only.
export const controlRuns = sqliteTable(
  "control_run",
  {
    id: text("id").primaryKey(),
    appId: text("app_id").notNull(),
    version: integer("version").notNull(), // 0 for a draft-preview run (amendment A1.4)
    controlId: text("control_id").notNull(),
    nodeId: text("node_id").notNull(),
    byKind: text("by_kind").notNull(), // "user" | "guest"
    byUserId: text("by_user_id"),
    byGuestLinkId: text("by_guest_link_id"),
    byLabel: text("by_label"),
    at: integer("at", { mode: "timestamp_ms" }).notNull(),
    input: text("input", { mode: "json" }).$type<unknown>(),
    result: text("result", { enum: ["ok", "error"] }).notNull(),
    message: text("message"),
    durationMs: integer("duration_ms").notNull(),
  },
  (t) => [index("control_run_app_idx").on(t.appId, t.at)],
);

// Amendment 2 (saved credentials): a credential saved on its own, used by integrations. Its values
// are sealed in the vault with owner type "credential"; nothing secret is stored here.
export const credentials = sqliteTable(
  "credential",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    // Lower-cased name: names are unique per creator, so nobody learns another person's names.
    nameKey: text("name_key").notNull(),
    kind: text("kind", { enum: ["token", "username-password", "proxmox-token"] }).notNull(),
    // scheme://host[:port] origins; empty = locks to the first integration that uses it.
    lockedOrigins: text("locked_origins", { mode: "json" }).$type<string[]>().notNull().default([]),
    createdById: text("created_by_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  },
  (t) => [uniqueIndex("credential_creator_name_idx").on(t.createdById, t.nameKey)],
);

// Which secret field of an integration is filled from which saved credential (Integration.secrets
// credentialId). Deleting the integration removes its rows; a credential in use cannot be deleted.
export const integrationCredentials = sqliteTable(
  "integration_credential",
  {
    integrationId: text("integration_id").notNull().references(() => integrations.id, { onDelete: "cascade" }),
    secretKey: text("secret_key").notNull(),
    credentialId: text("credential_id").notNull().references(() => credentials.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.integrationId, t.secretKey] }), index("integration_credential_cred_idx").on(t.credentialId)],
);
