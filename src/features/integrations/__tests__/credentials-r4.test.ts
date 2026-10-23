// Round 4 (architecture v3 Amendment 2, integrations-spec-v3.md): saved credentials. Service and
// host tests on a real throwaway database, against local test services: A is the server a
// credential is for, B a second server (or a stand-in attacker host). What B saw is written to
// evidence/integrations/r6/security/credentials.jsonl. Test-only secret values; none are real.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "@/core/contracts";
import { setupTestDb } from "./db-harness";
import { httpServer, json, redirect } from "../host/__tests__/servers";

setupTestDb();

type User = Extract<Principal, { kind: "user" }>;
const owner: User = { kind: "user", userId: "u-owner", role: "owner", via: "session" };
const member: User = { kind: "user", userId: "u-member", role: "member", via: "session" };
const member2: User = { kind: "user", userId: "u-member2", role: "member", via: "session" };
const viewer: User = { kind: "user", userId: "u-viewer", role: "viewer", via: "session" };
const agent: Principal = { kind: "agent", userId: "u-owner", role: "owner", via: "pat", tokenId: "t-owner", agentName: "Claude", scopes: ["atrium:read", "atrium:edit"] };
const memberAgent: Principal = { kind: "agent", userId: "u-member", role: "member", via: "pat", tokenId: "t-member", agentName: "Claude", scopes: ["atrium:read", "atrium:edit"] };
const builtin: Principal = { kind: "builtin-agent", userId: "u-owner", role: "owner", conversationId: "c1" };

const TOKEN = "atrium-r4-FAKE-cred-token-3f9a1c7e";
const TOKEN_NEW = "atrium-r4-FAKE-cred-token-rotated-77b2";
const BASIC_USER = "atrium-r4-user";
const BASIC_PASS = "atrium-r4-FAKE-cred-pass-41d8";
const PVE_ID = "atrium@pve!r4";
const PVE_SECRET = "atrium-r4-FAKE-pve-secret-0c9e";
const SECRETS = [TOKEN, TOKEN_NEW, BASIC_PASS, PVE_SECRET];

const EVIDENCE = path.resolve(__dirname, "../../../../evidence/integrations/r6/security/credentials.jsonl");
const TRAFFIC = path.resolve(__dirname, "../../../../evidence/integrations/r6/traffic/credential-tools.jsonl");
mkdirSync(path.dirname(EVIDENCE), { recursive: true });
mkdirSync(path.dirname(TRAFFIC), { recursive: true });
writeFileSync(EVIDENCE, "");
writeFileSync(TRAFFIC, "");
const record = (test: string, outcome: unknown, bSaw: unknown[]) => appendFileSync(EVIDENCE, `${JSON.stringify({ test, outcome, otherServerSaw: bSaw })}\n`);

let svc: typeof import("../service");
let creds: typeof import("../credentials/service");
let credRepo: typeof import("../credentials/repo");
let kinds: typeof import("../credentials/kinds");
let runtime: typeof import("../runtime");
let repo: typeof import("../repo");
let tools: typeof import("../tools");
let tryIt: typeof import("../try-it");
let auditRows: () => { event: string; targetId: string | null; detail: Record<string, unknown> | null }[];
let A: Awaited<ReturnType<typeof httpServer>>;
let B: Awaited<ReturnType<typeof httpServer>>;
let currentToken = TOKEN;

const leaked = (seen: unknown) => {
  const text = JSON.stringify(seen);
  return SECRETS.some((s) => text.includes(s) || text.includes(Buffer.from(`${BASIC_USER}:${s}`).toString("base64")));
};

/** A fake NPM: /api/ is public, /api/users/me needs the bearer token; /pve and /prom answer other packages. */
function npmLike(name: string) {
  return (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/api/") return json(res, 200, { status: "OK", version: { major: 2, minor: 12, revision: 6 }, server: name });
    if (u.pathname === "/api/users/me") return req.headers.authorization === `Bearer ${currentToken}` ? json(res, 200, { id: 1 }) : json(res, 401, {});
    if (u.pathname === "/api/nginx/proxy-hosts") return req.headers.authorization === `Bearer ${currentToken}` ? json(res, 200, []) : json(res, 401, {});
    if (u.pathname === "/api2/json/version") return req.headers.authorization === `PVEAPIToken=${PVE_ID}=${PVE_SECRET}` ? json(res, 200, { data: { version: "8.2" } }) : json(res, 401, {});
    if (u.pathname === "/api/v1/status/buildinfo") return req.headers.authorization === `Basic ${Buffer.from(`${BASIC_USER}:${BASIC_PASS}`).toString("base64")}` ? json(res, 200, { status: "success", data: { version: "2.53.0" } }) : json(res, 401, {});
    if (u.pathname === "/echo") return json(res, 200, { ok: true, headers: req.headers });
    if (u.pathname === "/redir/api/") return json(res, 200, { status: "OK", version: { major: 2, minor: 12, revision: 6 } });
    if (u.pathname === "/redir/api/users/me") return redirect(res, `${B.url}/capture`);
    json(res, 404, {});
  };
}

