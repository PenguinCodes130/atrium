// Owned by settings (architecture v3 sections 4.3, 9b.3; design v4 section 2).
// Saved themes (never the four built-ins, whose ids are frozen and identical on every instance) and
// theme drafts proposed by agents (the v2 `Draft` record, kind "theme").
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const themes = sqliteTable(
  "theme",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    // The full Theme as stored. Revalidated on every read (settings spec 3.5); never trusted.
    theme: text("theme", { mode: "json" }).$type<unknown>().notNull(),
    rev: integer("rev").notNull().default(1), // bumps on every save; a stale save is refused
    createdById: text("created_by_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("theme_name_idx").on(t.name)],
);

export const themeDrafts = sqliteTable(
  "theme_draft",
  {
    id: text("id").primaryKey(),
    targetId: text("target_id"), // absent when the draft creates a theme
    // Creates: the full proposed Theme. Updates: a JSON Merge Patch over the target.
    patch: text("patch", { mode: "json" }).$type<unknown>().notNull(),
    createdBy: text("created_by", { mode: "json" }).$type<Record<string, unknown>>().notNull(), // the Principal
    agentName: text("agent_name"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    status: text("status", { enum: ["open", "published", "discarded"] }).notNull().default("open"),
    note: text("note"),
    decidedById: text("decided_by_id"),
    decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("theme_draft_status_idx").on(t.status)],
);
