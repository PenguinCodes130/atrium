// Round 5 (Fix List r2 items 4 and 11): credentials that lock by mistake. Rename a credential and
// remove a server from its lock list (owner or creator; always a step-up since round 6; audited as
// credential.updated with the removed origin); an integration on a removed server fails its reads
// with the permission error until it is allowed again; Test connection before the first save with an
// unlocked credential needs the confirm and a step-up and locks it (round 6, Fix List r3 item 1); a
// bare host:port server gets http://. Local test servers A and B only; test-only secret values.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
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
const agent: Principal = { kind: "agent", userId: "u-owner", role: "owner", via: "pat", tokenId: "t-owner", agentName: "Claude", scopes: ["atrium:read", "atrium:edit"] };

const TOKEN = "atrium-r5-FAKE-cred-token-a41c";
const EVIDENCE = path.resolve(__dirname, "../../../../evidence/integrations/r6/security/credentials-r5.jsonl");
mkdirSync(path.dirname(EVIDENCE), { recursive: true });
writeFileSync(EVIDENCE, "");
const record = (test: string, data: unknown) => appendFileSync(EVIDENCE, `${JSON.stringify({ test, ...(data as object) })}\n`);

let svc: typeof import("../service");
let creds: typeof import("../credentials/service");
let credRepo: typeof import("../credentials/repo");
let auditRows: () => { event: string; targetId: string | null; detail: Record<string, unknown> | null }[];
let A: Awaited<ReturnType<typeof httpServer>>;
let B: Awaited<ReturnType<typeof httpServer>>;

function npmLike(name: string) {
  return (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/api/") return json(res, 200, { status: "OK", version: { major: 2, minor: 12, revision: 6 }, server: name });
    if (u.pathname === "/api/users/me") return req.headers.authorization === `Bearer ${TOKEN}` ? json(res, 200, { id: 1 }) : json(res, 401, {});
    if (u.pathname === "/redir/api/") return json(res, 200, { status: "OK", version: { major: 2, minor: 12, revision: 6 } });
    if (u.pathname === "/redir/api/users/me") return redirect(res, `${B.url}/capture`);
    json(res, 404, {});
  };
}

beforeAll(async () => {
  svc = await import("../service");
  creds = await import("../credentials/service");
  credRepo = await import("../credentials/repo");
  const { db } = await import("@/core/db");
  const { auditLog } = await import("@/db/schema/audit");
  auditRows = () => db().select().from(auditLog).all().map((r) => ({ event: r.event, targetId: r.targetId, detail: r.detail ?? null }));
  B = await httpServer(npmLike("B"));
  A = await httpServer(npmLike("A"));
});
afterAll(async () => { await A.close(); await B.close(); });

let n = 0;
const uniq = (s: string) => `${s} ${++n}`;
const tokenCred = (p: User = owner, server?: string) => creds.createCredential(p, { name: uniq("Token"), kind: "token", values: { token: TOKEN }, ...(server ? { server } : {}) });
const npmWith = (cid: string, url = A.url, p: User = owner) => svc.createIntegration(p, { packageId: "npm", name: uniq("NPM"), config: { baseUrl: url }, secrets: {}, credentials: { token: cid }, untested: true });
const updatedEntries = (id: string) => auditRows().filter((r) => r.event === "credential.updated" && r.targetId === id);
const a = () => new URL(A.url).origin;
const b = () => new URL(B.url).origin;

