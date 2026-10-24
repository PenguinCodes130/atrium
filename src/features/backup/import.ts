// Backup import (architecture 12; settings spec 3.10; A4.4). Owner only, on a fresh instance or with the
// explicit "Replace everything on this Atrium" confirmation. The whole file is checked first (format,
// schema version, damage, password) and nothing changes until it passes. Everything is then written in
// one SQLite transaction; any failure leaves the instance exactly as it was.
//
// - The source master key is never in a backup and never needed: each secret and credential value is
//   sealed again under THIS instance's master key (which is kept; a new key is never generated).
// - The file's owner maps onto this instance's existing owner, whose login, TOTP and sessions are
//   untouched (A4.4). Every other imported user must reset their password (no password hashes travel).
// - "Import without secrets" writes no secret: every field that had a value shows it needs one again.
// - The audit log stays append-only: imported entries are added, existing ones are never deleted.
import "server-only";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Principal } from "@/core/contracts";
import { sqlite } from "@/core/db";
import { AtriumError, Forbidden } from "@/core/errors";
import { write as audit } from "@/features/audit/write";
import { vaultStatus, VaultLocked } from "@/features/vault";
import { readZip, ZipError } from "@/features/settings/zip";
import { checkFile, FILE_RE, MAX_UPLOAD_BYTES, uploadsDir, type Checked } from "@/features/uploads/store";
import { BACKUP_FORMAT, BACKUP_VERSION, type Manifest } from "./export";
import { countedList } from "./words";
import { decryptSecrets, resealAll, type SecretValue } from "./secrets";
import { AUDIT_TABLES, DATA_TABLES, columnsOf, compareSchema, existingTables, isBuiltInRow, notBuiltIn } from "./tables";

export const MAX_BACKUP_BYTES = 1024 * 1024 * 1024;
export const NEWER_MESSAGE = "This backup is from a newer Atrium. Update this Atrium first.";

export class BackupRefused extends AtriumError {
  constructor(message: string, code = "backup_refused", status = 400) {
    super(message, status, code);
  }
}

export class ReplaceNeeded extends AtriumError {
  constructor(readonly lose: Record<string, number>) {
    super(`This Atrium already has data. Importing replaces everything on it: ${countedList(lose)}.`, 409, "replace_required");
  }
}

export type ImportOptions = {
  password?: string;
  withoutSecrets?: boolean;
  /** The explicit "Replace everything on this Atrium" confirmation. */
  replace?: boolean;
  /** Tests only: throw after writing this table, to prove the import is all or nothing. */
  failAfterTable?: string;
};

/** An uploaded file the backup held that failed the upload checks and was not restored. */
export type RefusedUpload = { file: string; reason: string };

export type ImportResult = { tables: { name: string; rows: number }[]; secrets: number; uploads: number; uploadsRefused: RefusedUpload[]; withoutSecrets: boolean; usersToReset: number };

type Parsed = { manifest: Manifest; data: Map<string, Record<string, unknown>[]>; uploads: Map<string, Buffer>; secretsEnc?: Buffer };

