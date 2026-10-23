// V10 for components: grep the slot's client bundle and the captured traffic (g-v10.spec.ts) for
// secret field names and seeded secret values. Prints counts and labels only, never a value.
// Run from app/: node tests/e2e/components/v10-grep.mjs
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const dist = ".next-components";
const dataDir = "data/e2e-components";
const NAMES = ["BETTER_AUTH_SECRET", "ATRIUM_MASTER_KEY", "ATRIUM_OWNER_PASSWORD", "ATRIUM_TEST_NPM_TOKEN", "ATRIUM_TEST_PROXMOX_TOKEN", "ATRIUM_TEST_HA_TOKEN", "ATRIUM_N8N_WEBHOOK_TOKEN", "ATRIUM_N8N_SIGNING_SECRET", "VAPID_PRIVATE_KEY", "master.key", "dev-secrets.json"];
const values = [
  { label: "e2e owner password", value: "e2e-owner-password-123" },
  { label: "slot BETTER_AUTH_SECRET (serve.sh)", value: "e2e-components-only-not-a-credential-0001" },
];
const mk = path.join(dataDir, "master.key");
if (existsSync(mk)) values.push({ label: "slot master.key contents", value: readFileSync(mk, "utf8").trim() });
const files = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(js|css|html|json|txt|map)$/.test(f)) files.push(p); } };
walk(path.join(dist, "static"));
const captured = `evidence/components/${process.env.ATRIUM_E2E_EVIDENCE_ROUND ?? "r1"}/v10/captured`;
if (existsSync(captured)) walk(captured);
const hits = [];
for (const f of files) {
  const text = readFileSync(f, "utf8");
  for (const n of NAMES) if (text.includes(n)) hits.push({ file: f, needle: n });
  for (const v of values) if (text.includes(v.value)) hits.push({ file: f, needle: v.label });
}
const report = { scanned: { bundle: path.join(dist, "static"), captured, files: files.length }, needles: { names: NAMES, values: values.map((v) => v.label) }, hits };
mkdirSync(`evidence/components/${process.env.ATRIUM_E2E_EVIDENCE_ROUND ?? "r1"}/v10`, { recursive: true });
writeFileSync(`evidence/components/${process.env.ATRIUM_E2E_EVIDENCE_ROUND ?? "r1"}/v10/grep.json`, JSON.stringify(report, null, 2));
console.log(`scanned ${files.length} files, ${NAMES.length} names, ${values.length} values: ${hits.length} hits`);
for (const h of hits) console.log("HIT", h.file, h.needle);
process.exit(hits.length ? 1 : 0);
