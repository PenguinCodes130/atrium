// Per-app install (spec section 3 "Install", criteria 47 and 48): each app has its own web manifest and
// its own worker, so it installs as a separate home-screen app. Pure.
//
// Gauntlet w2-r1 item 4: the app's canonical address is `/a/<slug>` (the server redirects `/a/<slug>/` to
// it), so start_url, scope and the worker's scope are `/a/<slug>` too; a worker scoped to `/a/<slug>/`
// never controlled the page. A scope without the slash is a string prefix (it would also cover
// `/a/<slug>-other`), so the worker itself only answers for `/a/<slug>` and `/a/<slug>/...`.
import type { App, Theme } from "@/core/contracts";
import { APP_CACHE_PREFIX, appCachePrefix, LEGACY_APP_CACHE_PREFIX } from "./offline";

export { APP_CACHE_PREFIX };

export type WebManifest = {
  id: string;
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: "standalone";
  background_color: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
};

const UPLOAD_ICON = /^\/uploads\/[a-z0-9]{20}\.(png|webp|jpg|svg)$/;

/** The app's canonical address, which is also its manifest start_url and scope and its worker scope. */
export function appBase(slug: string): string {
  return `/a/${slug}`;
}

/**
 * The colours the browser paints around an installed app: the theme's surface. Gauntlet w2-r2 item 12:
 * a separate dark colour only for a theme that renders its dark set when the viewer is dark (mode
 * "auto" with a dark set); a light or dark theme renders the same either way, so both are its surface.
 */
export function appThemeColors(theme?: Theme): { light: string; dark: string } {
  const light = theme?.tokens?.color?.surface ?? "#F3EFE4";
  const dark = theme?.mode === "auto" && theme.dark?.color?.surface ? theme.dark.color.surface : light;
  return { light, dark };
}

/** The icon a home screen uses at a size: the app's uploaded icon, or the lit Atrium mark. */
export function appIcon(app: Pick<App, "icon">, size: 192 | 512): { src: string; type: string } {
  const custom = app.icon && UPLOAD_ICON.test(app.icon) ? app.icon : null;
  if (!custom) return { src: `/brand/icon-${size}.png`, type: "image/png" };
  return { src: custom, type: custom.endsWith(".svg") ? "image/svg+xml" : custom.endsWith(".webp") ? "image/webp" : custom.endsWith(".jpg") ? "image/jpeg" : "image/png" };
}