/** Check the whole file before anything is written. */
export function parseBackup(bytes: Buffer): Parsed {
  let files: Map<string, Buffer>;
  try {
    files = readZip(bytes, { maxEntries: 50000, maxTotalBytes: MAX_BACKUP_BYTES });
  } catch (e) {
    throw new BackupRefused(`This backup file is damaged (${e instanceof ZipError ? e.message : "unreadable"}). Nothing was changed.`, "damaged");
  }
  const mf = files.get("manifest.json");
  if (!mf) throw new BackupRefused("This is not an Atrium backup: it has no manifest.json. Nothing was changed.", "damaged");
  let manifest: Manifest;
  try {
    manifest = JSON.parse(mf.toString("utf8")) as Manifest;
  } catch {
    throw new BackupRefused("This backup file is damaged: manifest.json is not valid JSON. Nothing was changed.", "damaged");
  }
  if (manifest?.format !== BACKUP_FORMAT || typeof manifest.version !== "number" || !Array.isArray(manifest.tables) || typeof manifest.schemaVersion !== "string") {
    throw new BackupRefused("This is not an Atrium backup. Nothing was changed.", "damaged");
  }
  if (manifest.version > BACKUP_VERSION || compareSchema(manifest.schemaVersion) === "newer") throw new BackupRefused(NEWER_MESSAGE, "newer_schema");
  const allowed = new Set<string>([...DATA_TABLES, ...AUDIT_TABLES]);
  const data = new Map<string, Record<string, unknown>[]>();
  for (const t of manifest.tables) {
    if (!t || typeof t.name !== "string" || !allowed.has(t.name)) throw new BackupRefused(`This backup holds a table Atrium does not restore (${String(t?.name)}). Nothing was changed.`, "damaged");
    const f = files.get(`data/${t.name}.json`);
    if (!f) throw new BackupRefused(`This backup file is damaged: data/${t.name}.json is missing. Nothing was changed.`, "damaged");
    let rows: unknown;
    try {
      rows = JSON.parse(f.toString("utf8"));
    } catch {
      throw new BackupRefused(`This backup file is damaged: data/${t.name}.json is not valid JSON. Nothing was changed.`, "damaged");
    }
    if (!Array.isArray(rows) || rows.length !== t.rows || rows.some((r) => !r || typeof r !== "object" || Array.isArray(r))) {
      throw new BackupRefused(`This backup file is damaged: data/${t.name}.json does not match the manifest. Nothing was changed.`, "damaged");
    }
    data.set(t.name, rows as Record<string, unknown>[]);
  }
  const uploads = new Map<string, Buffer>();
  for (const [name, buf] of files) {
    if (!name.startsWith("uploads/")) continue;
    const file = name.slice("uploads/".length);
    if (!FILE_RE.test(file)) throw new BackupRefused(`This backup holds a file Atrium does not restore (${name}). Nothing was changed.`, "damaged");
    uploads.set(file, buf);
  }
  const secretsEnc = files.get("secrets.enc");
  if (manifest.includesSecrets && (!secretsEnc || !manifest.secrets)) throw new BackupRefused("This backup file is damaged: its secrets part is missing. Nothing was changed.", "damaged");
  return { manifest, data, uploads, ...(secretsEnc ? { secretsEnc } : {}) };
}

/** What an import onto this instance would replace (empty when the instance is fresh). */
export function existingData(ownerId: string): Record<string, number> {
  const present = new Set(existingTables());
  const count = (sql: string, ...args: unknown[]) => (sqlite().prepare(sql).get(...args) as { n: number }).n;
  const out: Record<string, number> = {};
  const add = (label: string, table: string, where = "", ...args: unknown[]) => {
    if (!present.has(table)) return;
    const n = count(`SELECT COUNT(*) AS n FROM "${table}" ${where}`, ...args);
    if (n) out[label] = n;
  };
  add("other users", "user", "WHERE id <> ?", ownerId);
  add("apps", "app");
  const sys = notBuiltIn("integration");
  add("integrations", "integration", sys.where, ...sys.args);
  add("saved credentials", "credential");
  add("saved themes", "theme");
  add("uploads", "upload");
  add("library components", "library_component");
  return out;
}

function mapOwner(v: unknown, from: string | null, to: string): unknown {
  if (!from || from === to) return v;
  if (v === from) return to;
  if (typeof v === "string" && v.includes(from)) return v.split(from).join(to);
  return v;
}

