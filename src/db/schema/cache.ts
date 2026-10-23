// Owned by the integrations subsystem (architecture v2 section 10). The shared read cache.
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const endpointCache = sqliteTable(
  "endpoint_cache",
  {
    key: text("key").primaryKey(), // sha256(integrationId, endpointId, canonicalJson(params))
    integrationId: text("integration_id").notNull(),
    endpointId: text("endpoint_id").notNull(),
    params: text("params").notNull(), // canonical JSON
    lastGood: text("last_good", { mode: "json" }).$type<Record<string, unknown> | null>(),
    lastAttempt: text("last_attempt", { mode: "json" }).$type<Record<string, unknown> | null>(),
    fetchedAt: integer("fetched_at", { mode: "timestamp_ms" }),
    sourceTimestamp: text("source_timestamp"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("endpoint_cache_integration_idx").on(t.integrationId)],
);
