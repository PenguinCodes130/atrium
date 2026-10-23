// Owned by app-builder (architecture v3 sections 4.2 and 4.9): apps, their one shared draft, the
// draft change log and the immutable published versions. Documents are stored as JSON (AppDocument).
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { AppDocument, DraftOp, Principal, UserSet } from "@/core/contracts";

const ts = (name: string) => integer(name, { mode: "timestamp_ms" });

export const apps = sqliteTable(
  "app",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    icon: text("icon"),
    accessView: text("access_view", { mode: "json" }).$type<UserSet>().notNull(),
    accessEdit: text("access_edit", { mode: "json" }).$type<UserSet>().notNull(),
    accessGuests: integer("access_guests", { mode: "boolean" }).notNull().default(false),
    publishedVersion: integer("published_version"),
    draftRev: integer("draft_rev").notNull().default(0),
    createdBy: text("created_by").notNull(),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [index("app_created_by_idx").on(t.createdBy)],
);

export const appDrafts = sqliteTable("app_draft", {
  appId: text("app_id")
    .primaryKey()
    .references(() => apps.id, { onDelete: "cascade" }),
  rev: integer("rev").notNull(),
  doc: text("doc", { mode: "json" }).$type<AppDocument>().notNull(),
  updatedAt: ts("updated_at").notNull(),
  updatedBy: text("updated_by", { mode: "json" }).$type<Principal>().notNull(),
  // Set when the draft came from an app file import; the first version published from it is tagged "import" (A4.3).
  fromImport: integer("from_import", { mode: "boolean" }).notNull().default(false),
});

export const appDraftChanges = sqliteTable(
  "app_draft_change",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    rev: integer("rev").notNull(),
    by: text("by", { mode: "json" }).$type<Principal>().notNull(),
    at: ts("at").notNull(),
    ops: text("ops", { mode: "json" }).$type<DraftOp[]>().notNull(),
    summary: text("summary").notNull(),
    // False until the draft is published, restored over or discarded: "changes since the last publish".
    settled: integer("settled", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [index("app_draft_change_app_idx").on(t.appId, t.rev)],
);

export const appVersions = sqliteTable(
  "app_version",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    doc: text("doc", { mode: "json" }).$type<AppDocument>().notNull(),
    publishedBy: text("published_by").notNull(),
    publishedByName: text("published_by_name").notNull().default(""),
    publishedAt: ts("published_at").notNull(),
    note: text("note"),
    source: text("source", { enum: ["publish", "restore", "import", "agent-layout"] }).notNull(),
    restoredFrom: integer("restored_from"),
  },
  (t) => [primaryKey({ columns: [t.appId, t.version] })],
);
