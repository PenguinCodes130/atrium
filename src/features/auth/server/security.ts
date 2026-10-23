// Security posture for exposed instances (architecture section 13): response headers and the
// default-deny path rules (section 5). Pure functions, used by src/proxy.ts and unit tests.
import { isAccountLinkPath } from "../account-links/policy";

export { isAccountLinkPath };

// Architecture v3 A4.4: the old signed-in account screen moved under settings. /account and every path
// under it answer a permanent redirect to /settings/security, with the query kept (the rest of the path
// is dropped: settings has no matching sub-pages).
export const ACCOUNT_MOVED_TO = "/settings/security";

export function isAccountPath(pathname: string): boolean {
  return pathname === "/account" || pathname.startsWith("/account/");
}

/** `search` is the already encoded query including its "?" (or ""), as `URL.search` gives it. */
export function accountRedirectTarget(search: string): string {
  return search && search !== "?" ? `${ACCOUNT_MOVED_TO}${search}` : ACCOUNT_MOVED_TO;
}

/** The HTML block frame (architecture 13): the only document Atrium pages may frame. */
export const SANDBOX_FRAME_PATH = "/sandbox/frame";

/**
 * The origins a page may frame the HTML block frame from: the public URL and each LAN origin
 * (comma-separated `ATRIUM_LAN_ORIGINS`). Malformed entries are skipped.
 */
export function frameOrigins(publicOrigin: string, lanOrigins?: string): string[] {
  const out: string[] = [];
  for (const raw of [publicOrigin, ...(lanOrigins ?? "").split(",")]) {
    try {
      const o = new URL(raw.trim()).origin;
      if (o !== "null" && !out.includes(o)) out.push(o);
    } catch {
      /* not an origin */
    }
  }
  return out;
}

export function buildCsp(nonce: string, https: boolean, frameFrom: string[] = []): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    // React and Motion write style attributes, which a nonce cannot cover; scripts stay nonce-only.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    // Components SFR-1: pages frame only the HTML block frame, by its exact path, so a block that sets
    // its own location to any other Atrium URL is refused by the browser before a request leaves.
    frameFrom.length ? `frame-src ${frameFrom.map((o) => `${o}${SANDBOX_FRAME_PATH}`).join(" ")}` : "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

export const PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), browsing-topics=()";

export function securityHeaders(nonce: string, https: boolean, frameFrom: string[] = []): Record<string, string> {
  return {
    "Content-Security-Policy": buildCsp(nonce, https, frameFrom),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": PERMISSIONS_POLICY,
    "X-Frame-Options": "DENY",
    ...(https ? { "Strict-Transport-Security": "max-age=63072000; includeSubDomains" } : {}),
  };
}

/**
 * Routes whose own security headers must stand (architecture 13):
 * - "frame": `/sandbox/frame` sets its sandbox CSP, `frame-ancestors <origin>` and DNS prefetch off.
 *   The proxy adds only nosniff: no shell CSP and no `X-Frame-Options: DENY` (components SFR-1).
 * - "file": `/uploads/*` and `/api/img` are served under the sandbox CSP below instead of the page CSP
 *   (settings SFR 2). The proxy sets the same value, so error answers from those routes carry it too.
 */
export function ownHeadersRoute(pathname: string): "frame" | "file" | null {
  if (pathname === SANDBOX_FRAME_PATH) return "frame";
  if (pathname.startsWith("/uploads/") || pathname === "/api/img") return "file";
  return null;
}

export const FILE_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'";

/** The headers the proxy puts on a response that a route handler will answer. */
export function passHeaders(pathname: string, shell: Record<string, string>): Record<string, string> {
  const own = ownHeadersRoute(pathname);
  if (own === "frame") return { "X-Content-Type-Options": "nosniff" };
  if (own === "file") return { ...shell, "Content-Security-Policy": FILE_CSP };
  return shell;
}

/** Architecture v3 5.1 and app-builder criterion 17: a guest asking for a draft gets the published page. */
export function withoutDraft(url: URL): URL {
  const out = new URL(url);
  out.searchParams.delete("draft");
  return out;
}