describe("rename (item 4)", () => {
  it("the creator renames; audited as credential.updated with the old name; no value anywhere", () => {
    const c = tokenCred(member);
    const v = creds.updateCredential(member, c.id, { name: "  Renamed by member  " });
    expect(v.name).toBe("Renamed by member");
    expect(updatedEntries(c.id).at(-1)!.detail).toMatchObject({ credential: "Renamed by member", renamedFrom: c.name });
    expect(JSON.stringify(auditRows())).not.toContain(TOKEN);
  });
  it("the owner may rename a member's credential; another member may not, and learns nothing", () => {
    const c = tokenCred(member);
    expect(creds.updateCredential(owner, c.id, { name: uniq("Owner renamed") }).id).toBe(c.id);
    expect(() => creds.updateCredential(member2, c.id, { name: "x" })).toThrow(/does not exist/);
  });
  it("a blank or duplicate name is refused naming the field; agents never can", () => {
    const c1 = tokenCred();
    const c2 = tokenCred();
    expect(() => creds.updateCredential(owner, c1.id, { name: "  " })).toThrow(/^Name: give the credential a name/);
    expect(() => creds.updateCredential(owner, c1.id, { name: c2.name.toUpperCase() })).toThrow(/^Name: there is already/);
    expect(() => creds.updateCredential(agent, c1.id, { name: "x" })).toThrow(/Only a signed-in person/);
    // Same name in a different case is a rename of itself, allowed.
    expect(creds.updateCredential(owner, c1.id, { name: c1.name.toUpperCase() }).name).toBe(c1.name.toUpperCase());
  });
});

describe("remove a server (item 4)", () => {
  it("an unused credential: removed only with a step-up (r6 item 1), audited with the removed origin", () => {
    const c = tokenCred(owner, A.url);
    expect(() => creds.updateCredential(owner, c.id, { removeOrigins: [A.url] })).toThrow(creds.RemoveStepUpNeeded);
    expect(credRepo.getCredentialRow(c.id)!.lockedOrigins).toEqual([a()]);
    const v = creds.updateCredential(owner, c.id, { removeOrigins: [A.url] }, { stepUpFresh: true });
    expect(v.lockedOrigins).toEqual([]);
    expect(updatedEntries(c.id).at(-1)!.detail).toMatchObject({ origin: a(), removedOrigins: [a()] });
  });
  it("a server not on the list is refused; nothing changes", () => {
    const c = tokenCred(owner, A.url);
    expect(() => creds.updateCredential(owner, c.id, { removeOrigins: [B.url] }, { stepUpFresh: true })).toThrow(/is not locked to/);
    expect(credRepo.getCredentialRow(c.id)!.lockedOrigins).toEqual([a()]);
  });
  it("a credential in use: without a fresh step-up it is refused (step_up_required) and nothing changes", () => {
    const c = tokenCred(owner, A.url);
    npmWith(c.id);
    const before = updatedEntries(c.id).length;
    expect(() => creds.updateCredential(owner, c.id, { removeOrigins: [A.url] })).toThrow(creds.RemoveStepUpNeeded);
    expect(() => creds.updateCredential(owner, c.id, { removeOrigins: [A.url] }, { stepUpFresh: false })).toThrow(/Confirm it is you/);
    expect(credRepo.getCredentialRow(c.id)!.lockedOrigins).toEqual([a()]);
    expect(updatedEntries(c.id).length).toBe(before);
  });
  it("with a step-up it is removed; the integration's reads then fail Not permitted until it is allowed again", async () => {
    const c = tokenCred(owner, A.url);
    // Locked to A and B (the typo case: B is the wrong one), used by an integration on B.
    const i = svc.createIntegration(owner, { packageId: "npm", name: uniq("NPM typo"), config: { baseUrl: B.url }, secrets: {}, credentials: { token: c.id }, untested: true, confirmOrigins: true }, { stepUpFresh: true });
    expect(credRepo.getCredentialRow(c.id)!.lockedOrigins).toEqual([a(), b()]);
    B.seen.length = 0;
    const v = creds.updateCredential(owner, c.id, { removeOrigins: [B.url] }, { stepUpFresh: true });
    expect(v.lockedOrigins).toEqual([a()]);
    expect(updatedEntries(c.id).at(-1)!.detail).toMatchObject({ origin: b() });
    const t = await svc.testConnection(owner, { packageId: "npm", config: i.config, secrets: {}, integrationId: i.id });
    record("read after the server was removed", { outcome: t, bSawAuthorization: B.seen.filter((s) => s.headers.authorization).length });
    expect(t).toMatchObject({ ok: false, heading: "Not permitted", error: { code: "permission" } });
    expect(B.seen.filter((s) => s.headers.authorization)).toEqual([]);
    // Saving the connection with the same pick asks again: confirm, then step-up, then it reads.
    expect(() => svc.saveSecrets(owner, i.id, {}, { credentials: { token: c.id } })).toThrow(creds.OriginConfirmNeeded);
    expect(() => svc.saveSecrets(owner, i.id, {}, { credentials: { token: c.id }, confirmOrigins: true })).toThrow(creds.OriginStepUpNeeded);
    expect(credRepo.getCredentialRow(c.id)!.lockedOrigins).toEqual([a()]);
    svc.saveSecrets(owner, i.id, {}, { credentials: { token: c.id }, confirmOrigins: true }, { stepUpFresh: true });
    expect(credRepo.getCredentialRow(c.id)!.lockedOrigins).toEqual([a(), b()]);
    expect((await svc.testConnection(owner, { packageId: "npm", config: i.config, secrets: {}, integrationId: i.id })).ok).toBe(true);
  });
  it("removing every server leaves it unlocked; the next save needs the confirm and a step-up again (r6 item 1)", async () => {
    const c = tokenCred(owner, A.url);
    const i = npmWith(c.id);
    creds.updateCredential(owner, c.id, { removeOrigins: [A.url] }, { stepUpFresh: true });
    expect((await svc.testConnection(owner, { packageId: "npm", config: i.config, secrets: {}, integrationId: i.id })).ok).toBe(false);
    expect(() => svc.saveSecrets(owner, i.id, {}, { credentials: { token: c.id } })).toThrow(creds.OriginConfirmNeeded);
    expect(() => svc.saveSecrets(owner, i.id, {}, { credentials: { token: c.id }, confirmOrigins: true })).toThrow(creds.OriginStepUpNeeded);
    expect(credRepo.getCredentialRow(c.id)!.lockedOrigins).toEqual([]);
    svc.saveSecrets(owner, i.id, {}, { credentials: { token: c.id }, confirmOrigins: true }, { stepUpFresh: true });
    expect(credRepo.getCredentialRow(c.id)!.lockedOrigins).toEqual([a()]);
  });
  it("another member cannot remove a server, and a bare host:port is understood", () => {
    const c = tokenCred(member, A.url);
    expect(() => creds.updateCredential(member2, c.id, { removeOrigins: [A.url] })).toThrow(/does not exist/);
    expect(creds.updateCredential(member, c.id, { removeOrigins: [`127.0.0.1:${A.port}`] }, { stepUpFresh: true }).lockedOrigins).toEqual([]);
  });
});