beforeAll(async () => {
  svc = await import("../service");
  creds = await import("../credentials/service");
  credRepo = await import("../credentials/repo");
  kinds = await import("../credentials/kinds");
  runtime = await import("../runtime");
  repo = await import("../repo");
  tools = await import("../tools");
  tryIt = await import("../try-it");
  const { db } = await import("@/core/db");
  const { auditLog } = await import("@/db/schema/audit");
  auditRows = () => db().select().from(auditLog).all().map((r) => ({ event: r.event, targetId: r.targetId, detail: r.detail ?? null }));
  B = await httpServer(npmLike("B"));
  A = await httpServer(npmLike("A"));
});
afterAll(async () => { await A.close(); await B.close(); });

let n = 0;
const uniq = (s: string) => `${s} ${++n}`;
function tokenCred(p: User = owner, server?: string) {
  return creds.createCredential(p, { name: uniq("NPM token"), kind: "token", values: { token: TOKEN }, ...(server ? { server } : {}) });
}
function npmWith(credentialId: string, url = A.url, p: User = owner, lock: { confirmOrigins?: boolean; stepUpFresh?: boolean } = {}) {
  return svc.createIntegration(p, { packageId: "npm", name: uniq("NPM"), config: { baseUrl: url }, secrets: {}, credentials: { token: credentialId }, untested: true, ...(lock.confirmOrigins ? { confirmOrigins: true } : {}) }, lock);
}
function tool(name: string) {
  const t = tools.integrationTools.find((x) => x.name === name);
  if (!t) throw new Error(name);
  return async (p: Principal, input: unknown) => {
    const out = await t.handler({ principal: p, signal: new AbortController().signal }, t.input.parse(input));
    appendFileSync(TRAFFIC, `${JSON.stringify({ tool: name, out: t.output.parse(out) }).replace(/draft=[A-Za-z0-9_-]+/g, "draft=[link-token]")}\n`);
    return t.output.parse(out);
  };
}

describe("kinds, fields and servers (criteria 3, 6, 11)", () => {
  it("each kind has exactly its value fields", () => {
    expect(kinds.KIND_FIELDS.token.map((f) => f.label)).toEqual(["Token"]);
    expect(kinds.KIND_FIELDS["username-password"].map((f) => f.label)).toEqual(["Username", "Password"]);
    expect(kinds.KIND_FIELDS["proxmox-token"].map((f) => f.label)).toEqual(["Token ID", "Secret"]);
  });
  it("placements map to kinds", () => {
    expect(["bearer", "header", "query"].map((as) => kinds.kindForPlacement({ as }))).toEqual(["token", "token", "token"]);
    expect(kinds.kindForPlacement({ as: "basic", userKey: "u" })).toBe("username-password");
    expect(kinds.kindForPlacement({ as: "proxmox-token" })).toBe("proxmox-token");
  });
  it("a server keeps only its origin; anything but http(s) is refused", () => {
    expect(kinds.normaliseOrigin("https://ha.example.test:8123/lovelace")).toBe("https://ha.example.test:8123");
    expect(kinds.normaliseOrigin("https://ha.example.test:443/")).toBe("https://ha.example.test");
    expect(kinds.normaliseOrigin("ftp://x")).toBeNull();
    expect(kinds.normaliseOrigin("not a url")).toBeNull();
    expect(() => creds.createCredential(owner, { name: uniq("bad"), kind: "token", values: { token: TOKEN }, server: "ftp://x" })).toThrow(/^Server:/);
    expect(() => creds.createCredential(owner, { name: uniq("bad"), kind: "token", values: { token: TOKEN }, server: "not a url" })).toThrow(/^Server:/);
    const c = creds.createCredential(owner, { name: uniq("HA"), kind: "token", values: { token: TOKEN }, server: "https://ha.example.test:8123/lovelace" });
    expect(c.lockedOrigins).toEqual(["https://ha.example.test:8123"]);
  });
});

