// V10: grep the built client bundle for secret field names and secret values. Prints counts and
// file names only, never a value. Run from app/: node tests/e2e/shell/v10-bundle-grep.mjs <distDir> <dataDir>
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const [dist = ".next-app-shell", dataDir = "data/e2e-app-shell"] = process.argv.slice(2);
const NAMES = ["BETTER_AUTH_SECRET", "ATRIUM_MASTER_KEY", "ATRIUM_OWNER_PASSWORD", "ATRIUM_TEST_NPM_TOKEN", "ATRIUM_TEST_PROXMOX_TOKEN", "ATRIUM_TEST_PFSENSE_KEY", "ATRIUM_TEST_KUMA_TOKEN", "ATRIUM_N8N_WEBHOOK_TOKEN", "ATRIUM_N8N_SIGNING_SECRET", "VAPID_PRIVATE_KEY", "master.key", "dev-secrets.json"];
const values = [];
values.push({ label: "e2e owner password (playwright.config.ts)", value: "e2e-owner-password-123" });
const mk = path.join(dataDir, "master.key");
if (existsSync(mk)) values.push({ label: "slot master.key contents", value: readFileSync(mk, "utf8").trim() });
const ds = path.join(dataDir, "dev-secrets.json");
if (existsSync(ds)) for (const [k, v] of Object.entries(JSON.parse(readFileSync(ds, "utf8")))) values.push({ label: `slot dev-secrets ${k}`, value: String(v) });
for (const n of NAMES) if (process.env[n] && process.env[n].length >= 8) values.push({ label: `env ${n} value`, value: process.env[n] });

const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = path.join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|css|html|json|txt|map)$/.test(f)) files.push(p);
  }
};
walk(path.join(dist, "static"));
const hits = [];
for (const f of files) {
  const text = readFileSync(f, "utf8");
  for (const n of NAMES) if (text.includes(n)) hits.push({ file: f, needle: n });
  for (const v of values) if (text.includes(v.value)) hits.push({ file: f, needle: v.label });
}
const report = { scanned: { dir: path.join(dist, "static"), files: files.length }, needles: { names: NAMES, values: values.map((v) => v.label) }, hits };
const round = process.env.ATRIUM_SHELL_ROUND ?? "r4";
mkdirSync(`evidence/app-shell/${round}/v10`, { recursive: true });
writeFileSync(`evidence/app-shell/${round}/v10/bundle-grep.json`, JSON.stringify(report, null, 2));
console.log(`scanned ${files.length} files, ${NAMES.length} names, ${values.length} values: ${hits.length} hits`);
for (const h of hits) console.log("HIT", h.file, h.needle);
process.exit(hits.length ? 1 : 0);
