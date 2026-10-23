// RETIRED in Wave 2 (e2e regression r1): serve.sh no longer preloads this file. app-builder registers the
// real app access hook, and round3.spec.ts makes its guest apps through app-builder's API. Kept for
// reference only (auth round 3, Wave 1 stand-in resolver). It set the same globalThis slot that
// registerAppAccess() in src/core/hooks.ts fills, reading apps from <ATRIUM_DATA_DIR>/e2e-apps.json.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const file = path.resolve(process.env.ATRIUM_DATA_DIR ?? "./data", "e2e-apps.json");
const load = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []);
const byId = (id) => load().find((a) => a.id === id) ?? null;
const inSet = (set, userId) => set === "everyone" || (typeof set === "object" && set !== null && Array.isArray(set.userIds) && set.userIds.includes(userId));

globalThis.__atriumAppAccess = {
  appBySlug: async (slug) => load().find((a) => a.slug === slug) ?? null,
  appById: async (id) => byId(id),
  appsFor: async () => [],
  guestValues: async () => ({}),
  canOpenApp: async (p, id) => {
    const a = byId(id);
    if (!a) return false;
    if (p.kind === "guest") return p.appId === id && a.access.guests === true;
    if (p.kind !== "user") return false;
    return p.role === "owner" || inSet(a.access.view, p.userId) || inSet(a.access.edit, p.userId);
  },
  canEditApp: async (p, id) => {
    const a = byId(id);
    if (!a || p.kind !== "user") return false;
    return p.role === "owner" || (p.role === "member" && inSet(a.access.edit, p.userId));
  },
  publishedControl: async () => null,
};
