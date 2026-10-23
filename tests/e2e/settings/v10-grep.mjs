// V10 for settings r1: greps the client bundle of the isolated settings build, the recorded traffic and
// the server log for every seeded test secret and the backup password. Zero hits is a pass.
//   node tests/e2e/settings/v10-grep.mjs <build-dir>
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const build = process.argv[2];
// r2: ATRIUM_E2E_EVIDENCE_ROUND picks the evidence folder (default r1).
const ROUND = process.env.ATRIUM_E2E_EVIDENCE_ROUND ?? "r1";
const app = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const values = {
  "credential token": "atrium-settings-e2e-FAKE-token-7c1d9e",
  "backup password": "e2e-backup-FAKE-pass-4410",
  "r2 backup password": "e2e-r2-backup-FAKE-pass-5521",
  "owner password": "e2e-owner-password-123",
};
function walk(dir) {
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
const sets = {
  bundle: walk(path.join(build, ".next-settings/static")),
  traffic: walk(path.join(app, `evidence/settings/${ROUND}/traffic`)),
  serverLog: walk(path.join(app, `evidence/settings/${ROUND}/logs`)),
};
const report = {};
let hits = 0;
for (const [set, files] of Object.entries(sets)) {
  report[set] = { files: files.length, hits: [] };
  for (const f of files) {
    const text = readFileSync(f).toString("utf8");
    for (const [name, v] of Object.entries(values)) {
      // The owner password is typed into the sign-in form by tests; responses must never echo it.
      if (text.includes(v)) { report[set].hits.push({ file: path.relative(app, f), value: name }); hits++; }
    }
  }
}
writeFileSync(path.join(app, `evidence/settings/${ROUND}/v10.json`), JSON.stringify({ values: Object.keys(values), report, hits }, null, 2));
console.log(JSON.stringify({ hits, files: Object.fromEntries(Object.entries(report).map(([k, v]) => [k, v.files])) }));
process.exit(hits ? 1 : 0);
