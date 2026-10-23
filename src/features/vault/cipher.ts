import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM with a random 12-byte IV and `ownerType:ownerId:key` as additional data
// (architecture section 11), so a ciphertext cannot be moved to another owner or field.
// Internal to the vault: callers outside src/features/vault use seal() or the unseal module.

export type OwnerType = "integration" | "channel" | "setup-agent" | "credential"; // credential: amendment 2
export type SecretRef = { ownerType: OwnerType; ownerId: string; key: string };
export type Sealed = { ciphertext: string; iv: string; tag: string };

export function aad(ref: SecretRef): Buffer {
  return Buffer.from(`${ref.ownerType}:${ref.ownerId}:${ref.key}`, "utf8");
}

export function encrypt(masterKey: Buffer, ref: SecretRef, plaintext: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  cipher.setAAD(aad(ref));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

// Throws when the key is wrong or the ciphertext was moved to another owner, owner id or key.
export function decrypt(masterKey: Buffer, ref: SecretRef, sealed: Sealed): string {
  const decipher = createDecipheriv("aes-256-gcm", masterKey, Buffer.from(sealed.iv, "base64"));
  decipher.setAAD(aad(ref));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "base64")), decipher.final()]).toString("utf8");
}