describe("saving a credential (criteria 4, 5, 7)", () => {
  it("saves a token with no server: locks on first use, unused, never used, no value anywhere", () => {
    const c = creds.createCredential(owner, { name: "Home Assistant token", kind: "token", values: { token: TOKEN } });
    expect(c).toMatchObject({ name: "Home Assistant token", kind: "token", lockedOrigins: [], usedBy: [], fields: [{ key: "token", set: true }] });
    expect(c.lastUsedAt).toBeUndefined();
    expect(leaked(c)).toBe(false);
    const a = auditRows().filter((r) => r.event === "credential.created" && r.targetId === c.id);
    expect(a).toHaveLength(1);
    expect(a[0]!.detail).toMatchObject({ credential: "Home Assistant token", kind: "token", server: null });
    expect(leaked(a)).toBe(false);
  });
  it("refuses a blank name, a blank field or a name the same person uses, naming the field; nothing saved", () => {
    const before = credRepo.listCredentialRows().length;
    expect(() => creds.createCredential(owner, { name: "  ", kind: "token", values: { token: TOKEN } })).toThrow(/^Name:/);
    expect(() => creds.createCredential(owner, { name: uniq("x"), kind: "username-password", values: { username: "u", password: "" } })).toThrow(/^Password:/);
    expect(() => creds.createCredential(owner, { name: uniq("x"), kind: "proxmox-token", values: { secret: "s" } })).toThrow(/^Token ID:/);
    expect(() => creds.createCredential(owner, { name: "home assistant TOKEN", kind: "token", values: { token: TOKEN } })).toThrow(/^Name: you already have/);
    expect(credRepo.listCredentialRows().length).toBe(before);
    // Another person may use the same name: names are per creator.
    expect(creds.createCredential(member, { name: "Home Assistant token", kind: "token", values: { token: TOKEN } }).name).toBe("Home Assistant token");
  });
});

describe("who may see and use a credential (criteria 8, 9)", () => {
  it("a member's credential is the owner's to see, never another member's", async () => {
    const mine = creds.createCredential(member, { name: uniq("Member secret"), kind: "token", values: { token: TOKEN } });
    expect(creds.listCredentials(owner).map((c) => c.id)).toContain(mine.id);
    expect(creds.listCredentials(member).map((c) => c.id)).toContain(mine.id);
    const other = creds.listCredentials(member2);
    expect(JSON.stringify(other)).not.toContain(mine.id);
    expect(JSON.stringify(other)).not.toContain(mine.name);
    expect(() => creds.usableCredential(member2, mine.id)).toThrow("That saved credential does not exist.");
    expect(() => creds.rotateCredential(member2, mine.id, { values: { token: "x1" } })).toThrow("That saved credential does not exist.");
    expect(() => creds.deleteCredential(member2, mine.id)).toThrow("That saved credential does not exist.");
    const listed = await tool("credentials.list")({ kind: "agent", userId: "u-member2", role: "member", via: "pat", tokenId: "t2", agentName: "Claude", scopes: ["atrium:read"] }, {});
    expect(JSON.stringify(listed)).not.toContain(mine.name);
    // Picking it for an integration answers exactly like an unknown id.
    const unknown = (() => { try { npmWith("no-such-id", A.url, member2); } catch (e) { return (e as Error).message; } })();
    const theirs = (() => { try { npmWith(mine.id, A.url, member2); } catch (e) { return (e as Error).message; } })();
    expect(theirs).toBe(unknown);
    expect(theirs).toMatch(/^API token: pick a saved token you can use/);
  });
  it("a member viewing an integration that uses the owner's credential sees only Saved, no name or id", () => {
    const c = tokenCred(owner, A.url);
    const i = npmWith(c.id);
    const asMember = svc.getIntegration(member2, i.id);
    expect(asMember.secretFields[0]).toMatchObject({ key: "token", set: true, viaCredential: true });
    expect(asMember.secretFields[0]!.credential).toBeUndefined();
    expect(asMember.secrets[0]!.credentialId).toBeUndefined();
    expect(JSON.stringify(asMember)).not.toContain(c.name);
    expect(svc.getIntegration(owner, i.id).secretFields[0]!.credential?.name).toBe(c.name);
  });
  it("viewers, agents and guests cannot save credentials", () => {
    expect(() => creds.createCredential(viewer, { name: uniq("v"), kind: "token", values: { token: TOKEN } })).toThrow("Your role can view integrations but not save credentials.");
    expect(() => creds.createCredential(agent, { name: uniq("a"), kind: "token", values: { token: TOKEN } })).toThrow(/Only a signed-in person/);
    expect(() => creds.createCredential(builtin, { name: uniq("a"), kind: "token", values: { token: TOKEN } })).toThrow(/Only a signed-in person/);
    expect(() => creds.listCredentials({ kind: "guest", guestLinkId: "g", appId: "a", label: "Sam", via: "guest-link" })).toThrow(/Guests/);
  });
});