export function appManifest(app: Pick<App, "slug" | "name" | "icon">, theme?: Theme): WebManifest {
  const base = appBase(app.slug);
  const bg = theme?.tokens?.color?.surface ?? "#F3EFE4";
  // The page's theme-color meta uses the same surface (gauntlet w2-r1 item 21).
  const fg = appThemeColors(theme).light;
  const custom = app.icon && UPLOAD_ICON.test(app.icon) ? app.icon : null;
  const type = custom?.endsWith(".svg") ? "image/svg+xml" : custom?.endsWith(".webp") ? "image/webp" : custom?.endsWith(".jpg") ? "image/jpeg" : "image/png";
  const icons = custom
    ? [{ src: custom, sizes: "192x192", type }, { src: custom, sizes: "512x512", type }]
    : [{ src: "/brand/icon-192.png", sizes: "192x192", type: "image/png" }, { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png" }];
  return { id: `${base}/`, name: app.name, short_name: app.name.slice(0, 24), start_url: base, scope: base, display: "standalone", background_color: bg, theme_color: fg, icons };
}

/** The query that asks the viewer for an offline snapshot of a page (see `appWorker`). */
export const OFFLINE_SNAPSHOT_PARAM = "offline";
/** The marker every offline snapshot page carries; the worker stores nothing else. */
export const OFFLINE_SNAPSHOT_MARKER = "data-atrium-offline-snapshot";

/**
 * The app's own worker. Pages are network first. Gauntlet w2-r2 item 1 (security): the worker never
 * stores the page the person received. For offline use it stores a snapshot instead: the same page
 * asked for with `?offline=1`, which the server renders with the guest projection (no control run
 * details, no data source definitions, no navigation CSS source, no viewer name, no app switcher), so
 * nothing in the cache is more than the least-privileged viewer of that app could see. Snapshot pages
 * carry a marker and only marked pages are stored. When the server stops letting this browser open the
 * app (a redirect out of the app, such as to sign-in, or 401, 403, 404, which includes a guest whose
 * link was revoked or expired, gauntlet w2-r3 item 1; or a snapshot answer without the marker), the
 * worker deletes every cache of the app and tells its pages to forget their last values. Live data and
 * controls (`/api/`) always go to the server.
 */
export function appWorker(slug: string, version: string): string {
  const base = appBase(slug);
  return `// Atrium app worker for ${base} (generated). Network first for pages; offline snapshots only.
const PREFIX = ${JSON.stringify(appCachePrefix(slug))};
const LEGACY = ${JSON.stringify(LEGACY_APP_CACHE_PREFIX)};
// Snapshot-only caches named "atrium-app:<slug>:<version>". Activating deletes every other cache of this
// app and every legacy "atrium-app-..." cache (round 2 and 3 names, which held pages as the person received
// them or could not be told apart between apps).
const CACHE = PREFIX + ${JSON.stringify(version)};
const BASE = ${JSON.stringify(base)};
// The element the snapshot page renders (attribute order as React writes it). Page text is escaped, so
// content inside an app can never forge it.
const MARKER = ${JSON.stringify(`<div hidden="" ${OFFLINE_SNAPSHOT_MARKER}=""`)};
const SNAP = ${JSON.stringify(OFFLINE_SNAPSHOT_PARAM)};
// This app's caches only (slugs never contain ":", so no other app's name starts with PREFIX), plus legacy names.
const own = (k) => k.startsWith(PREFIX) || k.startsWith(LEGACY);
const inApp = (p) => p === BASE || p.startsWith(BASE + "/");
const cacheable = (u) => u.origin === self.location.origin && (u.pathname.startsWith("/_next/static/") || u.pathname.startsWith("/brand/") || u.pathname.startsWith("/fonts/") || (u.pathname.startsWith("/uploads/") && !/\.(mp4|webm)$/.test(u.pathname)));
const pagePath = (u) => (u.pathname.length > 1 && u.pathname.endsWith("/") ? u.pathname.slice(0, -1) : u.pathname);
const pageKey = (u) => self.location.origin + pagePath(u);
const special = (u) => u.searchParams.has("draft") || u.searchParams.has("render") || u.searchParams.has(SNAP);
const lostAccess = (res) => res.status === 401 || res.status === 403 || res.status === 404 || (res.redirected && !inApp(new URL(res.url).pathname));
const forget = () => caches.keys()
  .then((keys) => Promise.all(keys.filter(own).map((k) => caches.delete(k))))
  .then(() => self.clients.matchAll({ type: "window", includeUncontrolled: true }))
  .then((list) => list.forEach((c) => c.postMessage({ type: "atrium-offline-cleared" })));
const snapshot = (u) => {
  const s = new URL(pagePath(u), self.location.origin);
  s.searchParams.set(SNAP, "1");
  return fetch(s.href, { credentials: "same-origin", cache: "no-store" }).then((res) => {
    if (lostAccess(res)) return forget();
    if (!res.ok || res.type !== "basic") return null;
    // A good answer without the snapshot marker is not this app's snapshot (gauntlet w2-r3 item 1): the
    // server no longer shows this browser the app, so forget it rather than keep the old copy.
    return res.text().then((html) => html.includes(MARKER)
      ? caches.open(CACHE).then((c) => c.put(pageKey(u), new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })))
      : forget());
  }).catch(() => null);
};
self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => own(k) && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("message", (e) => {
  const d = e.data || {};
  if (d.type === "atrium-forget") { e.waitUntil(forget()); return; }
  if (d.type !== "atrium-cache" || !Array.isArray(d.urls)) return;
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(d.urls.slice(0, 200).map((raw) => {
    let u; try { u = new URL(raw, self.location.origin); } catch { return null; }
    if (u.origin !== self.location.origin || u.pathname.endsWith("/sw.js")) return null;
    // A page of this app: store its snapshot, never the page as this person received it.
    if (inApp(u.pathname)) return special(u) ? null : snapshot(u);
    if (!cacheable(u)) return null;
    return fetch(u.href, { credentials: "same-origin" }).then((res) => (res.ok && !res.redirected ? c.put(u.href, res) : null)).catch(() => null);
  }))));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  // Range requests (video) go to the network: the Cache API cannot store 206 answers.
  if (req.headers.has("range")) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  if (req.mode === "navigate") {
    if (!inApp(url.pathname) || special(url)) return;
    e.respondWith(fetch(req).then((res) => {
      // Access ended (signed out, link revoked, removed from the audience): forget everything offline.
      if (res.status === 401 || res.status === 403 || res.status === 404) e.waitUntil(forget());
      // A redirect (to sign-in, or to the canonical address) and every good page: the snapshot request
      // both refreshes the stored copy and tells whether this browser may still open the app.
      else if (res.type === "opaqueredirect" || res.redirected || (res.ok && res.type === "basic")) e.waitUntil(snapshot(url));
      return res;
    }).catch(() => caches.open(CACHE).then((c) => c.match(pageKey(url)).then((hit) => hit || c.match(self.location.origin + BASE))).then((hit) => hit || new Response("<!doctype html><meta charset=utf-8><title>Offline</title><p style='font:16px system-ui;padding:24px'>You're offline. This app will open again when the connection is back.</p>", { status: 503, headers: { "content-type": "text/html; charset=utf-8" } }))));
    return;
  }
  if (cacheable(url)) {
    e.respondWith(caches.open(CACHE).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }))));
  }
});
`;
}
