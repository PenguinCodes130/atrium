// Default deny (architecture section 5) and the response headers from section 13. Owned by auth.
// This is only the front gate: every route handler and server action also calls requireUser() or
// requireScope() from "@/features/auth".
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/core/env";
import { RateLimited } from "@/core/errors";
import { guestFromHeaders, hasGuestCookie } from "@/features/auth/guest/service";
import { guestRouteOf, isDraftRequest } from "@/features/auth/guest/policy";
import { ensureBootstrapped } from "@/features/auth/server/bootstrap";
import { clientAddress, hit } from "@/features/auth/server/rate-limit";
import { sessionFromHeaders } from "@/features/auth/server/session";
import {
  MUTATING,
  csrfExempt,
  isApiPath,
  isPublicPath,
  isStaticAsset,
  isGuestEntryPath,
  isAccountLinkPath,
  isAccountPath,
  accountRedirectTarget,
  frameOrigins,
  originAllowed,
  passHeaders,
  securityHeaders,
  withoutDraft,
  wwwAuthenticate,
} from "@/features/auth/server/security";

function json(status: number, code: string, message: string, extra: Record<string, string> = {}) {
  return NextResponse.json({ error: { code, message } }, { status, headers: extra });
}

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const publicUrl = new URL(env().ATRIUM_PUBLIC_URL);
  const https = publicUrl.protocol === "https:";
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const headers = securityHeaders(nonce, https, frameOrigins(publicUrl.origin, env().ATRIUM_LAN_ORIGINS));
  const isBearer = /^Bearer\s/i.test(req.headers.get("authorization") ?? "");
  const api = isApiPath(pathname) || req.headers.has("next-action");

  const finish = (res: NextResponse) => {
    for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
    return res;
  };

  if (isStaticAsset(pathname)) return finish(NextResponse.next());

  // CSRF: mutating requests must come from the public URL. Only a request with no Atrium cookie
  // (a pure bearer MCP call, or an OAuth client on the token endpoint) skips the check.
  if (MUTATING.has(req.method) && !csrfExempt(pathname, req.headers) && !originAllowed(req.headers, publicUrl.origin)) {
    return finish(json(403, "bad_origin", "This request did not come from this Atrium."));
  }

  // A4.4: /account (and anything under it) moved to /settings/security for good; the query is kept.
  if (isAccountPath(pathname)) return finish(NextResponse.redirect(new URL(accountRedirectTarget(search), req.url), 308));

  const setup = await ensureBootstrapped();
  if (setup.state !== "ready") {
    // No users yet: only the setup-required screen and the health probe answer.
    if (pathname === "/setup-required" || pathname === "/api/health" || pathname === "/manifest.webmanifest") return pass(req, nonce, headers);
    if (api) return finish(json(401, "setup_required", setup.message));
    return finish(NextResponse.redirect(new URL("/setup-required", req.url)));
  }

  if (isPublicPath(pathname)) {
    // Amendment A1.3: opening guest links is limited to 30 requests per minute per IP.
    if (isGuestEntryPath(pathname) && pathname !== "/g/expired") {
      const limited = limit("guestOpenIp", clientAddress(req.headers, env().ATRIUM_TRUSTED_PROXIES) ?? "unknown-peer", api);
      if (limited) return finish(limited);
    }
    // Amendment 3: invite and reset links. Agents cannot reach them (a bearer token is refused and
    // consumes nothing), and opening them is limited to 30 requests per minute per IP.
    if (isAccountLinkPath(pathname) && pathname !== "/invite/expired" && pathname !== "/invite/signed-in") {
      if (isBearer) return finish(json(403, "agents_refused", "Agents cannot use invite and reset links."));
      const limited = limit("accountLinkIp", clientAddress(req.headers, env().ATRIUM_TRUSTED_PROXIES) ?? "unknown-peer", api || req.method !== "GET");
      if (limited) return finish(limited);
    }
    return pass(req, nonce, headers);
  }

  // MCP with a bearer token: the MCP handler resolves the token through requireScope().
  if (isBearer && (pathname === "/mcp" || pathname.startsWith("/mcp/"))) return pass(req, nonce, headers);

  const session = await sessionFromHeaders(req.headers);
  if (session) return pass(req, nonce, headers);

  // Guest links (architecture v3 5.1): a valid guest cookie opens exactly the guest routes of its own
  // app. Every guest route handler also calls requireViewer(); this is only the front gate.
  if (hasGuestCookie(req.headers)) {
    const route = guestRouteOf(pathname);
    if (route) {
      const guest = await guestFromHeaders(req.headers);
      if (guest) {
        const own = route.kind !== "page" || route.slug === guest.app.slug;
        if (own) {
          if (route.kind === "page" || route.kind === "stream") {
            const limited = limit("guestRequest", guest.sessionId, route.kind === "stream");
            if (limited) return finish(limited);
          }
          // A guest never sees a draft: asking for one serves the published page (the page and the data
          // stream also ignore the flag for anyone who cannot edit the app).
          if (route.kind === "page" && isDraftRequest(search)) return rewriteTo(withoutDraft(new URL(req.url)), req, nonce, headers);
          return pass(req, nonce, headers);
        }
      } else if (route.kind === "page") {
        // Amendment A1.3: an ended guest session on /a/<slug> sees the expired link screen. The viewer
        // draws it itself (app-builder final r4 SFR, gauntlet w2-r3 item 1, security): it finds no
        // principal and answers the same screen with status 404, not the 200 of a rewrite to /g/expired,
        // so the app's offline worker forgets the app and the page forgets its last values.
        return pass(req, nonce, headers);
      }
    }
  }

  if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
    return finish(json(401, "unauthorized", "Sign in to continue.", { "WWW-Authenticate": wwwAuthenticate(publicUrl.origin) }));
  }
  if (api) return finish(json(401, "unauthorized", "Sign in to continue."));
  const to = new URL("/sign-in", req.url);
  if (pathname !== "/") to.searchParams.set("next", `${pathname}${search}`);
  return finish(NextResponse.redirect(to));
}

/** Counts one request; returns the 429 response once over the limit, else null. */
function limit(name: "guestOpenIp" | "guestRequest" | "accountLinkIp", subject: string, api: boolean): NextResponse | null {
  try {
    hit(name, subject);
    return null;
  } catch (err) {
    if (!(err instanceof RateLimited)) throw err;
    const retry = { "Retry-After": String(err.retryAfterSec) };
    if (api) return json(429, "rate_limited", err.message, retry);
    return new NextResponse(err.message, { status: 429, headers: { ...retry, "content-type": "text/plain; charset=utf-8" } });
  }
}

function rewriteTo(path: string | URL, req: NextRequest, nonce: string, headers: Record<string, string>) {
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", headers["Content-Security-Policy"]!);
  const res = NextResponse.rewrite(typeof path === "string" ? new URL(path, req.url) : path, { request: { headers: requestHeaders } });
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}

function pass(req: NextRequest, nonce: string, headers: Record<string, string>) {
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", headers["Content-Security-Policy"]!);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  // Routes with their own security headers keep them (the HTML block frame, uploads, the image proxy).
  for (const [k, v] of Object.entries(passHeaders(req.nextUrl.pathname, headers))) res.headers.set(k, v);
  return res;
}

export const config = {
  // Everything except built static chunks; those still get headers from next.config (shared file request).
  matcher: ["/((?!_next/static|_next/image).*)"],
};
