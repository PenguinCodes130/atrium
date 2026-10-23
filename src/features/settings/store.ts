// The settings store (Amendment 4 A4.4; settings spec 3.1). Typed key and value rows with a scope of
// `instance` (owner only: instance name, audit retention, version retention) or `user:<id>` (shell
// mode, reduce motion, reduce transparency). Every read is validated, so a bad stored value falls back
// to its default instead of reaching a screen.
import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Principal } from "@/core/contracts";
import { db } from "@/core/db";
import { AtriumError, Forbidden } from "@/core/errors";
import { write as audit } from "@/features/audit/write";
import { settingValues } from "@/db/schema/settings";
import { readUpload } from "@/features/uploads/store";
import { BRAND_ACCENT_IDS, type BrandAccentId } from "./branding-palette";

/** An uploaded image path (settings gauntlet w2-r1 item 8: branding images go through the upload checks). */
const brandImage = (what: string) =>
  z
    .string()
    .regex(/^\/uploads\/[a-z0-9]{20}\.(png|jpg|gif|webp|avif|svg)$/, `${what}: upload an image to this Atrium first.`)
    .nullable();

export const MIN_VERSION_RETENTION = 20;
export const DEFAULT_AUDIT_RETENTION_DAYS = 365;

export const instanceSchema = z.object({
  instanceName: z
    .string()
    .trim()
    .max(40, "The instance name can be at most 40 characters.")
    .regex(/^[^<>\u0000-\u001f]*$/, "The instance name cannot contain < or >.")
    .nullable(),
  auditRetentionDays: z
    .number({ message: "Audit retention must be a number of days." })
    .int("Audit retention must be a whole number of days.")
    .min(1, "Audit retention must be at least 1 day.")
    .max(36500, "Audit retention can be at most 36500 days."),
  versionRetention: z.union([
    z.literal("all"),
    z
      .number({ message: "Keep the last N versions: N must be a number." })
      .int("Keep the last N versions: N must be a whole number.")
      .min(MIN_VERSION_RETENTION, `Keep at least ${MIN_VERSION_RETENTION} versions.`)
      .max(100000),
  ]),
  // Instance branding (item 8): an accent from the shell's palette, and uploaded images.
  brandAccent: z.enum(BRAND_ACCENT_IDS as [BrandAccentId, ...BrandAccentId[]], { message: "Pick one of the shell's accents." }).nullable(),
  brandLogo: brandImage("Logo"),
  brandFavicon: brandImage("Favicon"),
  signInWallpaper: brandImage("Sign-in wallpaper"),
});
export type InstanceSettings = z.infer<typeof instanceSchema>;
export const INSTANCE_DEFAULTS: InstanceSettings = { instanceName: null, auditRetentionDays: DEFAULT_AUDIT_RETENTION_DAYS, versionRetention: "all", brandAccent: null, brandLogo: null, brandFavicon: null, signInWallpaper: null };
const BRAND_IMAGES = { brandLogo: "Logo", brandFavicon: "Favicon", signInWallpaper: "Sign-in wallpaper" } as const;

export const userPrefsSchema = z.object({
  shellMode: z.enum(["system", "light", "dark"]),
  reduceMotion: z.boolean(),
  reduceTransparency: z.boolean(),
});
export type UserPrefs = z.infer<typeof userPrefsSchema>;
export const USER_DEFAULTS: UserPrefs = { shellMode: "system", reduceMotion: false, reduceTransparency: false };

const INSTANCE = "instance";
const userScope = (id: string) => `user:${id}`;