function decodeValue(v: unknown): unknown {
  if (v && typeof v === "object" && "$b64" in (v as Record<string, unknown>)) return Buffer.from(String((v as { $b64: string }).$b64), "base64");
  if (v !== null && typeof v === "object") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

/**
 * Restored uploads pass the same checks as a fresh upload (settings gauntlet w2-r1 item 2): each file's
 * type comes from its bytes (checkFile: sniffing, size limits, SVG sanitising), never from the backup's
 * `upload` rows, and the bytes must match the file's extension. Files that fail are not restored and are
 * reported; the `upload` rows take their mime, kind, size and hash from the checked bytes, and rows
 * whose file failed or is missing are dropped, so /uploads/ never serves a type the bytes are not.
 * A file name that already exists in this Atrium's uploads folder keeps its stored bytes, which are
 * checked the same way.
 */
export function checkRestoredUploads(parsed: Pick<Parsed, "uploads" | "data">, dir: string): { files: Map<string, Checked>; write: Map<string, Buffer>; refused: RefusedUpload[] } {
  const files = new Map<string, Checked>();
  const write = new Map<string, Buffer>();
  const refused: RefusedUpload[] = [];
  const check = (file: string, buf: Buffer): Checked | string => {
    try {
      const c = checkFile(buf, "any", { maxBytes: MAX_UPLOAD_BYTES });
      const ext = file.slice(file.lastIndexOf(".") + 1);
      if (c.ext !== ext) return `its bytes are ${c.mime}, not a .${ext} file`;
      return c;
    } catch (e) {
      return e instanceof Error ? e.message.replace(/\.$/, "") : "it failed the upload checks";
    }
  };
  for (const [file, buf] of parsed.uploads) {
    const full = path.join(dir, file);
    const onDisk = existsSync(full);
    const r = check(file, onDisk ? readFileSync(full) : buf);
    if (typeof r === "string") {
      refused.push({ file, reason: r });
      continue;
    }
    files.set(file, r);
    if (!onDisk) write.set(file, r.bytes);
  }
  // Rows that name a file the backup does not hold: only kept when this Atrium already has that file
  // and it passes the checks.
  for (const row of parsed.data.get("upload") ?? []) {
    const file = typeof row.file === "string" ? row.file : "";
    if (!FILE_RE.test(file) || files.has(file) || parsed.uploads.has(file)) continue;
    const full = path.join(dir, file);
    if (!existsSync(full)) continue;
    const r = check(file, readFileSync(full));
    if (typeof r === "string") refused.push({ file, reason: r });
    else files.set(file, r);
  }
  return { files, write, refused };
}

/** The `upload` rows to restore: typed from the checked bytes; rows for refused or missing files dropped. */
function checkedUploadRows(rows: Record<string, unknown>[], files: Map<string, Checked>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    const c = typeof row.file === "string" ? files.get(row.file) : undefined;
    if (!c) continue;
    out.push({ ...row, mime: c.mime, kind: c.kind, size: c.bytes.length, sha256: createHash("sha256").update(c.bytes).digest("hex") });
  }
  return out;
}

