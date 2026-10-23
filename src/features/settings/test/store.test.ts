// settings round 1: the settings store (A4.4; AC 7, 8, 9).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER, OWNER, freshDataDir, useInstance } from "./harness";

let s: typeof import("@/features/settings/store");
let audit: () => { event: string; detail: unknown }[];
beforeEach(async () => {
  vi.resetModules();
  useInstance(freshDataDir());
  s = await import("@/features/settings/store");
  const { db } = await import("@/core/db");
  const { auditLog } = await import("@/db/schema/audit");
  audit = () => db().select().from(auditLog).all().map((r) => ({ event: r.event, detail: r.detail }));
});

describe("instance settings", () => {
  it("defaults, owner-only saves, one settings.updated with old and new values", async () => {
    expect(s.getInstanceSettings()).toEqual({ instanceName: null, auditRetentionDays: 365, versionRetention: "all", brandAccent: null, brandLogo: null, brandFavicon: null, signInWallpaper: null });
    expect(() => s.updateInstanceSettings(MEMBER, { instanceName: "x" })).toThrow(/Only the owner/);
    const r = s.updateInstanceSettings(OWNER, { instanceName: "atrium.home" });
    expect(r.changed).toEqual(["instanceName"]);
    const rows = audit().filter((a) => a.event === "settings.updated");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toEqual({ keys: ["instanceName"], changes: { instanceName: { old: null, new: "atrium.home" } } });
    s.updateInstanceSettings(OWNER, { instanceName: "atrium.home" });
    expect(audit().filter((a) => a.event === "settings.updated")).toHaveLength(1); // no change, no entry
  });
  it("refuses a version retention of 19 naming 20 and an audit retention below 1 day (AC 8)", () => {
    expect(() => s.updateInstanceSettings(OWNER, { versionRetention: 19 })).toThrow("Keep at least 20 versions.");
    expect(() => s.updateInstanceSettings(OWNER, { auditRetentionDays: 0 })).toThrow("Audit retention must be at least 1 day.");
    expect(s.updateInstanceSettings(OWNER, { versionRetention: 20 }).settings.versionRetention).toBe(20);
    expect(s.versionRetention()).toBe(20);
    expect(() => s.updateInstanceSettings(OWNER, { instanceName: "<b>" })).toThrow(/cannot contain/);
    expect(() => s.updateInstanceSettings(OWNER, { unknownKey: 1 })).toThrow();
  });
  it("feeds the shell readout once registered", async () => {
    s.updateInstanceSettings(OWNER, { instanceName: "lab.local" });
    await import("@/features/settings/register");
    const { instanceName } = await import("@/features/shell/server");
    expect(instanceName()).toBe("lab.local");
  });
});

describe("user preferences (AC 9)", () => {
  it("are per user and change nothing for anyone else", () => {
    s.updateUserPrefs(OWNER, { shellMode: "dark", reduceMotion: true });
    expect(s.getUserPrefs(OWNER.kind === "user" ? OWNER.userId : "")).toEqual({ shellMode: "dark", reduceMotion: true, reduceTransparency: false });
    expect(s.getUserPrefs("u-member")).toEqual({ shellMode: "system", reduceMotion: false, reduceTransparency: false });
    expect(() => s.updateUserPrefs(OWNER, { shellMode: "neon" })).toThrow();
  });
});
