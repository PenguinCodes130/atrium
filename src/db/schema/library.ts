// Owned by components (architecture v3 section 4.8, amendment A4.1): the shared component library.
// One row per component (its latest version) plus every version, so a published app pinned to an old
// version (or to a deleted component) keeps rendering. JSON columns hold the saved subtree and params.
import { sqliteTable, text, integer, primaryKey, index } from "drizzle-orm/sqlite-core";

const ts = (name: string) => integer(name, { mode: "timestamp_ms" });

export const libraryComponents = sqliteTable(
  "library_component",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    tags: text("tags", { mode: "json" }).$type<string[]>().notNull(),
    version: integer("version").notNull(),
    containsCode: integer("contains_code", { mode: "boolean" }).notNull(),
    source: text("source").$type<"local" | "imported">().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
    // Deleting hides the component from the library; its versions stay so pinned published apps render.
    deletedAt: ts("deleted_at"),
  },
  (t) => [index("library_component_name_idx").on(t.name)],
);

export const libraryVersions = sqliteTable(
  "library_version",
  {
    componentId: text("component_id").notNull(),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    tags: text("tags", { mode: "json" }).$type<string[]>().notNull(),
    node: text("node", { mode: "json" }).notNull(),
    params: text("params", { mode: "json" }).notNull(),
    containsCode: integer("contains_code", { mode: "boolean" }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.componentId, t.version] })],
);
