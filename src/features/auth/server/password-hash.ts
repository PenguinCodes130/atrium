import "server-only";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";

// argon2id with OWASP-recommended parameters (19 MiB, 2 passes, 1 lane). Its own module so the
// owner-recovery CLI can hash a password without loading Better Auth.
const ARGON = { algorithm: 2 /* Argon2id */, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export async function hashPassword(password: string): Promise<string> {
  return argonHash(password, ARGON);
}

export async function verifyPassword(hashed: string, password: string): Promise<boolean> {
  if (!hashed.startsWith("$argon2id$")) return false;
  try {
    return await argonVerify(hashed, password);
  } catch {
    return false;
  }
}
