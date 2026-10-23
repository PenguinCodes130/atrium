// Writes tests/e2e/settings/hostile-theme.json from the unit-test fixture (AC 24, 28).
import { writeFileSync } from "node:fs";
import { hostileTheme } from "../../../src/features/settings/test/fixtures.ts";
writeFileSync(new URL("./hostile-theme.json", import.meta.url), JSON.stringify(hostileTheme(), null, 2));
