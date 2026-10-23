// Test only: adds the recipe tables to a throwaway, already migrated database with drizzle-kit push,
// until the lead's migration for src/db/schema/recipes.ts exists (then push changes nothing).
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: ["./src/db/schema/index.ts", "./src/db/schema/recipes.ts"],
  dbCredentials: { url: `${process.env.ATRIUM_DATA_DIR ?? "./data-missing"}/atrium.db` },
});
