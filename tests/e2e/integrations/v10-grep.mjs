// Check V10 for integrations: grep the built client bundle (.next-integrations/static) and every
// captured response (e2e traffic, agent tool outputs, the data stream) for each seeded test secret.
// Usage: node tests/e2e/integrations/v10-grep.mjs > evidence/integrations/r8/v10-grep.txt
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// Seeded test-only values (tests/e2e/integrations/fakes.ts and the unit tests). None are real.
const SECRETS = [
  "atrium-v10-FAKE-npm-token-2f1c9e77a0b4",
  "atrium-v10-FAKE-wrong-npm-token-8d2e",
  "atrium-v10-FAKE-curl-bearer-6b3a91c5d7e2",
  "atrium-v10-FAKE-pve-0000-1111",
  "atrium-v10-FAKE-locked-attempt",
  "atrium-unit-FAKE-npm-token-5d41402abc4b2a76",
  "atr-test-FAKE-bearer-9f8e7d6c5b4a",
  // Round 3: Home Assistant and command tests.
  "atrium-v10-FAKE-ha-token-1c6f3e0a9b2d",
  "atrium-r3-FAKE-ha-token-6b86b273ff34fce1",
  "atrium-r3-FAKE-custom-secret-d4735e3a265e",
  "atrium-r3-FAKE-wrong-token",
  // Round 4: saved credentials (unit tests; the e2e reuses the fake HA, NPM and Proxmox values above).
  "atrium-r4-FAKE-cred-token-3f9a1c7e",
  "atrium-r4-FAKE-cred-token-rotated-77b2",
  "atrium-r4-FAKE-cred-pass-41d8",
  "atrium-r4-FAKE-pve-secret-0c9e",
  // Round 5: the Try it cross-user replay, rename and remove-server tests.
  "SECPROBE-owner-cred-token-r5",
  "SECPROBE-owner-curl-token-r5",
  "atrium-r5-FAKE-cred-token-a41c",
  // Round 6: the UI lock, Save and test refresh and V4 screens (i-round6.spec.ts), and the step-up bypass replay.
  "SECPROBE-owner-prod-token-r6",
  "SECPROBE-owner-spare-token-r6",
  // Round 7: the path-origin replay (security-r7.test.ts).
  "SECPROBE-r7-locked-cred-token",
  "SECPROBE-r7-held-curl-bearer",
  // Round 8: Try it with a saved integration's secrets aimed at another origin (security-r8.test.ts).
  "SECPROBE-r8-basic-pass-63",
  "SECPROBE-r8-bearer-28",
];
const forms = (s) => [s, encodeURIComponent(s), Buffer.from(s).toString("base64")];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const targets = [
  ...walk(path.join(app, ".next-integrations/static")),
  ...walk(path.join(app, "evidence/integrations/r6/traffic")),
  ...walk(path.join(app, "evidence/integrations/r6/security")),
  ...walk(path.join(app, "evidence/integrations/r7/security")),
  ...walk(path.join(app, "evidence/integrations/r7/logs")),
  // Round 8: the full e2e run writes its traffic under r8 (ATRIUM_INT_ROUND=r8), plus the r8 security log.
  ...(existsSync(path.join(app, "evidence/integrations/r8")) ? walk(path.join(app, "evidence/integrations/r8")).filter((f) => !f.endsWith(".png") && !f.endsWith(".webm")) : []),
  // Wave 2.7: a later run's own folder (ATRIUM_INT_ROUND=r15-w27), traffic and logs.
  ...(process.env.ATRIUM_INT_ROUND && process.env.ATRIUM_INT_ROUND !== "r8" && existsSync(path.join(app, "evidence/integrations", process.env.ATRIUM_INT_ROUND)) ? walk(path.join(app, "evidence/integrations", process.env.ATRIUM_INT_ROUND)).filter((f) => !f.endsWith(".png") && !f.endsWith(".webm") && !f.endsWith(".mp4")) : []),
];
let hits = 0;
let bytes = 0;
for (const file of targets) {
  const text = readFileSync(file).toString("latin1");
  bytes += text.length;
  for (const s of SECRETS) for (const f of forms(s)) if (text.includes(f)) { hits++; console.log(`HIT ${path.relative(app, file)} contains a form of ${s.slice(0, 18)}...`); }
}
const bundle = targets.filter((t) => t.includes(".next-integrations")).length;
console.log(`files scanned: ${targets.length} (${bundle} client bundle files, ${targets.length - bundle} captured traffic and security evidence files), ${bytes} bytes`);
console.log(`secret values: ${SECRETS.length} (each as plain, URL-encoded and base64)`);
// Server-only modules must never reach the browser bundle.
for (const marker of ["features/vault/unseal", "PVEAPIToken=", "scrubSecrets", "holdSecrets", "hostCommand", "runCustomCommand", "integrations.command", "resolveCredential", "refsOfIntegration", "credentialTablesExist", "integrationAuthFor", "boundedDetail"]) {
  const found = targets.filter((t) => t.includes(".next-integrations") && readFileSync(t, "latin1").includes(marker));
  console.log(`server-only marker "${marker}": ${found.length} client files`);
  hits += found.length;
}
console.log(hits === 0 ? "V10 RESULT: PASS (0 hits)" : `V10 RESULT: FAIL (${hits} hits)`);
process.exit(hits === 0 ? 0 : 1);
