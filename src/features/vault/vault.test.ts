import { describe, expect, it, beforeEach, vi } from "vitest";
import { existsSync, statSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { freshDataDir, setEnv } from "../auth/test/harness";

// Vault: seal and unseal, AAD binding, write-only status, master key file, and the locked state
// (architecture section 11; auth spec criteria 36 to 40).

// The first data folder runs drizzle-kit migrate and push (auth harness): allow for it under load.
vi.setConfig({ testTimeout: 30_000 });

type VaultModules = {
  vault: typeof import("./index");
  unseal: typeof import("./unseal");
  key: typeof import("./key");
  db: typeof import("@/core/db");
  schema: typeof import("@/db/schema/vault");
};

async function load(dir: string, extra: Record<string, string | undefined> = {}): Promise<VaultModules> {
  setEnv({ ATRIUM_DATA_DIR: dir, ...extra });
  vi.resetModules();
  return {
    vault: await import("./index"),
    unseal: await import("./unseal"),
    key: await import("./key"),
    db: await import("@/core/db"),
    schema: await import("@/db/schema/vault"),
  };
}

let dir: string;
beforeEach(() => {
  dir = freshDataDir();
});

describe("seal and unseal", () => {
  it("round-trips a value and stores only ciphertext", async () => {
    const m = await load(dir);
    const ref = { ownerType: "integration" as const, ownerId: "int-1", key: "token" };
    const status = m.vault.seal(ref, "sk-test-secret-value-1234");
    expect(status.set).toBe(true);
    expect(m.unseal.unseal(ref)).toBe("sk-test-secret-value-1234");
    const row = m.db.sqlite().prepare("SELECT * FROM secret").get() as Record<string, string>;
    expect(JSON.stringify(row)).not.toContain("sk-test-secret-value-1234");
    expect(Buffer.from(row.iv!, "base64").length).toBe(12);
  });

  it("reads return only set and updatedAt; a blank save keeps the old value (criterion 36)", async () => {
    const m = await load(dir);
    const ref = { ownerType: "channel" as const, ownerId: "ntfy-1", key: "password" };
    m.vault.seal(ref, "first-value-abc");
    const before = m.vault.secretStatus("channel", "ntfy-1", ["password", "other"]);
    expect(before).toEqual([
      { key: "password", set: true, updatedAt: expect.any(String) },
      { key: "other", set: false },
    ]);
    expect(JSON.stringify(before)).not.toContain("first-value-abc");
    m.vault.seal(ref, "");
    m.vault.seal(ref, undefined);
    expect(m.unseal.unseal(ref)).toBe("first-value-abc");
    m.vault.seal(ref, "second-value-def");
    expect(m.unseal.unseal(ref)).toBe("second-value-def");
  });

  it("returns null for a field never set", async () => {
    const m = await load(dir);
    expect(m.unseal.unseal({ ownerType: "setup-agent", ownerId: "default", key: "anthropic" })).toBeNull();
  });
});

describe("AAD binding (criterion 37)", () => {
  it("a ciphertext copied to another owner type, owner id or key fails to open", async () => {
    const m = await load(dir);
    const ref = { ownerType: "integration" as const, ownerId: "int-1", key: "token" };
    m.vault.seal(ref, "bound-secret-xyz");
    const raw = m.db.sqlite();
    const row = raw.prepare("SELECT * FROM secret").get() as Record<string, string | number>;
    const copies = [
      { owner_type: "channel", owner_id: "int-1", key: "token" },
      { owner_type: "integration", owner_id: "int-2", key: "token" },
      { owner_type: "integration", owner_id: "int-1", key: "password" },
    ];
    copies.forEach((c, i) => {
      raw
        .prepare("INSERT INTO secret (id, owner_type, owner_id, key, ciphertext, iv, tag, key_version, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(`copy-${i}`, c.owner_type, c.owner_id, c.key, row.ciphertext, row.iv, row.tag, row.key_version, row.updated_at);
    });
    for (const c of copies) {
      expect(() => m.unseal.unseal({ ownerType: c.owner_type as "channel", ownerId: c.owner_id, key: c.key })).toThrow(/cannot be opened/);
    }
    expect(m.unseal.unseal(ref)).toBe("bound-secret-xyz");
  });
});

describe("master key", () => {
  it("first boot with no key creates master.key with mode 600 and no copy in the database (criterion 38)", async () => {
    const m = await load(dir);
    expect(existsSync(path.join(dir, "master.key"))).toBe(false);
    expect(m.vault.vaultStatus().state).toBe("ready");
    const file = path.join(dir, "master.key");
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const keyB64 = readFileSync(file, "utf8").trim();
    expect(Buffer.from(keyB64, "base64").length).toBe(32);
    m.vault.seal({ ownerType: "integration", ownerId: "i", key: "k" }, "value-1");
    // The database file never contains the key (base64 or raw bytes).
    m.db.sqlite().pragma("wal_checkpoint(TRUNCATE)");
    const dbBytes = readFileSync(path.join(dir, "atrium.db"));
    expect(dbBytes.includes(Buffer.from(keyB64))).toBe(false);
    expect(dbBytes.includes(Buffer.from(keyB64, "base64"))).toBe(false);
  });

  it("uses ATRIUM_MASTER_KEY when set and writes no key file", async () => {
    const key = randomBytes(32).toString("base64");
    const m = await load(dir, { ATRIUM_MASTER_KEY: key });
    m.vault.seal({ ownerType: "integration", ownerId: "i", key: "k" }, "env-key-value");
    expect(existsSync(path.join(dir, "master.key"))).toBe(false);
    expect(m.unseal.unseal({ ownerType: "integration", ownerId: "i", key: "k" })).toBe("env-key-value");
  });

  it("with sealed secrets and the key removed: locked, alert raised once, no new key file (criterion 40, vault part)", async () => {
    const first = await load(dir);
    first.vault.seal({ ownerType: "integration", ownerId: "i", key: "k" }, "locked-value");
    rmSync(path.join(dir, "master.key"));

    const m = await load(dir);
    const alerts: unknown[] = [];
    m.key.onVaultLocked((a) => {
      alerts.push(a);
    });
    const st = m.vault.vaultStatus();
    expect(st).toEqual({ state: "locked", reason: "missing", message: "Secrets locked: the master key is missing or wrong" });
    m.vault.vaultStatus();
    expect(alerts.length).toBe(1);
    expect(existsSync(path.join(dir, "master.key"))).toBe(false);
    expect(() => m.unseal.unseal({ ownerType: "integration", ownerId: "i", key: "k" })).toThrow("Secrets locked: the master key is missing or wrong");
    expect(() => m.vault.seal({ ownerType: "integration", ownerId: "i", key: "k2" }, "x")).toThrow(/Secrets locked/);
    // Status reads still work while locked.
    expect(m.vault.secretStatus("integration", "i")[0]?.set).toBe(true);
  });

  it("a wrong key locks the vault and is never replaced", async () => {
    const first = await load(dir);
    first.vault.seal({ ownerType: "integration", ownerId: "i", key: "k" }, "v");
    const wrong = randomBytes(32).toString("base64");
    writeFileSync(path.join(dir, "master.key"), wrong, { mode: 0o600 });
    const m = await load(dir);
    expect(m.vault.vaultStatus()).toMatchObject({ state: "locked", reason: "wrong" });
    expect(readFileSync(path.join(dir, "master.key"), "utf8")).toBe(wrong);
  });
});
