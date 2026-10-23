// Gauntlet w2-r2 item 1 (security): the per-app worker never stores the page a person received; it
// stores only marked offline snapshots, and forgets everything when access ends. The generated worker
// runs here in a small stand-in of the service worker globals.
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { appWorker, OFFLINE_SNAPSHOT_MARKER } from "../manifest";
import { claimLastValues, forgetLastValues, LAST_OWNER_KEY } from "../offline";

const ORIGIN = "http://127.0.0.1:3115";
const SNAP_HTML = `<!doctype html><div hidden="" ${OFFLINE_SNAPSHOT_MARKER}=""></div><p>snapshot</p>`;
const EDITOR_HTML = "<!doctype html><p>SECPROBE-door-code-4821 unlock-front-door</p>";

type Res = { ok: boolean; status: number; type: string; redirected: boolean; url: string; text(): Promise<string>; clone(): Res; body?: string };
function res(body: string, opts: Partial<Res> = {}): Res {
  const r: Res = { ok: (opts.status ?? 200) < 300 && (opts.status ?? 200) >= 200, status: 200, type: "basic", redirected: false, url: "", ...opts, body, text: async () => body, clone: () => r };
  return r;
}

function worker(routes: (url: string) => Res | Promise<Res>, slug = "door") {
  const stores = new Map<string, Map<string, unknown>>();
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const fetched: string[] = [];
  const posted: unknown[] = [];
  const pending: Promise<unknown>[] = [];
  const caches = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name)!;
      return { put: async (k: unknown, v: unknown) => void m.set(typeof k === "string" ? k : (k as { url: string }).url, v), match: async (k: string) => m.get(k) };
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (t: string, fn: (e: unknown) => void) => (listeners[t] ??= []).push(fn),
    skipWaiting: () => {},
    clients: { claim: async () => {}, matchAll: async () => [{ postMessage: (m: unknown) => posted.push(m) }] },
  };
  class FakeResponse {
    constructor(public body: string, public init: unknown = {}) {}
  }
  const fetchFn = async (u: string | { url: string }) => {
    const url = typeof u === "string" ? u : u.url;
    fetched.push(url);
    return routes(url);
  };
  runInNewContext(appWorker(slug, "3"), { self, caches, fetch: fetchFn, Response: FakeResponse, URL, Promise, Array, JSON });
  const fire = async (type: string, e: Record<string, unknown>) => {
    let responded: Promise<unknown> | undefined;
    // Real fetch events always carry request headers.
    const request = e.request as { headers?: Record<string, string> } | undefined;
    if (request) e = { ...e, request: { ...request, headers: new Headers(request.headers ?? {}) } };
    const ev = { ...e, waitUntil: (p: Promise<unknown>) => pending.push(p), respondWith: (p: Promise<unknown>) => { responded = p; } };
    for (const fn of listeners[type] ?? []) fn(ev);
    const out = responded ? await responded : undefined;
    for (let i = 0; i < 5; i++) await Promise.all(pending.splice(0));
    return out;
  };
  const navigate = (path: string) => fire("fetch", { request: { method: "GET", url: ORIGIN + path, mode: "navigate" } });
  return { stores, fetched, posted, fire, navigate, entries: () => [...stores.values()].flatMap((m) => [...m.entries()]) };
}

