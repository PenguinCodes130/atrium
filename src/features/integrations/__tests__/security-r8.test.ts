// Round 8 (Wave 1 carry-over): Try it with a saved integration's secrets aimed at another origin used
// to drop the secrets and send the request bare, while held curl secrets refused. Both now refuse and
// nothing reaches the other host. A is the integration's own host, B another port on the same machine.
// Test-only secret values; none are real.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "@/core/contracts";
import { setupTestDb } from "./db-harness";
import { httpServer, json } from "../host/__tests__/servers";

setupTestDb();

const owner: Extract<Principal, { kind: "user" }> = { kind: "user", userId: "u-owner", role: "owner", via: "session" };
const BASIC_PASS = "SECPROBE-r8-basic-pass-63";
const BEARER = "SECPROBE-r8-bearer-28";

const EVIDENCE = path.resolve(__dirname, "../../../../evidence/integrations/r8/security/try-other-origin.jsonl");
mkdirSync(path.dirname(EVIDENCE), { recursive: true });
writeFileSync(EVIDENCE, "");
const record = (test: string, outcome: unknown, bSaw: unknown[]) => appendFileSync(EVIDENCE, `${JSON.stringify({ test, outcome, otherHostSaw: bSaw })}\n`);

let svc: typeof import("../service");
let tryIt: typeof import("../try-it");
let A: Awaited<ReturnType<typeof httpServer>>;
let B: Awaited<ReturnType<typeof httpServer>>;
const aSeen: unknown[] = [];
const bSeen: unknown[] = [];

beforeAll(async () => {
  svc = await import("../service");
  tryIt = await import("../try-it");
  A = await httpServer((req, res) => { aSeen.push({ url: req.url, headers: req.headers }); json(res, 200, { server: "A" }); });
  B = await httpServer((req, res) => { bSeen.push({ url: req.url, headers: req.headers }); json(res, 200, { server: "B" }); });
});
afterAll(async () => { await A.close(); await B.close(); });

async function savedIntegration(curl: string) {
  const r = await tryIt.runTry({ curl }, owner.userId);
  if (!r.ok || !r.pendingId) throw new Error(`setup failed: ${JSON.stringify(r)}`);
  return svc.createIntegration(owner, { packageId: "custom-api", name: `probe ${Math.random()}`, config: { baseUrl: A.url, ...(curl.includes("-u ") ? { username: "probe" } : {}) }, secrets: {}, pendingId: r.pendingId, untested: true });
}

describe("Try it: a saved integration's secrets never go to another origin", () => {
  it("Basic credential aimed at another port refuses with permission; nothing is sent anywhere", async () => {
    const i = await savedIntegration(`curl -u probe:${BASIC_PASS} ${A.url}/echo`);
    const auth = tryIt.integrationAuthFor(owner, i.id)!;
    expect(auth.fields.length).toBeGreaterThan(0);
    aSeen.length = 0; bSeen.length = 0;
    const r = await tryIt.runTry({ url: `${B.url}/capture`, auth: { integrationId: i.id } }, owner.userId, auth);
    expect(r).toMatchObject({ ok: false, error: { code: "permission", message: tryIt.TRY_OTHER_ORIGIN_MESSAGE, hint: tryIt.TRY_OTHER_ORIGIN_HINT } });
    expect(bSeen).toEqual([]);
    expect(aSeen).toEqual([]);
    expect(JSON.stringify(r)).not.toContain(BASIC_PASS);
    record("basic saved secret, other port", r, bSeen);
  });

  it("Bearer credential aimed at another origin refuses the same way", async () => {
    const i = await savedIntegration(`curl ${A.url}/echo -H 'Authorization: Bearer ${BEARER}'`);
    const auth = tryIt.integrationAuthFor(owner, i.id)!;
    bSeen.length = 0;
    const r = await tryIt.runTry({ url: `${B.url}/capture` }, owner.userId, auth);
    expect(r).toMatchObject({ ok: false, error: { code: "permission" } });
    expect(bSeen).toEqual([]);
    record("bearer saved secret, other port", r, bSeen);
  });

  it("held curl secrets still refuse another origin (the rule the saved path now matches)", async () => {
    const held = await tryIt.runTry({ curl: `curl ${A.url}/echo -H 'Authorization: Bearer ${BEARER}'` }, owner.userId);
    if (!held.ok || !held.pendingId) throw new Error("setup failed");
    bSeen.length = 0;
    const r = await tryIt.runTry({ url: `${B.url}/capture`, auth: { pendingId: held.pendingId } }, owner.userId);
    expect(r).toMatchObject({ ok: false, error: { code: "permission" } });
    expect(bSeen).toEqual([]);
  });

  it("the same integration on its own origin still sends its credential", async () => {
    const i = await savedIntegration(`curl -u probe:${BASIC_PASS} ${A.url}/echo`);
    const auth = tryIt.integrationAuthFor(owner, i.id)!;
    aSeen.length = 0;
    const r = await tryIt.runTry({ url: `${A.url}/echo`, auth: { integrationId: i.id } }, owner.userId, auth);
    expect(r.ok).toBe(true);
    expect((aSeen.at(-1) as { headers: Record<string, string> }).headers.authorization).toBe(`Basic ${Buffer.from(`probe:${BASIC_PASS}`).toString("base64")}`);
  });
});
