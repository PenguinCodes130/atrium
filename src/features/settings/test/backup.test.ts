// settings round 1: backups (AC 37 to 45). Two throwaway instances with different master keys
// (generated per run), a stand-in NPM server that checks the bearer token, and generated test-only
// secret values. Nothing here is a real credential.
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/core/contracts";
import { freshDataDir, useInstance } from "./harness";

const TOKEN = `atrium-settings-FAKE-token-${randomBytes(6).toString("hex")}`;
const DIRECT = `atrium-settings-FAKE-direct-${randomBytes(6).toString("hex")}`;
const PASSWORD = `fake-backup-pass-${randomBytes(4).toString("hex")}`;
const SECRETS = [TOKEN, DIRECT, PASSWORD];
const keyA = randomBytes(32).toString("base64");
const keyB = randomBytes(32).toString("base64");

const ownerA: Extract<Principal, { kind: "user" }> = { kind: "user", userId: "u-owner-a", role: "owner", via: "session" };
const ownerB: Extract<Principal, { kind: "user" }> = { kind: "user", userId: "u-owner-b", role: "owner", via: "session" };
const memberB: Principal = { kind: "user", userId: "u-member-b", role: "member", via: "session" };

let server: Server;
let base = "";
let seen: string[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(String(req.headers.authorization ?? ""));
    const u = new URL(req.url ?? "/", "http://x");
    res.setHeader("content-type", "application/json");
    if (u.pathname === "/api/") return res.end(JSON.stringify({ status: "OK", version: { major: 2, minor: 12, revision: 6 } }));
    if (u.pathname === "/api/users/me") {
      res.statusCode = req.headers.authorization === `Bearer ${TOKEN}` ? 200 : 401;
      return res.end(JSON.stringify({ id: 1 }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

async function instance(dir: string, key: string | undefined) {
  vi.resetModules();
  useInstance(dir, { ATRIUM_MASTER_KEY: key });
  const { sqlite } = await import("@/core/db");
  return {
    sqlite,
    exp: await import("@/features/backup/export"),
    imp: await import("@/features/backup/import"),
    tables: await import("@/features/backup/tables"),
    creds: await import("@/features/integrations/credentials/service"),
    svc: await import("@/features/integrations/service"),
    vault: await import("@/features/vault"),
    themes: await import("@/features/themes/store"),
  };
}

function addUser(db: ReturnType<Awaited<ReturnType<typeof instance>>["sqlite"]>, id: string, email: string, role: string) {
  const now = Date.now();
  db.prepare(`INSERT INTO "user" (id, name, email, email_verified, role, two_factor_enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)`).run(id, id, email, role, role === "member" ? 1 : 0, now, now);
  db.prepare(`INSERT INTO allowlist (id, pattern, role, created_at) VALUES (?, ?, ?, ?)`).run(`al-${id}`, email, role, now);
}

/** Every table's rows, for before and after comparisons. */
function snapshot(db: ReturnType<Awaited<ReturnType<typeof instance>>["sqlite"]>): string {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name).filter((n) => n !== "auth_rate_limit");
  return JSON.stringify(names.map((n) => [n, db.prepare(`SELECT * FROM "${n}" ORDER BY rowid`).all()]));
}

const textOf = (files: Map<string, Buffer>, name: string) => files.get(name)!.toString("utf8");

describe("backups", () => {
  const dirA = freshDataDir();
  const dirB = freshDataDir();
  let withSecrets: Buffer;
  let without: Buffer;
  let credId = "";
  let lockedA: string[] = [];
  let intIds: string[] = [];

  it("A: two integrations share a credential locked to one server; one has its own sealed value", async () => {
    const a = await instance(dirA, keyA);
    addUser(a.sqlite(), ownerA.userId, "owner-a@atrium.test", "owner");
    addUser(a.sqlite(), "u-member-a", "member-a@atrium.test", "member");
    a.themes.createTheme(ownerA, { ...(await import("@/features/shell")).dusk, name: "Kept theme" });
    const c = a.creds.createCredential(ownerA, { name: "NPM token", kind: "token", values: { token: TOKEN } });
    credId = c.id;
    const i1 = a.svc.createIntegration(ownerA, { packageId: "npm", name: "NPM one", config: { baseUrl: base }, secrets: {}, credentials: { token: c.id }, untested: true, confirmOrigins: true }, { confirmOrigins: true, stepUpFresh: true });
    const i2 = a.svc.createIntegration(ownerA, { packageId: "npm", name: "NPM two", config: { baseUrl: base }, secrets: {}, credentials: { token: c.id }, untested: true, confirmOrigins: true }, { confirmOrigins: true, stepUpFresh: true });
    intIds = [i1.id, i2.id];
    a.vault.seal({ ownerType: "setup-agent", ownerId: ownerA.userId, key: "apiKey" }, DIRECT);
    lockedA = (a.sqlite().prepare("SELECT locked_origins FROM credential WHERE id = ?").get(c.id) as { locked_origins: string }).locked_origins as unknown as string[];
    expect(JSON.parse(String(lockedA))).toEqual([base]);
    for (const id of intIds) expect((await a.svc.testConnection(ownerA, { packageId: "npm", config: { baseUrl: base }, secrets: {}, integrationId: id })).ok).toBe(true);
  });

  it("export refuses a weak or mismatched password and non-owners (AC 36, 37)", async () => {
    const a = await instance(dirA, keyA);
    await expect(a.exp.exportBackup(ownerA, { includeSecrets: true, password: PASSWORD, passwordAgain: `${PASSWORD}x` })).rejects.toThrow("The two passwords do not match.");
    await expect(a.exp.exportBackup(ownerA, { includeSecrets: true, password: "short", passwordAgain: "short" })).rejects.toThrow(/at least 12/);
    await expect(a.exp.exportBackup({ ...ownerA, role: "member" }, { includeSecrets: false })).rejects.toThrow(/Only the owner/);
  });

  it("without secrets: zero hits for every seeded value in every file; with secrets: only in secrets.enc (AC 38, 39, 45)", async () => {
    const a = await instance(dirA, keyA);
    const { readZip } = await import("@/features/settings/zip");
    without = (await a.exp.exportBackup(ownerA, { includeSecrets: false })).bytes;
    const w = readZip(without);
    for (const [, buf] of w) for (const s of SECRETS) expect(buf.includes(Buffer.from(s))).toBe(false);
    withSecrets = (await a.exp.exportBackup(ownerA, { includeSecrets: true, password: PASSWORD, passwordAgain: PASSWORD })).bytes;
    const f = readZip(withSecrets);
    for (const [name, buf] of f) for (const s of SECRETS) expect(buf.includes(Buffer.from(s)), `${s} in ${name}`).toBe(false);
    expect(f.has("secrets.enc")).toBe(true);
    const manifest = JSON.parse(textOf(f, "manifest.json"));
    expect(manifest).toMatchObject({ format: "atrium-backup", version: 1, includesSecrets: true });
    expect(manifest.secrets).toMatchObject({ kdf: "scrypt", N: 131072, r: 8, p: 1, count: 4 });
    const names = [...f.keys()];
    for (const never of ["session", "account", "two_factor", "guest_link", "guest_session", "account_link", "secret", "endpoint_cache", "credential_link", "agent_token", "push_subscription"]) expect(names).not.toContain(`data/${never}.json`);
    expect(names.some((n) => /master\.key/.test(n))).toBe(false);
    const cred = JSON.parse(textOf(f, "data/credential.json"));
    expect(cred[0]).toMatchObject({ id: credId, name: "NPM token", kind: "token" });
    expect(JSON.parse(cred[0].locked_origins)).toEqual([base]);
    const links = JSON.parse(textOf(f, "data/integration_credential.json"));
    expect(links.map((l: { credential_id: string }) => l.credential_id)).toEqual([credId, credId]);
    const audit = (a.sqlite().prepare("SELECT event, detail FROM audit_log WHERE event = 'backup.exported'").all() as { detail: string }[]).map((r) => JSON.parse(r.detail));
    expect(audit.map((d) => d.withSealedValues)).toEqual([false, true]);
    for (const d of audit) for (const s of SECRETS) expect(JSON.stringify(d)).not.toContain(s);
    // Every table on this instance is classified (exported, audit, or never).
    expect(a.tables.unclassifiedTables().filter((t) => !/^(app|app_|draft_change|library)/.test(t))).toEqual([]);
  });

  it("B refuses a newer schema, a damaged file and a wrong password, with no change (AC 40)", async () => {
    const b = await instance(dirB, keyB);
    addUser(b.sqlite(), ownerB.userId, "owner-b@atrium.test", "owner");
    const { readZip, writeZip } = await import("@/features/settings/zip");
    const before = snapshot(b.sqlite());
    const files = readZip(withSecrets);
    const m = JSON.parse(textOf(files, "manifest.json"));
    const newer = writeZip([...files].map(([name, data]) => ({ name, data: name === "manifest.json" ? Buffer.from(JSON.stringify({ ...m, schemaVersion: "9999_future" })) : data })));
    await expect(b.imp.importBackup(ownerB, newer, { password: PASSWORD })).rejects.toThrow("This backup is from a newer Atrium. Update this Atrium first.");
    const damaged = Buffer.from(withSecrets);
    damaged.fill(0x41, 200, 400);
    await expect(b.imp.importBackup(ownerB, damaged, { password: PASSWORD })).rejects.toThrow(/damaged/);
    await expect(b.imp.importBackup(ownerB, withSecrets, { password: "not-the-password-123" })).rejects.toThrow("The backup password is not right. Nothing was changed.");
    await expect(b.imp.importBackup(ownerB, withSecrets, {})).rejects.toThrow(/Enter its password, or choose Import without secrets/);
    await expect(b.imp.importBackup(memberB, withSecrets, { password: PASSWORD })).rejects.toThrow(/Only the owner/);
    expect(snapshot(b.sqlite())).toBe(before);
  });

  it("a failure forced midway leaves B identical (AC 42)", async () => {
    const b = await instance(dirB, keyB);
    const before = snapshot(b.sqlite());
    await expect(b.imp.importBackup(ownerB, withSecrets, { password: PASSWORD, failAfterTable: "integration" })).rejects.toThrow(/nothing was changed/);
    expect(snapshot(b.sqlite())).toBe(before);
  });

  it("end to end: B restores, integrations pass with no value retyped and no step-up, lock kept, B's key unchanged (AC 43, 45)", async () => {
    const b = await instance(dirB, keyB);
    // A10.6: B's own built-in integration does not count as data, and the import keeps it.
    (await import("@/features/integrations/repo")).ensureSystemIntegration();
    const r = await b.imp.importBackup(ownerB, withSecrets, { password: PASSWORD });
    expect(r.secrets).toBe(4); // the credential, two pinned origins, the setup-agent key
    expect(r.usersToReset).toBe(1);
    seen = [];
    for (const id of intIds) {
      const t = await b.svc.testConnection(ownerB, { packageId: "npm", config: { baseUrl: base }, secrets: {}, integrationId: id });
      expect(t.ok, JSON.stringify(t)).toBe(true);
    }
    expect(seen).toContain(`Bearer ${TOKEN}`);
    const locked = (b.sqlite().prepare("SELECT locked_origins FROM credential WHERE id = ?").get(credId) as { locked_origins: string }).locked_origins;
    expect(JSON.parse(String(locked))).toEqual([base]);
    expect(process.env.ATRIUM_MASTER_KEY).toBe(keyB);
    expect(b.vault.vaultStatus().state).toBe("ready");
    // The file's owner mapped onto B's owner; B's owner login is untouched; the member must reset.
    const users = b.sqlite().prepare(`SELECT id, role, two_factor_enabled FROM "user" ORDER BY id`).all() as { id: string; role: string; two_factor_enabled: number }[];
    expect(users).toEqual([{ id: "u-member-a", role: "member", two_factor_enabled: 0 }, { id: ownerB.userId, role: "owner", two_factor_enabled: 0 }]);
    expect(b.sqlite().prepare("SELECT id FROM integration WHERE id = 'atrium'").get()).toEqual({ id: "atrium" });
    const createdBy = (b.sqlite().prepare("SELECT created_by_id FROM integration WHERE id <> 'atrium'").all() as { created_by_id: string }[]).map((x) => x.created_by_id);
    expect(new Set(createdBy)).toEqual(new Set([ownerB.userId]));
    expect((b.sqlite().prepare("SELECT COUNT(*) AS n FROM secret WHERE owner_type = 'setup-agent' AND owner_id = ?").get(ownerB.userId) as { n: number }).n).toBe(1);
    expect(b.themes.listSavedThemes().map((t) => t.name)).toEqual(["Kept theme"]);
    const imported = (b.sqlite().prepare("SELECT detail FROM audit_log WHERE event = 'backup.imported'").all() as { detail: string }[]);
    expect(imported).toHaveLength(1);
    for (const s of SECRETS) expect(imported[0]!.detail).not.toContain(s);
  });

  it("import onto data needs 'Replace everything'; without it nothing is written (AC 41)", async () => {
    const b = await instance(dirB, keyB);
    const before = snapshot(b.sqlite());
    let err: unknown;
    try { await b.imp.importBackup(ownerB, without, {}); } catch (e) { err = e; }
    expect((err as { code?: string }).code).toBe("replace_required");
    expect((err as Error).message).toMatch(/2 integrations/);
    expect(snapshot(b.sqlite())).toBe(before);
  });

  it("'Import without secrets' marks every integration and credential as needing its value, and writes no secret (AC 44)", async () => {
    const b = await instance(dirB, keyB);
    const r = await b.imp.importBackup(ownerB, withSecrets, { withoutSecrets: true, replace: true });
    expect(r.secrets).toBe(0);
    expect((b.sqlite().prepare("SELECT COUNT(*) AS n FROM secret").get() as { n: number }).n).toBe(0);
    for (const v of b.svc.listIntegrations(ownerB)) expect(v.secrets.every((s) => !s.set || s.credentialId)).toBe(true);
    expect(b.creds.credentialComplete(credId)).toBe(false);
    const t = await b.svc.testConnection(ownerB, { packageId: "npm", config: { baseUrl: base }, secrets: {}, integrationId: intIds[0]! });
    expect(t.ok).toBe(false);
  });

  it("a locked instance refuses an export with secrets at once, naming the cause (409); without secrets it still exports (Fix List 2026-10-19)", async () => {
    // A has sealed values; with its master key gone the vault is locked.
    const a = await instance(dirA, undefined);
    expect(a.vault.vaultStatus().state).toBe("locked");
    const before = (a.sqlite().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'backup.exported'").get() as { n: number }).n;
    let err: unknown;
    const started = Date.now();
    try { await a.exp.exportBackup(ownerA, { includeSecrets: true, password: PASSWORD, passwordAgain: PASSWORD }); } catch (e) { err = e; }
    expect(Date.now() - started).toBeLessThan(1000);
    expect((err as { status?: number }).status).toBe(409);
    expect((err as { code?: string }).code).toBe("backup_secrets_locked");
    expect((err as Error).message).toBe(a.exp.EXPORT_LOCKED_MESSAGE);
    expect((err as Error).message).toMatch(/master key is missing or wrong/);
    expect((err as Error).message).toMatch(/export without secrets/);
    expect(() => a.exp.assertSecretsExportable()).toThrow(a.exp.EXPORT_LOCKED_MESSAGE);
    // Nothing was exported or audited by the refusal.
    expect((a.sqlite().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'backup.exported'").get() as { n: number }).n).toBe(before);
    const plain = await a.exp.exportBackup(ownerA, { includeSecrets: false });
    expect(plain.manifest.includesSecrets).toBe(false);
    expect(plain.manifest.secrets).toBeUndefined();
    for (const s of SECRETS) expect(plain.bytes.includes(Buffer.from(s))).toBe(false);
  });
});
