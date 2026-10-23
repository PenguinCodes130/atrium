// Backup secrets (architecture 11 and 12). The ONLY backup module that opens sealed values: on export it
// reads every sealed secret and credential value and encrypts the set under the backup password
// (AES-256-GCM, key from scrypt(password, salt, N=2^17, r=8, p=1)); on import it decrypts them and seals
// each again under this instance's own master key, bound to its owner and field (seal() in the vault).
// Plaintext exists only in memory here, never in a file, a log or a response.
//
// Interface gap (settings build r1): section 11 lists who may unseal and backups are not on the list,
// although section 12 requires the values in secrets.enc. The shared file request adds this one file to
// UNSEAL_ALLOWED in eslint.config.mjs; until then lint reports this import.
import "server-only";
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { db } from "@/core/db";
import { AtriumError } from "@/core/errors";
import { secrets as secretTable } from "@/db/schema/vault";
import { seal, vaultStatus, VaultLocked, type OwnerType } from "@/features/vault";
import { unseal } from "@/features/vault/unseal";

export const KDF = { N: 2 ** 17, r: 8, p: 1, keyLen: 32, maxmem: 256 * 1024 * 1024 } as const;
export const MIN_BACKUP_PASSWORD = 12;

export type SecretValue = { ownerType: OwnerType; ownerId: string; key: string; value: string };
export type SealedSet = { salt: string; iv: string; tag: string; ciphertext: Buffer };

/** Named cause for an export with secrets while the vault is locked (Fix List 2026-10-19). */
export const EXPORT_LOCKED_MESSAGE = "Secrets are locked because the master key is missing or wrong, so they can't be included in a backup. Restore the master key, or export without secrets.";

export class ExportSecretsLocked extends AtriumError {
  constructor() {
    super(EXPORT_LOCKED_MESSAGE, 409, "backup_secrets_locked");
  }
}

/** Refuse at once (409) when an export asks for secrets the vault cannot open. Opens nothing. */
export function assertSecretsExportable(): void {
  if (vaultStatus().state !== "ready") throw new ExportSecretsLocked();
}

export class WrongPassword extends AtriumError {
  constructor() {
    super("The backup password is not right. Nothing was changed.", 400, "wrong_password");
  }
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password.normalize("NFKC"), salt, KDF.keyLen, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: KDF.maxmem }, (e, k) => (e ? reject(e) : resolve(k))));
}

/** Every sealed value on this instance, opened. Throws VaultLocked when the key is missing or wrong. */
export function readAllSecrets(): SecretValue[] {
  if (vaultStatus().state !== "ready") throw new VaultLocked();
  const rows = db().select({ ownerType: secretTable.ownerType, ownerId: secretTable.ownerId, key: secretTable.key }).from(secretTable).all();
  const out: SecretValue[] = [];
  for (const r of rows) {
    const value = unseal(r);
    if (value !== null) out.push({ ...r, value });
  }
  return out;
}

export async function encryptSecrets(values: SecretValue[], password: string): Promise<SealedSet> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(password, salt);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from("atrium-backup-secrets-v1"));
  const ciphertext = Buffer.concat([c.update(JSON.stringify(values), "utf8"), c.final()]);
  return { salt: salt.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ciphertext };
}

export async function decryptSecrets(set: SealedSet, password: string): Promise<SecretValue[]> {
  const key = await deriveKey(password, Buffer.from(set.salt, "base64"));
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(set.iv, "base64"));
    d.setAAD(Buffer.from("atrium-backup-secrets-v1"));
    d.setAuthTag(Buffer.from(set.tag, "base64"));
    const json = Buffer.concat([d.update(set.ciphertext), d.final()]).toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) throw new Error("bad");
    return parsed.filter(
      (v): v is SecretValue =>
        !!v && typeof v === "object" && ["integration", "channel", "setup-agent", "credential"].includes((v as SecretValue).ownerType) &&
        typeof (v as SecretValue).ownerId === "string" && typeof (v as SecretValue).key === "string" && typeof (v as SecretValue).value === "string",
    );
  } catch {
    throw new WrongPassword();
  }
}

/** Seal each value again under this instance's master key (inside the caller's transaction). */
export function resealAll(values: SecretValue[]): number {
  let n = 0;
  for (const v of values) {
    seal({ ownerType: v.ownerType, ownerId: v.ownerId, key: v.key }, v.value);
    n++;
  }
  return n;
}
