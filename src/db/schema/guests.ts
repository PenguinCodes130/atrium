// Owned by the auth subsystem (architecture v3 section 5.1 and amendment A1.3): guest links and the
// guest sessions they start. Only hashes are stored: SHA-256 of the link token and of the guest cookie,
// and argon2id of the optional PIN. No token, PIN or cookie value is ever kept.
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

const ts = (name: string) => integer(name, { mode: "timestamp_ms" });

export const guestLinks = sqliteTable(
  "guest_link",
  {
    id: text("id").primaryKey(),
    appId: text("app_id").notNull(),
    label: text("label").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    pinHash: text("pin_hash"),
    // The creator's user id. No foreign key: a removed creator's links stay listed (revoked) for the owner.
    createdBy: text("created_by").notNull(),
    createdByName: text("created_by_name").notNull(),
    createdAt: ts("created_at").notNull(),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
    // manual | guests_off | app_deleted | creator_demoted | creator_removed | creator_lost_edit
    revokedCause: text("revoked_cause"),
    revokedBy: text("revoked_by"),
    lastUsedAt: ts("last_used_at"),
    // PIN lockout (5 wrong tries within 15 minutes, from any device, locks the link for 15 minutes).
    pinFailCount: integer("pin_fail_count").notNull().default(0),
    pinFailWindowStart: ts("pin_fail_window_start"),
    pinLockedUntil: ts("pin_locked_until"),
  },
  (t) => [index("guest_link_app_idx").on(t.appId), index("guest_link_creator_idx").on(t.createdBy)],
);

export const guestSessions = sqliteTable(
  "guest_session",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    linkId: text("link_id")
      .notNull()
      .references(() => guestLinks.id, { onDelete: "cascade" }),
    createdAt: ts("created_at").notNull(),
    lastUsedAt: ts("last_used_at").notNull(),
    // 7 days after the last use, never later than the link's expiry.
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [index("guest_session_link_idx").on(t.linkId)],
);
