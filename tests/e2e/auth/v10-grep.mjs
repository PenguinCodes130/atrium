// V10: greps the built client bundle and the captured traffic for every seeded secret value.
// Usage: node tests/e2e/auth/v10-grep.mjs <dist-dir> <server-log> ; writes evidence/auth/<round>/v10-secret-grep.txt
// (round from ATRIUM_E2E_ROUND, default r2). Round 2 adds OAuth tokens, the reset password and the
// enrolment QR secret (test-results/auth/v10-seeds-r2.json) and the consent flow traffic. Round 5 adds
// the invite and reset tokens, their SHA-256 hashes and the chosen passwords (v10-seeds-r5.json) and the
// invite traffic (traffic-r5.txt, recorded after the one-time create response). The round 1 seeds and
// traffic are optional so the owner-nogoogle run can be checked on its own; V10_LABEL names the output.
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const dist = process.argv[2] ?? ".next-auth";
const serverLog = process.argv[3];
const seeds = existsSync("test-results/auth/v10-seeds.json")
  ? JSON.parse(readFileSync("test-results/auth/v10-seeds.json", "utf8"))
  : { passwords: [], totpSecret: "", backupCodes: [] };
const values = [
  ...seeds.passwords.map((v, i) => ["seeded password " + i, v]),
  ["TOTP secret", seeds.totpSecret],
  ...seeds.backupCodes.map((v, i) => ["backup code " + i, v]),
  ...(process.env.BETTER_AUTH_SECRET ? [["BETTER_AUTH_SECRET", process.env.BETTER_AUTH_SECRET]] : []),
  ...(process.env.ATRIUM_GOOGLE_CLIENT_SECRET ? [["Google client secret", process.env.ATRIUM_GOOGLE_CLIENT_SECRET]] : []),
  ...(existsSync("data/e2e-auth/master.key") ? [["master key", readFileSync("data/e2e-auth/master.key", "utf8").trim()]] : []),
];
const readSeeds = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {});
const r2 = { ...readSeeds("test-results/auth/v10-seeds-r2.json"), ...readSeeds("test-results/auth/v10-seeds-r2-qr.json") };
for (const [k, v] of Object.entries(r2)) if (typeof v === "string" && v) values.push([k, v]);
const r5 = readSeeds("test-results/auth/v10-seeds-r5.json");
for (const [k, v] of Object.entries(r5)) if (typeof v === "string" && v) values.push(["r5 " + k, v]);
// Round 6: the passwords the Security panel's password change sets (v10-seeds-r6.json, traffic-r6.txt).
const r6 = readSeeds("test-results/auth/v10-seeds-r6.json");
for (const [k, v] of Object.entries(r6)) if (typeof v === "string" && v) values.push(["r6 " + k, v]);
const names = ["ATRIUM_OWNER_PASSWORD=", "BETTER_AUTH_SECRET=", "ATRIUM_MASTER_KEY=", "ATRIUM_RESET_OWNER_PASSWORD="];

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const bundle = walk(path.join(dist, "static")).map((f) => [f, readFileSync(f, "latin1")]);
const targets = [["client bundle (" + bundle.length + " files in " + dist + "/static)", bundle.map((b) => b[1]).join("\n")]];
if (existsSync("test-results/auth/traffic.txt")) targets.push(["captured traffic (test-results/auth/traffic.txt)", readFileSync("test-results/auth/traffic.txt", "utf8")]);
if (existsSync("test-results/auth/traffic-r2.txt")) targets.push(["captured traffic, round 2 consent flow (test-results/auth/traffic-r2.txt)", readFileSync("test-results/auth/traffic-r2.txt", "utf8")]);
if (existsSync("test-results/auth/traffic-r4.txt")) targets.push(["captured traffic, round 4 /account screens (test-results/auth/traffic-r4.txt)", readFileSync("test-results/auth/traffic-r4.txt", "utf8")]);
if (existsSync("test-results/auth/traffic-r5.txt")) targets.push(["captured traffic, round 5 invite and reset flows (test-results/auth/traffic-r5.txt)", readFileSync("test-results/auth/traffic-r5.txt", "utf8")]);
if (existsSync("test-results/auth/traffic-r6.txt")) targets.push(["captured traffic, round 6 settings panels and safeNext (test-results/auth/traffic-r6.txt)", readFileSync("test-results/auth/traffic-r6.txt", "utf8")]);
if (serverLog) targets.push(["server log (criterion 41)", readFileSync(serverLog, "utf8")]);

const out = [`V10 secret grep, ${new Date().toISOString()}`, `values checked: ${values.map((v) => v[0]).join(", ")}`, `env names checked: ${names.join(", ")}`, ""];
let hits = 0;
for (const [label, text] of targets) {
  const found = [...values.filter(([, v]) => v && text.includes(v)).map(([n]) => n), ...names.filter((n) => text.includes(n))];
  hits += found.length;
  out.push(`${label}: ${found.length === 0 ? "0 hits" : "HITS: " + found.join(", ")}`);
}
out.push("", hits === 0 ? "RESULT: PASS (zero hits)" : `RESULT: FAIL (${hits} hits)`);
const round = process.env.ATRIUM_E2E_ROUND ?? "r2";
const label = process.env.V10_LABEL ? `-${process.env.V10_LABEL}` : "";
writeFileSync(`evidence/auth/${round}/v10-secret-grep${label}.txt`, out.join("\n") + "\n");
console.log(out.join("\n"));
process.exit(hits === 0 ? 0 : 1);
