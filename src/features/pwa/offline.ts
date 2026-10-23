// What a browser keeps of an app for offline use, and how it is forgotten (gauntlet w2-r2 item 1,
// security). Client-safe; every browser API is guarded so it also runs where one is missing.
//
// Two stores: the app workers' Cache Storage (offline snapshots, see `appWorker`) and the last values a
// published page received (`atrium:last:<app>:<page>` in localStorage). The last values belong to the
// person who received them: `atrium:last-owner` names that person, and a page opened online by someone
// else wipes them before reading or writing. Sign-out, a 401 seen by the page and a worker that lost
// access all call `forgetOfflineAppData`.

export const LAST_PREFIX = "atrium:last:";
export const LAST_OWNER_KEY = "atrium:last-owner";
// App cache names are `atrium-app:<slug>:<version>`. Slugs never contain ":", so a name belongs to exactly
// one app (the earlier `atrium-app-<slug>-...` names could not tell `door` at `s2-1` from `door-s2` at `1`,
// gauntlet w2 final re-check). Those legacy names cannot be traced to one app; every app worker and every
// forget deletes them, which only drops pre-fix copies.
export const APP_CACHE_PREFIX = "atrium-app:";
export const LEGACY_APP_CACHE_PREFIX = "atrium-app-";

/** The cache name prefix of one app (`atrium-app:<slug>:`). */
export function appCachePrefix(slug: string): string {
  return `${APP_CACHE_PREFIX}${slug}:`;
}

/** True for any app cache, current or legacy. */
export function isAppCache(name: string): boolean {
  return name.startsWith(APP_CACHE_PREFIX) || name.startsWith(LEGACY_APP_CACHE_PREFIX);
}

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Removes every saved last value and the owner tag. */
export function forgetLastValues(): number {
  const s = storage();
  if (!s) return 0;
  let n = 0;
  try {
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && (k.startsWith(LAST_PREFIX) || k === LAST_OWNER_KEY)) keys.push(k);
    }
    for (const k of keys) {
      s.removeItem(k);
      n++;
    }
  } catch {
    /* storage blocked */
  }
  return n;
}

/**
 * Makes `owner` the person the saved last values belong to. When someone else's values are stored,
 * they are removed first. Returns true when values were removed.
 */
export function claimLastValues(owner: string): boolean {
  const s = storage();
  if (!s || !owner) return false;
  try {
    const was = s.getItem(LAST_OWNER_KEY);
    if (was === owner) return false;
    const removed = forgetLastValues() > 0;
    s.setItem(LAST_OWNER_KEY, owner);
    return removed && was !== null;
  } catch {
    return false;
  }
}

/**
 * Forgets everything this browser kept of every app for offline use: last values, app caches, and the
 * app workers themselves. Safe to call more than once; never throws.
 */
export async function forgetOfflineAppData(): Promise<void> {
  forgetLastValues();
  try {
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(keys.filter(isAppCache).map((k) => caches.delete(k)));
    }
  } catch {
    /* Cache Storage unavailable */
  }
  try {
    const regs = typeof navigator !== "undefined" && navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
    await Promise.all(regs.filter((r) => new URL(r.scope).pathname.startsWith("/a/")).map((r) => r.unregister()));
  } catch {
    /* no service workers */
  }
}

/**
 * Forgets what this browser kept of one app (gauntlet w2-r3 item 1): its caches and every saved last
 * value (they belong to one person, the one whose access just ended). Used by the page that tells a
 * guest their link has ended, so the forgetting does not depend on the worker being there. Never throws.
 */
export async function forgetAppOffline(slug: string): Promise<void> {
  forgetLastValues();
  try {
    if (typeof caches !== "undefined" && /^[a-z0-9-]{1,40}$/.test(slug)) {
      // This app's caches (`atrium-app:<slug>:<version>`), never another app's, plus any legacy name.
      const own = appCachePrefix(slug);
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith(own) || k.startsWith(LEGACY_APP_CACHE_PREFIX)).map((k) => caches.delete(k)));
    }
  } catch {
    /* Cache Storage unavailable */
  }
}

/** The app slug of a viewer address (`/a/<slug>` or `/a/<slug>/<page>`), or null. */
export function appSlugOf(pathname: string): string | null {
  const m = /^\/a\/([a-z0-9-]{1,40})(?:\/|$)/.exec(pathname);
  return m ? m[1]! : null;
}
