// Backup export (architecture 12; settings spec 3.10; A2 and A4.4). Owner only, after a step-up (the
// route checks both). `atrium-backup-YYYY-MM-DD.atrium` is a zip of manifest.json, data/<table>.json
// for the allow-listed tables that exist here, uploads/, and, only when the owner chose to include
// secrets, secrets.enc: every secret and credential value, sealed under the backup password. Without
// secrets the file holds no secret value at all; with them, the values exist only inside secrets.enc.
import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Principal } from "@/core/contracts";
import { sqlite } from "@/core/db";
import { AtriumError, Forbidden } from "@/core/errors";
import { write as audit } from "@/features/audit/write";
import { writeZip, type ZipEntry } from "@/features/settings/zip";
import { listUploadFiles, uploadsDir } from "@/features/uploads/store";
import { assertSecretsExportable, encryptSecrets, KDF, MIN_BACKUP_PASSWORD, readAllSecrets } from "./secrets";

export { assertSecretsExportable, EXPORT_LOCKED_MESSAGE } from "./secrets";
import { AUDIT_TABLES, DATA_TABLES, existingTables, notBuiltIn, schemaVersion } from "./tables";

export const BACKUP_FORMAT = "atrium-backup";
export const BACKUP_VERSION = 1;

export type ExportOptions = { includeSecrets: boolean; password?: string; passwordAgain?: string; includeAudit?: boolean };

export type Manifest = {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: string;
  atriumVersion: string;
  schemaVersion: string;
  includesSecrets: boolean;
  includesAudit: boolean;
  tables: { name: string; rows: number }[];
  uploads: number;
  secrets?: { kdf: "scrypt"; N: number; r: number; p: number; salt: string; iv: string; tag: string; count: number };
};

function atriumVersion(): string {
  try {
    return (JSON.parse(readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")) as { version?: string }).version ?? "0";
  } catch {
    return "0";
  }
}

/** Table rows as JSON-safe values (BLOBs as { $b64 }), without the built-in integration's rows. */
function dumpTable(name: string): Record<string, unknown>[] {
  const { where, args } = notBuiltIn(name);
  const rows = sqlite().prepare(`SELECT * FROM "${name}" ${where}`).all(...args) as Record<string, unknown>[];
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Buffer.isBuffer(v) ? { $b64: v.toString("base64") } : v])));
}

export function backupFileName(d = new Date()): string {
  return `atrium-backup-${d.toISOString().slice(0, 10)}.atrium`;
}

export async function exportBackup(p: Principal, opts: ExportOptions): Promise<{ fileName: string; bytes: Buffer; manifest: Manifest }> {
  if (p.kind !== "user" || p.role !== "owner") throw new Forbidden("Only the owner can export backups.");
  if (opts.includeSecrets) {
    // A locked vault cannot open the secrets: refuse before any table is read, naming the cause.
    assertSecretsExportable();
    if (!opts.password || opts.password.length < MIN_BACKUP_PASSWORD) throw new AtriumError(`The backup password must be at least ${MIN_BACKUP_PASSWORD} characters.`, 400, "weak_password");
    if (opts.password !== opts.passwordAgain) throw new AtriumError("The two passwords do not match.", 400, "password_mismatch");
  }
  const includeAudit = opts.includeAudit !== false;
  const present = new Set(existingTables());
  const names = [...DATA_TABLES, ...(includeAudit ? AUDIT_TABLES : [])].filter((t) => present.has(t));
  const entries: ZipEntry[] = [];
  const tables: Manifest["tables"] = [];
  // One read transaction, so every table comes from the same moment.
  const dump = sqlite().transaction(() => names.map((n) => [n, dumpTable(n)] as const));
  for (const [name, rows] of dump()) {
    entries.push({ name: `data/${name}.json`, data: Buffer.from(JSON.stringify(rows), "utf8") });
    tables.push({ name, rows: rows.length });
  }
  const files = listUploadFiles();
  for (const f of files) entries.push({ name: `uploads/${f}`, data: readFileSync(path.join(uploadsDir(), f)) });
  const manifest: Manifest = {
    format: BACKUP_FORMAT, version: BACKUP_VERSION, createdAt: new Date().toISOString(), atriumVersion: atriumVersion(), schemaVersion: schemaVersion(),
    includesSecrets: opts.includeSecrets, includesAudit: includeAudit, tables, uploads: files.length,
  };
  if (opts.includeSecrets) {
    const values = readAllSecrets();
    const sealed = await encryptSecrets(values, opts.password!);
    entries.push({ name: "secrets.enc", data: sealed.ciphertext });
    manifest.secrets = { kdf: "scrypt", N: KDF.N, r: KDF.r, p: KDF.p, salt: sealed.salt, iv: sealed.iv, tag: sealed.tag, count: values.length };
  }
  entries.unshift({ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8") });
  const bytes = writeZip(entries);
  audit({ actor: p, event: "backup.exported", target: { type: "backup", id: backupFileName(), label: backupFileName() }, result: "ok", detail: { withSealedValues: opts.includeSecrets, includesAudit: includeAudit, tables: tables.length, uploads: files.length } });
  return { fileName: backupFileName(), bytes, manifest };
}
