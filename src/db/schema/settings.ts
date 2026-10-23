// Owned by settings (architecture v3 section 2; Amendment 4 A4.4 "Settings store").
// Typed key and value rows with a scope of `instance` or `user:<id>`. Values are JSON and are
// validated by src/features/settings/store.ts on every read and write.
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const settingValues = sqliteTable(
  "setting",
  {
    scope: text("scope").notNull(), // "instance" | "user:<userId>"
    key: text("key").notNull(),
    value: text("value", { mode: "json" }).$type<unknown>().notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    updatedBy: text("updated_by"),
  },
  (t) => [primaryKey({ columns: [t.scope, t.key] })],
);