export async function importBackup(p: Principal, bytes: Buffer, opts: ImportOptions = {}): Promise<ImportResult> {
  if (p.kind !== "user" || p.role !== "owner") throw new Forbidden("Only the owner can import backups.");
  const parsed = parseBackup(bytes);
  const { manifest } = parsed;

  // Secrets: the right password, or an explicit "Import without secrets".
  let values: SecretValue[] = [];
  const withoutSecrets = !manifest.includesSecrets || !!opts.withoutSecrets;
  if (manifest.includesSecrets && !opts.withoutSecrets) {
    if (!opts.password) throw new BackupRefused("This backup holds secrets. Enter its password, or choose Import without secrets.", "password_needed");
    const s = manifest.secrets!;
    values = await decryptSecrets({ salt: s.salt, iv: s.iv, tag: s.tag, ciphertext: parsed.secretsEnc! }, opts.password);
    if (values.length && vaultStatus().state !== "ready") throw new VaultLocked();
  }

  const lose = existingData(p.userId);
  if (Object.keys(lose).length && !opts.replace) throw new ReplaceNeeded(lose);

  // The file's owner becomes this instance's owner (A4.4).
  const users = parsed.data.get("user") ?? [];
  const fileOwner = users.find((u) => u.role === "owner");
  const fromOwner = typeof fileOwner?.id === "string" ? fileOwner.id : null;
  const ownerEmail = (sqlite().prepare(`SELECT email FROM "user" WHERE id = ?`).get(p.userId) as { email?: string } | undefined)?.email ?? "";

  // Uploads go to disk first under fresh names only, as checked bytes; on failure the new files are
  // removed again. Files that fail the upload checks are never written.
  const written: string[] = [];
  const dir = uploadsDir();
  const restored = checkRestoredUploads(parsed, dir);
  if (parsed.data.has("upload")) parsed.data.set("upload", checkedUploadRows(parsed.data.get("upload")!, restored.files));
  const present = new Set(existingTables());
  const tablesOut: ImportResult["tables"] = [];
  let sealedCount = 0;
  try {
    for (const [file, buf] of restored.write) {
      const full = path.join(dir, file);
      writeFileSync(full, buf, { mode: 0o640 });
      written.push(full);
    }
    const db = sqlite();
    const run = db.transaction(() => {
      db.pragma("defer_foreign_keys = ON");
      // Replace everything: children first. The owner's own user row (and with it their sessions,
      // password and TOTP) and the audit log are never deleted.
      for (const t of [...DATA_TABLES].reverse()) {
        if (!present.has(t)) continue;
        if (t === "user") db.prepare(`DELETE FROM "user" WHERE id <> ?`).run(p.userId);
        else if (t === "allowlist") db.prepare(`DELETE FROM "allowlist" WHERE lower(pattern) <> lower(?)`).run(ownerEmail);
        else {
          const keep = notBuiltIn(t); // the built-in integration stays (A10.6)
          db.prepare(`DELETE FROM "${t}" ${keep.where}`).run(...keep.args);
        }
      }
      if (present.has("secret")) db.prepare(`DELETE FROM "secret"`).run();
      if (present.has("control_run") && parsed.data.has("control_run")) db.prepare(`DELETE FROM "control_run"`).run();

      for (const t of [...DATA_TABLES, ...AUDIT_TABLES]) {
        const rows = parsed.data.get(t);
        if (!rows || !present.has(t)) continue;
        const cols = columnsOf(t);
        const names = new Set(cols.map((c) => c.name));
        let n = 0;
        for (const raw of rows) {
          if (t === "user" && raw.id === fromOwner) continue; // mapped onto this owner
          if (isBuiltInRow(t, raw)) continue; // an older backup that carried it: keep this instance's own
          if (t === "allowlist" && (raw.role === "owner" || String(raw.pattern).toLowerCase() === ownerEmail.toLowerCase())) continue;
          const row: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(raw)) if (names.has(k)) row[k] = decodeValue(mapOwner(v, fromOwner, p.userId));
          if (t === "user") {
            if (row.role === "owner") row.role = "member";
            if ("two_factor_enabled" in row) row.two_factor_enabled = 0; // TOTP secrets never travel
          }
          const keys = Object.keys(row);
          if (!keys.length) continue;
          const verb = t === "audit_log" ? "INSERT OR IGNORE" : "INSERT";
          db.prepare(`${verb} INTO "${t}" (${keys.map((k) => `"${k}"`).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((k) => row[k]));
          n++;
        }
        tablesOut.push({ name: t, rows: n });
        if (opts.failAfterTable === t) throw new Error("forced failure (test)");
      }
      if (!withoutSecrets) sealedCount = resealAll(values.map((v) => ({ ...v, ownerId: String(mapOwner(v.ownerId, fromOwner, p.userId)) })));
      const fk = db.pragma("foreign_key_check") as unknown[];
      if (fk.length) throw new BackupRefused("This backup's records do not fit together (a reference points at nothing). Nothing was changed.", "damaged");
    });
    run();
  } catch (err) {
    for (const f of written) rmSync(f, { force: true });
    if (err instanceof AtriumError) throw err;
    throw new BackupRefused(`The import failed and nothing was changed (${err instanceof Error ? err.message.slice(0, 120) : "unknown error"}).`, "import_failed", 500);
  }
  const usersToReset = users.filter((u) => u.id !== fromOwner).length;
  audit({ actor: p, event: "backup.imported", target: { type: "backup", id: manifest.createdAt, label: `backup from ${manifest.createdAt.slice(0, 10)}` }, result: "ok", detail: { withSealedValues: manifest.includesSecrets, valuesSkipped: withoutSecrets && manifest.includesSecrets, replaced: Object.keys(lose).length > 0, tables: tablesOut.length, valuesResealed: sealedCount, usersToReset, uploadsRefused: restored.refused.length } });
  return { tables: tablesOut, secrets: sealedCount, uploads: restored.files.size, uploadsRefused: restored.refused, withoutSecrets, usersToReset };
}