// ---- Default deny ---------------------------------------------------------------------------------

const STATIC_PREFIXES = ["/_next/static/", "/_next/image", "/brand/", "/fonts/"];
const STATIC_FILES = new Set(["/favicon.ico", "/robots.txt", "/sw.js"]);

/** Paths open without a session, exactly as architecture section 5 lists them. */
export function isPublicPath(pathname: string): boolean {
  if (pathname === "/sign-in" || pathname === "/setup-required") return true;
  if (pathname === "/api/health" || pathname === "/manifest.webmanifest") return true;
  if (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) return true;
  if (pathname.startsWith("/.well-known/")) return true;
  // Architecture v3 section 5: guest entry and the HTML block frame need no principal at the gate.
  if (isGuestEntryPath(pathname) || pathname === "/sandbox" || pathname.startsWith("/sandbox/")) return true;
  // Amendment 3: invite and reset links are opened by people who cannot sign in yet.
  if (isAccountLinkPath(pathname)) return true;
  // Settings r2 (gauntlet w2-r1 item 8): the three instance branding images, shown on the sign-in page.
  if (/^\/uploads\/brand\/(logo|favicon|sign-in)$/.test(pathname)) return true;
  return isStaticAsset(pathname);
}

/** `/g/<token>` and the screens under it (PIN, expired). */
export function isGuestEntryPath(pathname: string): boolean {
  return pathname.startsWith("/g/");
}

export function isStaticAsset(pathname: string): boolean {
  return STATIC_FILES.has(pathname) || STATIC_PREFIXES.some((p) => pathname.startsWith(p));
}

export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/") || pathname === "/mcp" || pathname.startsWith("/mcp/");
}

export const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** CSRF: a mutating request must come from the public URL's origin (Origin, else Referer). */
export function originAllowed(headers: Headers, publicOrigin: string): boolean {
  const origin = headers.get("origin");
  if (origin) return origin === publicOrigin;
  const referer = headers.get("referer");
  if (!referer) return false;
  try {
    return new URL(referer).origin === publicOrigin;
  } catch {
    return false;
  }
}

/** Names of the cookies on this request (values are never read here). */
export function cookieNames(headers: Headers): string[] {
  const raw = headers.get("cookie");
  if (!raw) return [];
  return raw
    .split(";")
    .map((p) => p.slice(0, p.indexOf("=") >= 0 ? p.indexOf("=") : undefined).trim())
    .filter(Boolean);
}

/** True when the request carries any Atrium cookie (session, two-factor challenge, step-up ticket). */
export function hasAtriumCookie(headers: Headers): boolean {
  return cookieNames(headers).some((n) => n.startsWith("atrium."));
}

export function hasBearer(headers: Headers): boolean {
  return /^Bearer\s/i.test(headers.get("authorization") ?? "");
}

// OAuth endpoints that MCP clients call from their own process (no browser, so no Origin header).
export const OAUTH_MACHINE_PATHS = new Set(["/api/auth/oauth2/token", "/api/auth/oauth2/register", "/api/auth/oauth2/revoke", "/api/auth/oauth2/introspect"]);

/**
 * CSRF exemption (auth gauntlet r1, fix 1). Only a request with no Atrium cookie at all may skip the
 * Origin/Referer check: a bearer-only MCP call, or an OAuth client on the token or registration
 * endpoint. Cookies are the only ambient credential, so a request without one has nothing to forge.
 * A request that carries a session cookie is always checked, whatever Authorization header it sends.
 */
export function csrfExempt(pathname: string, headers: Headers): boolean {
  if (hasAtriumCookie(headers)) return false;
  return hasBearer(headers) || OAUTH_MACHINE_PATHS.has(pathname);
}

export const PROTECTED_RESOURCE_METADATA = "/.well-known/oauth-protected-resource";

export function wwwAuthenticate(publicOrigin: string): string {
  return `Bearer resource_metadata="${publicOrigin}${PROTECTED_RESOURCE_METADATA}"`;
}
