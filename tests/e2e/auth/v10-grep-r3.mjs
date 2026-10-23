// V10 for auth round 3 (guest links): greps the built client bundle, the recorded traffic after the one-time
// create responses (test-results/auth/traffic-r3.txt: every response a guest browser saw, plus the owner's
// list and revoke responses) and the server log, for every seeded guest token, PIN, token hash, PIN hash and
// guest cookie value (and its hash).
// One category is reported apart: a guest's own link. The response to GET /g/<token> and the PIN step at
// /g/<token>/pin carry that token in their URL (Location header, route payload), because the guest's browser
// requested that URL. Those responses may hold their own token and nothing else; every other secret, and
// every other token, must have zero hits there too.
// Usage: node tests/e2e/auth/v10-grep-r3.mjs <dist-dir> <server-log>  -> evidence/auth/r3/v10-secret-grep.txt
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const dist = process.argv[2] ?? ".next-auth";
const serverLog = process.argv[3];
const seeds = JSON.parse(readFileSync("test-results/auth/v10-seeds-r3.json", "utf8"));
const values = Object.entries(seeds).filter(([, v]) => typeof v === "string" && v.length >= 4);
// The token without its prefix too, so a re-encoded copy would still be caught.
for (const [k, v] of [...values]) if (k.startsWith("guest token ") && !k.includes("hash")) values.push([`${k} (body)`, v.slice(6)]);
const extra = [
  ...(process.env.BETTER_AUTH_SECRET ? [["BETTER_AUTH_SECRET", process.env.BETTER_AUTH_SECRET]] : []),
  ...(existsSync("data/e2e-auth/master.key") ? [["master key", readFileSync("data/e2e-auth/master.key", "utf8").trim()]] : []),
];
values.push(...extra);

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const bundle = walk(path.join(dist, "static")).map((f) => readFileSync(f, "latin1"));
const traffic = readFileSync("test-results/auth/traffic-r3.txt", "utf8");
const records = traffic.split(/^(?=--- )/m).filter(Boolean);
const ownLink = (rec) => {
  const url = rec.slice(4, rec.indexOf("\n")).split(" ")[1] ?? "";
  const m = /\/g\/(atr_g_[A-Za-z0-9_-]{43})(?:\/pin)?(?:\?|$)/.exec(url);
  return m ? m[1] : null;
};
const own = records.filter((r) => ownLink(r));
const rest = records.filter((r) => !ownLink(r));
// In a guest's own-link responses, strip that one token (and its body), then grep for everything.
const ownStripped = own.map((r) => {
  const t = ownLink(r);
  return r.split(t).join("<own token>").split(t.slice(6)).join("<own token>");
});
const targets = [
  [`client bundle (${bundle.length} files in ${dist}/static)`, bundle.join("\n")],
  [`traffic outside a guest's own link (${rest.length} responses)`, rest.join("")],
  [`a guest's own link responses (${own.length}), with that one token masked`, ownStripped.join("")],
];
if (serverLog) targets.push(["server log (criterion 27)", readFileSync(serverLog, "utf8")]);

// Positive control: the traffic must contain things we know are there, so a zero is meaningful.
const controls = [["expired screen text", "This link has expired or was turned off"], ["PIN screen text", "Enter the PIN"]];

const out = [`V10 secret grep, auth round 3, ${new Date().toISOString()}`, `values checked (${values.length}): ${values.map((v) => v[0]).join(", ")}`, ""];
let hits = 0;
for (const [label, text] of targets) {
  const found = values.filter(([, v]) => v && text.includes(v)).map(([k]) => k);
  hits += found.length;
  out.push(`${label}: ${found.length === 0 ? "0 hits" : "HITS: " + found.join(", ")}`);
}
out.push("", `own-link responses that carry their own token (expected, the guest requested that URL): ${own.filter((r) => r.includes(ownLink(r))).length} of ${own.length}`);
out.push("positive controls in the traffic: " + controls.map(([k, v]) => `${k} ${traffic.split(v).length - 1} hits`).join(", "));
out.push("", hits === 0 ? "RESULT: PASS (zero hits)" : `RESULT: FAIL (${hits} hits)`);
writeFileSync(`evidence/auth/${process.env.ATRIUM_E2E_ROUND ?? "r3"}/v10-secret-grep-guest.txt`, out.join("\n") + "\n");
console.log(out.join("\n"));
process.exit(hits === 0 ? 0 : 1);
