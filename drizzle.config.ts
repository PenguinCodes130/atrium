import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema/index.ts",
  out: "./src/db/migrations",
  dbCredentials: { url: `${process.env.ATRIUM_DATA_DIR ?? "./data"}/atrium.db` },
});