// Round 6 (Fix List r3 item 1) replaced the round 5 "trial": a test before the first save with an
// unlocked credential needs the confirm and a fresh step-up, and locks it to the tested server
// (audited as credential.locked, via "test") before anything is sent.
const confirmed = { confirmOrigins: true } as const;
const fresh = { stepUpFresh: true } as const;

describe("Test connection before the first save (item 4, rule from r6 item 1)", () => {
  it("an unlocked credential: refused without the confirm and a step-up; with both it is locked, audited, then sent", async () => {
    const c = tokenCred();
    const audits = auditRows().length;
    A.seen.length = 0;
    await expect(svc.testConnection(owner, { packageId: "npm", config: { baseUrl: A.url }, secrets: {}, credentials: { token: c.id } })).rejects.toThrow(creds.OriginConfirmNeeded);
    await expect(svc.testConnection(owner, { packageId: "npm", config: { baseUrl: A.url }, secrets: {}, credentials: { token: c.id }, ...confirmed })).rejects.toThrow(creds.OriginStepUpNeeded);
    expect(A.seen.filter((s) => s.headers.authorization)).toEqual([]);
    expect(auditRows().length).toBe(audits);
    const t = await svc.testConnection(owner, { packageId: "npm", config: { baseUrl: A.url }, secrets: {}, credentials: { token: c.id }, ...confirmed }, fresh);
    record("test before first save", { outcome: t, aSawAuthorization: A.seen.filter((s) => s.headers.authorization).length });
    expect(t).toMatchObject({ ok: true });
    expect(A.seen.some((s) => s.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
    const row = credRepo.getCredentialRow(c.id)!;
    expect(row.lockedOrigins).toEqual([a()]);
    expect(row.lastUsedAt).not.toBeNull();
    expect(auditRows().filter((r) => r.event === "credential.locked" && r.targetId === c.id).map((r) => r.detail)).toEqual([expect.objectContaining({ origin: a(), via: "test", firstUse: true })]);
  });
  it("the passing test lets Save go through without another test or step-up", async () => {
    const c = tokenCred();
    const t = await svc.testConnection(owner, { packageId: "npm", config: { baseUrl: A.url }, secrets: {}, credentials: { token: c.id }, ...confirmed }, fresh);
    if (!t.ok) throw new Error("setup");
    const i = svc.createIntegration(owner, { packageId: "npm", name: uniq("NPM tested"), config: { baseUrl: A.url }, secrets: {}, credentials: { token: c.id }, ...(t.passId ? { passId: t.passId } : {}) });
    expect(i.untested).toBe(false);
    expect(credRepo.getCredentialRow(c.id)!.lockedOrigins).toEqual([a()]);
  });
  it("a redirect to another server during the test never carries it", async () => {
    const c = tokenCred();
    B.seen.length = 0;
    const t = await svc.testConnection(owner, { packageId: "npm", config: { baseUrl: `${A.url}/redir` }, secrets: {}, credentials: { token: c.id }, ...confirmed }, fresh);
    record("trial redirect", { outcome: t, bSaw: B.seen.map((s) => ({ url: s.url, authorization: s.headers.authorization ? "present" : null })) });
    expect(t.ok).toBe(false);
    expect(B.seen.filter((s) => s.headers.authorization)).toEqual([]);
  });
  it("one locked elsewhere is still never sent, and an agent's test never uses a pick", async () => {
    const c = tokenCred(owner, A.url);
    B.seen.length = 0;
    const t = await svc.testConnection(owner, { packageId: "npm", config: { baseUrl: B.url }, secrets: {}, credentials: { token: c.id }, ...confirmed }, fresh);
    expect(t).toMatchObject({ ok: false, error: { code: "permission" } });
    expect(B.seen.filter((s) => s.headers.authorization)).toEqual([]);
    const u = tokenCred();
    A.seen.length = 0;
    await svc.testConnection(agent, { packageId: "npm", config: { baseUrl: A.url }, secrets: {}, credentials: { token: u.id } });
    expect(A.seen.filter((s) => s.headers.authorization)).toEqual([]);
  });
  it("a member cannot trial another member's credential", async () => {
    const c = tokenCred(member);
    await expect(svc.testConnection(member2, { packageId: "npm", config: { baseUrl: A.url }, secrets: {}, credentials: { token: c.id } })).rejects.toThrow(/pick a saved token you can use/);
  });
});

describe("server field (item 11)", () => {
  it("a bare host:port gets http://; ftp and non-URLs are still refused", () => {
    const c = creds.createCredential(owner, { name: uniq("Bare"), kind: "token", values: { token: TOKEN }, server: "10.77.99.7:9090" });
    expect(c.lockedOrigins).toEqual(["http://10.77.99.7:9090"]);
    expect(() => creds.createCredential(owner, { name: uniq("Ftp"), kind: "token", values: { token: TOKEN }, server: "ftp://x" })).toThrow(/^Server:/);
    expect(() => creds.createCredential(owner, { name: uniq("Nope"), kind: "token", values: { token: TOKEN }, server: "not a url" })).toThrow(/^Server:/);
    expect(() => creds.createCredential(owner, { name: uniq("Js"), kind: "token", values: { token: TOKEN }, server: "javascript:alert(1)" })).toThrow(/^Server:/);
  });
});
