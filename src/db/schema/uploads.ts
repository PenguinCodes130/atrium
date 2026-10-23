// Owned by settings (architecture v3 section 13 "Uploads"). Files live at ATRIUM_DATA_DIR/uploads/;
// this table is their index: the stored name, its checked type and who uploaded it.
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const uploads = sqliteTable(
  "upload",
  {
    id: text("id").primaryKey(),
    // The served path segment under /uploads/ (random id plus the checked extension).
    file: text("file").notNull().unique(),
    name: text("name").notNull(), // the uploader's file name, display only
    mime: text("mime").notNull(), // from the bytes, never from the request
    kind: text("kind", { enum: ["image", "video", "font"] }).notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    createdById: text("created_by_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("upload_sha_idx").on(t.sha256)],
);
