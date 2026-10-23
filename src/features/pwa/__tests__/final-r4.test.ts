// Gauntlet w2-r3 item 1 (security), final pass: the page that tells a guest their link ended forgets
// that app's caches and every saved last value, without a worker.
import { afterEach, describe, expect, it } from "vitest";
import { appSlugOf, forgetAppOffline, LAST_OWNER_KEY } from "../offline";

describe("forgetAppOffline", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { caches?: unknown }).caches;
  });
  it("deletes only that app's caches and all last values", async () => {
    const m = new Map<string, string>([[LAST_OWNER_KEY, "guest:l1"], ["atrium:last:app1:p1", "{}"], ["atrium:theme", "keep"]]);
    (globalThis as { window?: unknown }).window = { localStorage: { get length() { return m.size; }, key: (i: number) => [...m.keys()][i] ?? null, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } };
    // Legacy hyphen names cannot be traced to one app, so every forget deletes them (final re-check).
    const names = new Set(["atrium-app-door-3", "atrium-app-door-s2-1", "atrium-app:door:1", "atrium-app:door:2", "atrium-app:door-other:1", "atrium-app:door-s2:1", "atrium-app:garden:1"]);
    (globalThis as { caches?: unknown }).caches = { keys: async () => [...names], delete: async (n: string) => names.delete(n) };
    await forgetAppOffline("door");
    expect([...names].sort()).toEqual(["atrium-app:door-other:1", "atrium-app:door-s2:1", "atrium-app:garden:1"]);
    expect([...m.keys()]).toEqual(["atrium:theme"]);
  });
  it("final re-check: an app whose slug ends like a version keeps its hands off the shorter-slug app", async () => {
    const names = new Set(["atrium-app:sec-fid:1", "atrium-app:sec-fid-s2:1"]);
    (globalThis as { caches?: unknown }).caches = { keys: async () => [...names], delete: async (n: string) => names.delete(n) };
    await forgetAppOffline("sec-fid-s2");
    expect([...names]).toEqual(["atrium-app:sec-fid:1"]);
  });
  it("never throws where storage or Cache Storage is missing, and ignores a bad slug", async () => {
    await expect(forgetAppOffline("door")).resolves.toBeUndefined();
    await expect(forgetAppOffline("../x")).resolves.toBeUndefined();
  });
  it("appSlugOf reads the app from a viewer address only", () => {
    expect(appSlugOf("/a/door")).toBe("door");
    expect(appSlugOf("/a/door/kitchen")).toBe("door");
    expect(appSlugOf("/build/door")).toBeNull();
    expect(appSlugOf("/a/")).toBeNull();
  });
});