describe("picking on a setup form and testing (criteria 11, 13, 14, 15)", () => {
  it("a wrong-kind credential is refused naming the field, same message as unknown", () => {
    const pass = creds.createCredential(owner, { name: uniq("Basic"), kind: "username-password", values: { username: BASIC_USER, password: BASIC_PASS } });
    expect(() => npmWith(pass.id)).toThrow(/^API token: pick a saved token you can use/);
  });
  it("a credential locked to the form's server passes the test there", async () => {
    const c = tokenCred(owner, A.url);
    const t = await svc.testConnection(owner, { packageId: "npm", config: { baseUrl: A.url }, secrets: {}, credentials: { token: c.id } });
    expect(t).toMatchObject({ ok: true, health: { status: "ok" } });
  });
  it("an unlocked credential is tested only after the confirm and a step-up, and locks (r6 item 1); one locked elsewhere is never sent", async () => {
    // Round 6 (Fix List r3 item 1) changed criterion 15 again: a test of an unlocked credential needs
    // the confirm and a fresh step-up, and locks it to the tested server before sending. Locked
    // elsewhere is unchanged.
    const unlocked = tokenCred();
    A.seen.length = 0;
    await expect(svc.testConnection(owner, { packageId: "npm", config: { baseUrl: A.url }, secrets: {}, credentials: { token: unlocked.id } })).rejects.toThrow(creds.OriginConfirmNeeded);
    await expect(svc.testConnection(owner, { packageId: "npm", config: { baseUrl: A.url }, secrets: {}, credentials: { token: unlocked.id }, confirmOrigins: true })).rejects.toThrow(creds.OriginStepUpNeeded);
    expect(leaked(A.seen)).toBe(false);
    const t0 = performance.now();
    const t = await svc.testConnection(owner, { packageId: "npm", config: { baseUrl: A.url }, secrets: {}, credentials: { token: unlocked.id }, confirmOrigins: true }, { stepUpFresh: true });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(t).toMatchObject({ ok: true });
    expect(credRepo.getCredentialRow(unlocked.id)!.lockedOrigins).toEqual([new URL(A.url).origin]);
    const elsewhere = tokenCred(owner, A.url);
    B.seen.length = 0;
    const t2 = await svc.testConnection(owner, { packageId: "npm", config: { baseUrl: B.url }, secrets: {}, credentials: { token: elsewhere.id } });
    expect(t2).toMatchObject({ ok: false, error: { code: "permission", message: expect.stringContaining(`is locked to ${new URL(A.url).origin}`) } });
    expect(leaked(B.seen)).toBe(false);
    record("test with credential locked elsewhere", t2, B.seen);
  });
  it("an agent cannot pick credentials for a one-off test", async () => {
    const c = tokenCred(owner, A.url);
    const t = await svc.testConnection(agent, { packageId: "npm", config: { baseUrl: A.url }, secrets: {}, credentials: { token: c.id } });
    expect(t.ok).toBe(false); // nothing attached: the token check fails
  });
  it("a Basic field filled from a credential sends its username and password; Proxmox sends ID=secret", async () => {
    const basic = creds.createCredential(owner, { name: uniq("Prom login"), kind: "username-password", values: { username: BASIC_USER, password: BASIC_PASS }, server: A.url });
    const t = await svc.testConnection(owner, { packageId: "prometheus", config: { baseUrl: A.url, authMode: "basic" }, secrets: {}, credentials: { password: basic.id } });
    expect(t).toMatchObject({ ok: true, health: { version: "2.53.0" } });
    const pve = creds.createCredential(owner, { name: uniq("PVE"), kind: "proxmox-token", values: { tokenId: PVE_ID, secret: PVE_SECRET }, server: A.url });
    const t2 = await svc.testConnection(owner, { packageId: "proxmox", config: { baseUrl: A.url, verifyTls: false }, secrets: {}, credentials: { token: pve.id } });
    expect(t2).toMatchObject({ ok: true, health: { version: "8.2" } });
    // A saved Basic integration also reads with it, the form never having asked for a username.
    const i = svc.createIntegration(owner, { packageId: "prometheus", name: uniq("Prom"), config: { baseUrl: A.url, authMode: "basic" }, secrets: {}, credentials: { password: basic.id }, untested: true });
    const h = await svc.testConnection(owner, { packageId: "prometheus", config: i.config, secrets: {}, integrationId: i.id });
    expect(h.ok).toBe(true);
  });
});

