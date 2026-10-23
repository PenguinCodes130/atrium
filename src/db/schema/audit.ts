// Skeleton (architecture v3 section 2): the append-only audit log, section 7. No update or delete paths exist.
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    at: integer("at", { mode: "timestamp_ms" }).notNull(),
    actorKind: text("actor_kind").notNull(),
    actorUserId: text("actor_user_id"),
    actorTokenId: text("actor_token_id"),
    actorAgentName: text("actor_agent_name"),
    actorGuestLinkId: text("actor_guest_link_id"),
    actorGuestLabel: text("actor_guest_label"),
    actorIp: text("actor_ip"),
    event: text("event").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    targetLabel: text("target_label"),
    proposalId: text("proposal_id"),
    result: text("result").notNull(), // "ok" | "error"
    detail: text("detail", { mode: "json" }).$type<Record<string, unknown> | null>(),
  },
  (t) => [
    index("audit_log_at_idx").on(t.at),
    index("audit_log_event_idx").on(t.event),
    index("audit_log_target_idx").on(t.targetType, t.targetId),
    index("audit_log_actor_idx").on(t.actorUserId),
  ],
);