describe("app worker offline cache (security)", () => {
  it("Wave 2.6: leaves Range requests and videos to the network, never caching them", async () => {
    const w = worker(() => res("bytes"));
    const out = await w.fire("fetch", { request: { method: "GET", url: `${ORIGIN}/uploads/abcdefghij0123456789.mp4`, mode: "no-cors", headers: { range: "bytes=0-" } } });
    expect(out).toBeUndefined();
    await w.fire("message", { data: { type: "atrium-cache", urls: ["/uploads/abcdefghij0123456789.webm"] } });
    expect(w.fetched).toEqual([]);
    expect(w.entries()).toEqual([]);
  });

  it("never stores the page as received: it stores the marked snapshot of it, keyed by the page path", async () => {
    const w = worker((u) => (u.includes("offline=1") ? res(SNAP_HTML) : res(EDITOR_HTML)));
    const page = await w.navigate("/a/door/");
    expect((page as Res).body).toBe(EDITOR_HTML); // the person still gets their page online
    expect(w.fetched).toContain(`${ORIGIN}/a/door?offline=1`);
    const entries = w.entries();
    expect(entries.map(([k]) => k)).toEqual([`${ORIGIN}/a/door`]);
    const stored = entries[0]![1] as { body: string };
    expect(stored.body).toContain(OFFLINE_SNAPSHOT_MARKER);
    expect(stored.body).not.toContain("SECPROBE");
    expect([...w.stores.keys()]).toEqual(["atrium-app:door:3"]);
  });

  it("stores nothing when the snapshot answer has no marker (page text cannot forge one)", async () => {
    const forged = `<p>&lt;div hidden="" ${OFFLINE_SNAPSHOT_MARKER}=""&gt; ${EDITOR_HTML}</p>`;
    const w = worker((u) => (u.includes("offline=1") ? res(forged) : res(EDITOR_HTML)));
    await w.navigate("/a/door");
    expect(w.entries()).toEqual([]);
  });

  it("serves the snapshot offline, and the app's home snapshot for a page it never stored", async () => {
    let online = true;
    const w = worker((u) => {
      if (!online) throw new TypeError("offline");
      return u.includes("offline=1") ? res(SNAP_HTML) : res(EDITOR_HTML);
    });
    await w.navigate("/a/door");
    online = false;
    expect(((await w.navigate("/a/door")) as { body: string }).body).toContain(OFFLINE_SNAPSHOT_MARKER);
    expect(((await w.navigate("/a/door/other")) as { body: string }).body).toContain(OFFLINE_SNAPSHOT_MARKER);
  });

  it("forgets every cache of the app and tells its pages when access ends (404, 401, a redirect to sign-in)", async () => {
    for (const lost of [res("no", { status: 404 }), res("no", { status: 401 }), res("<p>sign in</p>", { redirected: true, url: `${ORIGIN}/sign-in?next=/a/door` })]) {
      let gone = false;
      const w = worker((u) => (!gone ? (u.includes("offline=1") ? res(SNAP_HTML) : res(EDITOR_HTML)) : u.includes("offline=1") ? lost : res("", { status: 0, type: "opaqueredirect", ok: false })));
      await w.navigate("/a/door");
      expect(w.entries().length).toBe(1);
      gone = true;
      // A 404 or 401 on the page itself, or a redirect whose snapshot check lands outside the app.
      if (lost.status !== 200) await w.fire("fetch", { request: { method: "GET", url: `${ORIGIN}/a/door`, mode: "navigate" } });
      else await w.navigate("/a/door");
      expect(w.stores.size).toBe(0);
      expect(w.posted).toContainEqual({ type: "atrium-offline-cleared" });
    }
  });

  it("final r4 item 1: a revoked or expired guest link (404 with the friendly screen) makes the worker forget the app", async () => {
    let revoked = false;
    const expired = "<!doctype html><p data-guest-expired>This link has expired or was turned off.</p>";
    const w = worker((u) => (revoked ? res(expired, { status: 404 }) : u.includes("offline=1") ? res(SNAP_HTML) : res("<p>SECPROBE-guest-visible</p>")));
    await w.navigate("/a/door");
    expect(w.entries().length).toBe(1);
    revoked = true;
    await w.fire("fetch", { request: { method: "GET", url: `${ORIGIN}/a/door`, mode: "navigate" } });
    expect(w.stores.size).toBe(0);
    expect(w.posted).toContainEqual({ type: "atrium-offline-cleared" });
  });

  it("final r4 item 1: a good snapshot answer without the marker (any page that is not the app's snapshot) also forgets the app", async () => {
    let ended = false;
    const w = worker((u) => (u.includes("offline=1") ? res(ended ? "<p data-guest-expired>ended</p>" : SNAP_HTML) : res("<p>page</p>")));
    await w.navigate("/a/door");
    expect(w.entries().length).toBe(1);
    ended = true;
    await w.navigate("/a/door");
    expect(w.stores.size).toBe(0);
    expect(w.posted).toContainEqual({ type: "atrium-offline-cleared" });
  });

  it("final r4: forgetting and activating never touch another app whose slug starts with this one", async () => {
    const w = worker((u) => (u.includes("offline=1") ? res(SNAP_HTML) : res("<p>x</p>")));
    w.stores.set("atrium-app:door-other:1", new Map([["k", "v"]]));
    w.stores.set("atrium-app:door:2", new Map([["k", "v"]]));
    await w.fire("activate", {});
    expect([...w.stores.keys()].sort()).toEqual(["atrium-app:door-other:1"]);
    await w.fire("message", { data: { type: "atrium-forget" } });
    expect([...w.stores.keys()]).toEqual(["atrium-app:door-other:1"]);
  });

  it("final re-check: an app whose slug ends like a version never deletes the shorter-slug app's caches", async () => {
    // Under the old "atrium-app-<slug>-s2-<version>" names, app "door-s2" took "atrium-app-door-s2-1" (app
    // "door" at version 1) for its own. With "atrium-app:<slug>:<version>" names it cannot.
    const w = worker((u) => (u.includes("offline=1") ? res(SNAP_HTML) : res("<p>x</p>")), "door-s2");
    w.stores.set("atrium-app:door:1", new Map([["k", "v"]]));
    w.stores.set("atrium-app:door-s2:1", new Map([["k", "v"]]));
    await w.fire("message", { data: { type: "atrium-forget" } });
    expect([...w.stores.keys()]).toEqual(["atrium-app:door:1"]);
  });

  it("a page's cache message stores snapshots for its own pages, files for the rest, and skips drafts", async () => {
    const w = worker((u) => (u.includes("offline=1") ? res(SNAP_HTML) : res(u.endsWith(".js") ? "js" : EDITOR_HTML)));
    await w.fire("message", { data: { type: "atrium-cache", urls: [`${ORIGIN}/a/door/kitchen`, `${ORIGIN}/a/door?draft=1`, `${ORIGIN}/_next/static/x.js`, `${ORIGIN}/a/door-other`] } });
    const keys = w.entries().map(([k]) => k).sort();
    expect(keys).toEqual([`${ORIGIN}/_next/static/x.js`, `${ORIGIN}/a/door/kitchen`]);
    expect(w.fetched).not.toContain(`${ORIGIN}/a/door/kitchen`); // only the snapshot of it was asked for
    expect(w.fetched.some((u) => u.includes("draft"))).toBe(false);
  });

  it("activating deletes the earlier caches of the app, including round 2's whole-page caches", async () => {
    const w = worker(() => res(SNAP_HTML));
    // Legacy hyphen names (round 2 whole-page caches, round 3 "s2" caches) cannot be traced to one app,
    // so any app worker deletes them; another app's current cache stays.
    for (const name of ["atrium-app:door:3", "atrium-app:door:2", "atrium-app-door-s2-2", "atrium-app-other-1", "atrium-app:other:1"]) w.stores.set(name, new Map([["k", "v"]]));
    await w.fire("activate", {});
    expect([...w.stores.keys()].sort()).toEqual(["atrium-app:door:3", "atrium-app:other:1"]);
  });
});

describe("last values belong to one person", () => {
  function fakeStorage() {
    const m = new Map<string, string>();
    return { get length() { return m.size; }, key: (i: number) => [...m.keys()][i] ?? null, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
  }
  it("another person's values are wiped before use; the same person keeps theirs; forget removes them all", () => {
    const s = fakeStorage();
    (globalThis as { window?: unknown }).window = { localStorage: s };
    try {
      s.setItem(LAST_OWNER_KEY, "user:editor");
      s.setItem("atrium:last:app1:p1", "{\"data\":{\"door\":\"SECPROBE\"}}");
      s.setItem("atrium:theme", "keep me");
      expect(claimLastValues("user:editor")).toBe(false);
      expect(s.getItem("atrium:last:app1:p1")).not.toBeNull();
      expect(claimLastValues("guest:link-2")).toBe(true);
      expect(s.getItem("atrium:last:app1:p1")).toBeNull();
      expect(s.getItem(LAST_OWNER_KEY)).toBe("guest:link-2");
      expect(s.getItem("atrium:theme")).toBe("keep me");
      s.setItem("atrium:last:app1:p2", "{}");
      forgetLastValues();
      expect([...s.m.keys()]).toEqual(["atrium:theme"]);
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });
});
