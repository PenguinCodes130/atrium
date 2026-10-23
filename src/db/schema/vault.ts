// Owned by the auth subsystem (architecture v2 section 11). Sealed secrets; the master key is never stored here.
import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";

export const secrets = sqliteTable(
  "secret",
  {
    id: text("id").primaryKey(),
    ownerType: text("owner_type", { enum: ["integration", "channel", "setup-agent", "credential"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    key: text("key").notNull(),
    ciphertext: text("ciphertext").notNull(), // base64
    iv: text("iv").notNull(), // base64, 12 bytes
    tag: text("tag").notNull(), // base64, 16 bytes
    keyVersion: integer("key_version").notNull().default(1),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("secret_owner_key_idx").on(t.ownerType, t.ownerId, t.key)],
);