function readScope(scope: string): Record<string, unknown> {
  const rows = db().select().from(settingValues).where(eq(settingValues.scope, scope)).all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function pick<T extends Record<string, unknown>>(schema: z.ZodObject, stored: Record<string, unknown>, defaults: T): T {
  const out: Record<string, unknown> = { ...defaults };
  for (const k of Object.keys(defaults)) {
    if (!(k in stored)) continue;
    const r = (schema.shape as Record<string, z.ZodType>)[k]!.safeParse(stored[k]);
    if (r.success) out[k] = r.data;
  }
  return out as T;
}

export function getInstanceSettings(): InstanceSettings {
  return pick(instanceSchema, readScope(INSTANCE), INSTANCE_DEFAULTS);
}

export function getUserPrefs(userId: string): UserPrefs {
  return pick(userPrefsSchema, readScope(userScope(userId)), USER_DEFAULTS);
}

function upsert(scope: string, key: string, value: unknown, by: string | null) {
  const now = new Date();
  db()
    .insert(settingValues)
    .values({ scope, key, value, updatedAt: now, updatedBy: by })
    .onConflictDoUpdate({ target: [settingValues.scope, settingValues.key], set: { value, updatedAt: now, updatedBy: by } })
    .run();
}

export class SettingsInvalid extends AtriumError {
  constructor(readonly issues: { path: string; message: string }[]) {
    super(issues[0]?.message ?? "Those settings are not valid.", 400, "invalid_settings");
  }
}

/** Owner only. Saves the changed keys and writes one `settings.updated` naming each with old and new values. */
export function updateInstanceSettings(p: Principal, patch: unknown): { settings: InstanceSettings; changed: string[] } {
  if (p.kind !== "user" || p.role !== "owner") throw new Forbidden("Only the owner can change instance settings.");
  const r = instanceSchema.partial().strict().safeParse(patch);
  if (!r.success) throw new SettingsInvalid(r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  // A branding image must be an image this Atrium holds (its type came from its bytes on upload).
  const missing: { path: string; message: string }[] = [];
  for (const [k, label] of Object.entries(BRAND_IMAGES) as [keyof typeof BRAND_IMAGES, string][]) {
    const v = r.data[k];
    if (typeof v !== "string") continue;
    const f = readUpload(v.slice("/uploads/".length));
    if (!f || f.kind !== "image") missing.push({ path: k, message: `${label}: that upload is not an image on this Atrium.` });
  }
  if (missing.length) throw new SettingsInvalid(missing);
  const before = getInstanceSettings();
  const changes: Record<string, { old: unknown; new: unknown }> = {};
  for (const [k, v] of Object.entries(r.data) as [keyof InstanceSettings, unknown][]) {
    const nv = k === "instanceName" && typeof v === "string" && !v ? null : v;
    if (nv === undefined || JSON.stringify(before[k]) === JSON.stringify(nv)) continue;
    changes[k] = { old: before[k], new: nv };
  }
  const changed = Object.keys(changes);
  if (changed.length) {
    db().transaction(() => {
      // A null clears the key (its default comes back); the column holds no nulls.
      for (const k of changed) {
        if (changes[k]!.new === null) db().delete(settingValues).where(and(eq(settingValues.scope, INSTANCE), eq(settingValues.key, k))).run();
        else upsert(INSTANCE, k, changes[k]!.new, p.userId);
      }
    });
    audit({ actor: p, event: "settings.updated", target: { type: "settings", id: INSTANCE, label: "Instance" }, result: "ok", detail: { keys: changed, changes } });
  }
  return { settings: getInstanceSettings(), changed };
}

/** Any signed-in user, for themselves only. Changes only their own shell, never an app's theme. */
export function updateUserPrefs(p: Principal, patch: unknown): UserPrefs {
  if (p.kind !== "user") throw new Forbidden();
  const r = userPrefsSchema.partial().strict().safeParse(patch);
  if (!r.success) throw new SettingsInvalid(r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  db().transaction(() => {
    for (const [k, v] of Object.entries(r.data)) if (v !== undefined) upsert(userScope(p.userId), k, v, p.userId);
  });
  return getUserPrefs(p.userId);
}

/** For app-builder's retention (architecture 4.9): "all", or keep the last N (N >= 20). */
export function versionRetention(): "all" | number {
  return getInstanceSettings().versionRetention;
}

/** For the audit log's retention (architecture 7). */
export function auditRetentionDays(): number {
  return getInstanceSettings().auditRetentionDays;
}

/** Raw rows for backups (every scope). */
export function settingRowsForUser(userId: string) {
  return db().select().from(settingValues).where(and(eq(settingValues.scope, userScope(userId)))).all();
}