describe("locking (criteria 16 to 22)", () => {
  it("first use locks to the integration's server and audits credential.locked", () => {
    // Round 6 (Fix List r3 item 1): the first server is confirmed and needs a step-up like any other.
    const c = tokenCred();
    expect(() => npmWith(c.id)).toThrow(creds.OriginConfirmNeeded);
    expect(() => npmWith(c.id, A.url, owner, { confirmOrigins: true })).toThrow(creds.OriginStepUpNeeded);
    expect(credRepo.getCredentialRow(c.id)!.lockedOrigins).toEqual([]);
    const i = npmWith(c.id, A.url, owner, { confirmOrigins: true, stepUpFresh: true });
    const after = creds.toCredential(credRepo.getCredentialRow(c.id)!);
    expect(after.lockedOrigins).toEqual([new URL(A.url).origin]);
    expect(after.usedBy).toEqual([{ integrationId: i.id, name: i.name }]);
    const locked = auditRows().filter((r) => r.event === "credential.locked" && r.targetId === c.id);
    expect(locked).toHaveLength(1);
    expect(locked[0]!.detail).toMatchObject({ credential: c.name, origin: new URL(A.url).origin, firstUse: true });
  });
  it("a new server needs the explicit confirm, then a fresh step-up; refusals change nothing", () => {
    const c = tokenCred(owner, A.url);
    const before = repo.listIntegrationRows().length;
    let err: unknown;
    try { npmWith(c.id, B.url); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(creds.OriginConfirmNeeded);
    expect((err as InstanceType<typeof creds.OriginConfirmNeeded>).needs[0]).toMatchObject({ name: c.name, origin: new URL(B.url).origin, lockedOrigins: [new URL(A.url).origin] });
    expect((err as Error).message).toBe(`Also allow ${c.name} on ${new URL(B.url).origin}? It is locked to ${new URL(A.url).origin}.`);
    expect(() => npmWith(c.id, B.url, owner, { confirmOrigins: true, stepUpFresh: false })).toThrow(creds.OriginStepUpNeeded);
    expect(repo.listIntegrationRows().length).toBe(before);
    expect(credRepo.getCredentialRow(c.id)!.lockedOrigins).toEqual([new URL(A.url).origin]);
    const i = npmWith(c.id, B.url, owner, { confirmOrigins: true, stepUpFresh: true });
    expect(credRepo.getCredentialRow(c.id)!.lockedOrigins).toEqual([new URL(A.url).origin, new URL(B.url).origin]);
    expect(auditRows().filter((r) => r.event === "credential.locked" && r.targetId === c.id).at(-1)!.detail).toMatchObject({ origin: new URL(B.url).origin, firstUse: false, integrationId: i.id });
  });
  it("moving a live integration that uses a credential to a new address follows the same rules", async () => {
    const c = tokenCred(owner, A.url);
    const i = npmWith(c.id); // locked to A
    expect(() => svc.updateIntegration(owner, i.id, { config: { baseUrl: B.url } })).toThrow(creds.OriginConfirmNeeded);
    expect(() => svc.updateIntegration(owner, i.id, { config: { baseUrl: B.url }, confirmOrigins: true }, { stepUpFresh: false })).toThrow(creds.OriginStepUpNeeded);
    expect(svc.getIntegration(owner, i.id).config.baseUrl).toBe(A.url);
    svc.updateIntegration(owner, i.id, { config: { baseUrl: B.url }, confirmOrigins: true }, { stepUpFresh: true });
    const r = await runtime.readEndpoint(i.id, "proxy-hosts", {});
    expect(r.ok).toBe(true); // pinned and locked to B now
  });
  it("publishing an agent draft that proposes a credential on an unlisted server needs the confirm and step-up", async () => {
    const c = tokenCred(owner, A.url);
    const draft = await tool("integrations.create")(agent, { packageId: "npm", name: uniq("Agent NPM"), config: { baseUrl: B.url }, credentials: { token: c.id } });
    expect(draft.status).toBe("draft");
    expect(draft.secrets[0]).toMatchObject({ key: "token", credentialId: c.id });
    expect(credRepo.getCredentialRow(c.id)!.lockedOrigins).toEqual([new URL(A.url).origin]); // agents never lock
    expect(() => svc.publishDraft(owner, draft.id, { secrets: {} })).toThrow(creds.OriginConfirmNeeded);
    expect(() => svc.publishDraft(owner, draft.id, { secrets: {}, confirmOrigins: true }, { stepUpFresh: false })).toThrow(creds.OriginStepUpNeeded);
    expect(svc.getIntegration(owner, draft.id).status).toBe("draft");
    const live = svc.publishDraft(owner, draft.id, { secrets: {}, confirmOrigins: true }, { stepUpFresh: true });
    expect(live.status).toBe("active");
    expect(credRepo.getCredentialRow(c.id)!.lockedOrigins).toContain(new URL(B.url).origin);
  });
  it("an unlocked credential proposed by an agent locks on publish after the confirm and a step-up (r6)", () => {
    const c = tokenCred();
    const draft = svc.createIntegration(agent, { packageId: "npm", name: uniq("Agent NPM"), config: { baseUrl: A.url }, secrets: {}, credentials: { token: c.id } });
    expect(() => svc.publishDraft(owner, draft.id, { secrets: {} })).toThrow(creds.OriginConfirmNeeded);
    expect(() => svc.publishDraft(owner, draft.id, { secrets: {}, confirmOrigins: true })).toThrow(creds.OriginStepUpNeeded);
    expect(credRepo.getCredentialRow(c.id)!.lockedOrigins).toEqual([]);
    svc.publishDraft(owner, draft.id, { secrets: {}, confirmOrigins: true }, { stepUpFresh: true });
    expect(credRepo.getCredentialRow(c.id)!.lockedOrigins).toEqual([new URL(A.url).origin]);
  });
  it("only a person can add a server: agents never lock, bearer principals never confirm", () => {
    const c = tokenCred(owner, A.url);
    expect(() => creds.guardLocks(agent, creds.locksNeeded([c.id], new URL(B.url).origin), { confirmOrigins: true, stepUpFresh: true })).toThrow(/Only a signed-in person/);
  });
  it("attaching a credential to an existing live field locks it too", () => {
    const c = tokenCred(owner, A.url);
    const i = svc.createIntegration(owner, { packageId: "npm", name: uniq("Own token"), config: { baseUrl: B.url }, secrets: { token: TOKEN }, untested: true });
    expect(() => svc.saveSecrets(owner, i.id, {}, { credentials: { token: c.id } })).toThrow(creds.OriginConfirmNeeded);
    const v = svc.saveSecrets(owner, i.id, {}, { credentials: { token: c.id }, confirmOrigins: true }, { stepUpFresh: true });
    expect(v.secretFields[0]).toMatchObject({ viaCredential: true, set: true });
    // Switching back to its own value removes the reference.
    const back = svc.saveSecrets(owner, i.id, { token: TOKEN });
    expect(back.secretFields[0]!.viaCredential).toBe(false);
    expect(creds.toCredential(credRepo.getCredentialRow(c.id)!).usedBy).toEqual([]);
  });
});

describe("send time: the credential only reaches its locked servers (criteria 23 to 25)", () => {
  it("a stored address changed underneath (not through publish) gets no credential", async () => {
    const c = tokenCred(owner, A.url);
    const i = npmWith(c.id);
    B.seen.length = 0;
    const row = repo.getIntegrationRow(i.id)!;
    repo.updateIntegration(i.id, { config: { ...row.config, baseUrl: B.url } });
    const r = await runtime.readEndpoint(i.id, "proxy-hosts", {});
    expect(r).toMatchObject({ ok: false, error: { code: "permission" } });
    expect(leaked(B.seen)).toBe(false);
    record("drifted address read with credential", r, B.seen);
  });
  it("a lock list that includes B is still not enough while the integration's pin says A", async () => {
    const c = tokenCred(owner, A.url);
    const i = npmWith(c.id);
    credRepo.touchCredential(c.id, { lockedOrigins: [new URL(A.url).origin, new URL(B.url).origin] });
    repo.updateIntegration(i.id, { config: { baseUrl: B.url } });
    B.seen.length = 0;
    const r = await runtime.readEndpoint(i.id, "proxy-hosts", {});
    expect(r).toMatchObject({ ok: false, error: { code: "permission", message: expect.stringContaining("only sent to the address it was saved for") } });
    expect(leaked(B.seen)).toBe(false);
  });
  it("a pin that says B is not enough while the credential is only locked to A", async () => {
    const { recordPin } = await import("../host/secrets");
    const c = tokenCred(owner, A.url);
    const i = npmWith(c.id);
    repo.updateIntegration(i.id, { config: { baseUrl: B.url } });
    recordPin(i.id, new URL(B.url).origin);
    B.seen.length = 0;
    const r = await runtime.readEndpoint(i.id, "proxy-hosts", {});
    expect(r).toMatchObject({ ok: false, error: { code: "permission", message: expect.stringContaining(`is locked to ${new URL(A.url).origin}`) } });
    expect(leaked(B.seen)).toBe(false);
    record("pin moved, lock not", r, B.seen);
  });
  it("a redirect from the locked server to another origin never carries the credential", async () => {
    const c = tokenCred(owner, A.url);
    const i = svc.createIntegration(owner, { packageId: "npm", name: uniq("Redir"), config: { baseUrl: `${A.url}/redir/` }, secrets: {}, credentials: { token: c.id }, untested: true });
    B.seen.length = 0;
    const t = await svc.testConnection(owner, { packageId: "npm", config: i.config, secrets: {}, integrationId: i.id });
    expect(t).toMatchObject({ ok: false, error: { code: "permission" } });
    expect(B.seen).toEqual([]);
    record("redirect with credential", t, B.seen);
  });
  it("round 2 replay with a credential: a member cannot retarget, test or re-key", async () => {
    const c = tokenCred(owner, A.url);
    const i = npmWith(c.id);
    B.seen.length = 0;
    expect(() => svc.updateIntegration(member, i.id, { config: { baseUrl: B.url } })).toThrow(/Only the owner or the person who added/);
    await expect(svc.testConnection(member, { packageId: "npm", config: { baseUrl: B.url }, secrets: {}, integrationId: i.id })).rejects.toThrow(/Only the owner or the person who added/);
    expect(() => svc.saveSecrets(member, i.id, {}, { credentials: { token: c.id } })).toThrow(/Only the owner/);
    expect(B.seen).toEqual([]);
  });
  it("round 2 replay with a credential: a test with another baseUrl does not send it there", async () => {
    const c = tokenCred(owner, A.url);
    const i = npmWith(c.id);
    B.seen.length = 0;
    const t = await svc.testConnection(owner, { packageId: "npm", config: { baseUrl: B.url }, secrets: {}, integrationId: i.id });
    expect(t).toMatchObject({ ok: false, error: { code: "permission" } });
    expect(B.seen.every((s) => s.headers.authorization === undefined)).toBe(true);
    record("test with foreign baseUrl, credential", t, B.seen);
  });
  it("round 2 replay with a credential: another scheme or port on the same host is another address", async () => {
    const { vaultResolver } = await import("../host/secrets");
    const c = tokenCred(owner, A.url);
    const i = npmWith(c.id);
    const resolve = vaultResolver({ integrationId: i.id, pinOrigin: new URL(A.url).origin });
    await expect(resolve("token", new URL(A.url).origin.replace("http:", "https:"))).rejects.toMatchObject({ adapterError: { code: "permission" } });
    await expect(resolve("token", `http://127.0.0.1:${A.port + 1}`)).rejects.toMatchObject({ adapterError: { code: "permission" } });
    await expect(resolve("token", new URL(A.url).origin)).resolves.toMatchObject({ value: TOKEN });
  });
  it("round 2 replay with a credential: Try it refuses a redirect to another host and scrubs an echoed Basic header", async () => {
    const r0 = await tryIt.runTry({ curl: `curl -u ${BASIC_USER}:placeholder-pass ${A.url}/echo` }, owner.userId);
    if (!r0.ok || !r0.pendingId) throw new Error("setup");
    const i = svc.createIntegration(owner, { packageId: "custom-api", name: uniq("Basic probe"), config: { baseUrl: A.url, username: "ignored" }, secrets: {}, pendingId: r0.pendingId, untested: true });
    const basic = creds.createCredential(owner, { name: uniq("Probe login"), kind: "username-password", values: { username: BASIC_USER, password: BASIC_PASS }, server: A.url });
    const key = i.secretFields[0]!.key;
    svc.saveSecrets(owner, i.id, {}, { credentials: { [key]: basic.id } });
    const row = repo.getIntegrationRow(i.id)!;
    const auth = { integrationId: i.id, origin: new URL(A.url).origin, fields: row.secretFields as never, config: row.config };
    B.seen.length = 0;
    const redir = await tryIt.runTry({ url: `${A.url}/redir/api/users/me`, auth: { integrationId: i.id } }, owner.userId, auth);
    expect(redir).toMatchObject({ ok: false, error: { code: "permission" } });
    expect(B.seen).toEqual([]);
    const echo = await tryIt.runTry({ url: `${A.url}/echo`, auth: { integrationId: i.id } }, owner.userId, auth);
    expect(echo.ok).toBe(true);
    expect(leaked(echo)).toBe(false);
    expect(A.seen.at(-1)?.headers.authorization).toBe(`Basic ${Buffer.from(`${BASIC_USER}:${BASIC_PASS}`).toString("base64")}`);
    record("try it with credential: redirect refused, echo scrubbed", { redirect: redir, echoScrubbed: !leaked(echo) }, B.seen);
  });
});

describe("last used, rotation, deletion (criteria 27 to 32)", () => {
  it("last used records the time a value was attached", async () => {
    const c = tokenCred(owner, A.url);
    const i = npmWith(c.id);
    expect(credRepo.getCredentialRow(c.id)!.lastUsedAt).toBeNull();
    const before = Date.now();
    const r = await runtime.readEndpoint(i.id, "proxy-hosts", {});
    expect(r.ok).toBe(true);
    expect(credRepo.getCredentialRow(c.id)!.lastUsedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });
  it("rotation switches every user at once and drops their cached values", async () => {
    const { readThrough, dataRuntime } = await import("@/features/data/runtime");
    const { cacheKey } = await import("@/features/data/keys");
    const c = tokenCred(owner, A.url);
    const i1 = npmWith(c.id);
    const i2 = npmWith(c.id);
    for (const i of [i1, i2]) expect((await readThrough({ integrationId: i.id, endpointId: "proxy-hosts", params: {} }, 60)).state).toBe("fresh");
    currentToken = TOKEN_NEW; // the service now only accepts the new value
    try {
      const t0 = performance.now();
      creds.rotateCredential(owner, c.id, { values: { token: TOKEN_NEW } });
      for (const i of [i1, i2]) expect(dataRuntime().cache.get(cacheKey({ integrationId: i.id, endpointId: "proxy-hosts", params: {} }))).toBeUndefined();
      expect(performance.now() - t0).toBeLessThan(1000);
      for (const i of [i1, i2]) expect((await runtime.readEndpoint(i.id, "proxy-hosts", {})).ok).toBe(true);
      const a = auditRows().filter((r) => r.event === "credential.updated" && r.targetId === c.id);
      expect(a).toHaveLength(1);
      expect(a[0]!.detail).toMatchObject({ credential: c.name, changedFields: ["Token"] });
      expect(leaked(a)).toBe(false);
    } finally {
      currentToken = TOKEN;
    }
  });
  it("a blank field keeps its value on rotation", async () => {
    const basic = creds.createCredential(owner, { name: uniq("Login"), kind: "username-password", values: { username: BASIC_USER, password: BASIC_PASS }, server: A.url });
    creds.rotateCredential(owner, basic.id, { values: { username: "", password: BASIC_PASS } });
    expect(() => creds.rotateCredential(owner, basic.id, { values: { username: "", password: "" } })).toThrow(/at least one/);
    const t = await svc.testConnection(owner, { packageId: "prometheus", config: { baseUrl: A.url, authMode: "basic" }, secrets: {}, credentials: { password: basic.id } });
    expect(t.ok).toBe(true);
  });
  it("a credential in use cannot be deleted; the refusal lists the integrations", async () => {
    const c = tokenCred(owner, A.url);
    const i = npmWith(c.id);
    expect(() => creds.deleteCredential(owner, c.id)).toThrow(`${c.name} is used by ${i.name}. Switch them to another credential first.`);
    expect((await runtime.readEndpoint(i.id, "proxy-hosts", {})).ok).toBe(true);
    // Deleting the integration frees it; then it can be deleted, values and all.
    svc.deleteIntegration(owner, i.id);
    expect(creds.toCredential(credRepo.getCredentialRow(c.id)!).usedBy).toEqual([]);
    creds.deleteCredential(owner, c.id);
    expect(credRepo.getCredentialRow(c.id)).toBeUndefined();
    const { secretStatus } = await import("@/features/vault");
    expect(secretStatus("credential", c.id)).toEqual([]);
    expect(auditRows().filter((r) => r.event === "credential.deleted" && r.targetId === c.id)).toHaveLength(1);
  });
});

describe("agents (criteria 26, 33 to 36)", () => {
  it("credentials.list returns usable credentials with names, kinds, servers and usage, never a value", async () => {
    const mine = creds.createCredential(member, { name: uniq("Member PVE"), kind: "proxmox-token", values: { tokenId: PVE_ID, secret: PVE_SECRET } });
    const out = await tool("credentials.list")(memberAgent, {});
    const found = (out as { credentials: { id: string }[] }).credentials.find((c) => c.id === mine.id);
    expect(found).toMatchObject({ name: mine.name, kind: "proxmox-token", lockedOrigins: [], usedBy: [], fields: [{ key: "tokenId", set: true }, { key: "secret", set: true }] });
    expect((out as { credentials: { createdBy?: string }[] }).credentials.every((c) => c.createdBy === undefined)).toBe(true);
    expect(leaked(out)).toBe(false);
    expect(JSON.stringify(out)).not.toContain(PVE_ID);
  });
  it("integrations.update and request_credentials take a saved credential; the link page gets it", async () => {
    const c = tokenCred(owner, A.url);
    const d = await tool("integrations.create")(agent, { packageId: "npm", name: uniq("Agent"), config: { baseUrl: A.url } });
    const u = await tool("integrations.update")(agent, { integrationId: d.id, credentials: { token: c.id } });
    expect(u.secrets[0]).toMatchObject({ key: "token", set: true, credentialId: c.id });
    await expect(tool("integrations.update")(agent, { integrationId: d.id, credentials: { token: "nope" } })).rejects.toThrow(/^API token: pick a saved token you can use/);
    const cleared = await tool("integrations.update")(agent, { integrationId: d.id, credentials: { token: "" } });
    expect(cleared.secrets[0]).toMatchObject({ set: false });
    const link = await tool("integrations.request_credentials")(agent, { integrationId: d.id, credentials: { token: c.id } });
    expect(link.credentialsUrl).toMatch(/\/integrations\/.+\/credentials\?draft=/);
    expect(svc.getIntegration(owner, d.id).secretFields[0]!.credential?.id).toBe(c.id);
  });
  it("integrations.test on a draft whose server is not in the proposed credential's list sends nothing", async () => {
    const c = tokenCred(owner, A.url);
    const d = await tool("integrations.create")(agent, { packageId: "npm", name: uniq("Agent B"), config: { baseUrl: B.url }, credentials: { token: c.id } });
    B.seen.length = 0;
    const h = await tool("integrations.test")(agent, { integrationId: d.id });
    expect(h).toMatchObject({ status: "down", message: expect.stringContaining(`is locked to ${new URL(A.url).origin}`) });
    expect(leaked(B.seen)).toBe(false);
    expect(B.seen.every((s) => s.headers.authorization === undefined)).toBe(true);
    record("agent test on unlisted server", h, B.seen);
  });
  it("a member's agent cannot propose another member's or the owner's credential", async () => {
    const c = tokenCred(owner, A.url);
    await expect(tool("integrations.create")(memberAgent, { packageId: "npm", name: uniq("M"), config: { baseUrl: A.url }, credentials: { token: c.id } })).rejects.toThrow(/pick a saved token you can use/);
  });
  it("no tool creates, rotates, reads or deletes a credential, and no tool output carries a value", () => {
    const names = tools.integrationTools.map((t) => t.name).filter((n) => n.startsWith("credentials."));
    expect(names).toEqual(["credentials.list"]);
    expect(tools.integrationTools.find((t) => t.name === "credentials.list")!.effect).toBe("none");
    expect(leaked(readFileSync(TRAFFIC, "utf8"))).toBe(false);
  });
});
