import { describe, expect, it } from "vitest";
import type { Principal, Role } from "@/core/contracts";
import {
  checkPassword,
  checkScope,
  matchAllowlist,
  normalizePattern,
  stepUpValid,
  STEP_UP_WINDOW_MS,
  isValidEmail,
} from "./server/policy";
import { COMMON_PASSWORDS } from "./server/common-passwords";
import { buildCsp, csrfExempt, isPublicPath, originAllowed, securityHeaders, wwwAuthenticate } from "./server/security";
import { clientAddress, isTrustedProxy } from "./server/rate-limit";
import { markPeerStampInstalledForTests, stampValue, verifiedPeer } from "./server/peer";

const agent = (role: Role, scopes: ("atrium:read" | "atrium:edit" | "atrium:propose")[]): Principal => ({
  kind: "agent",
  userId: "u1",
  role,
  via: "pat",
  tokenId: "t1",
  agentName: "test agent",
  scopes,
});
const user = (role: Role): Principal => ({ kind: "user", userId: "u1", role, via: "session" });

describe("allowlist patterns (criterion 10)", () => {
  const entries = [{ pattern: "*@example.com", role: "member" as const }];
  it("admits a@example.com and refuses a@example.org", () => {
    expect(matchAllowlist("a@example.com", entries)?.role).toBe("member");
    expect(matchAllowlist("A@Example.COM", entries)).not.toBeNull();
    expect(matchAllowlist("a@example.org", entries)).toBeNull();
    expect(matchAllowlist("a@sub.example.com", entries)).toBeNull();
  });
  it("prefers an exact email over a domain pattern", () => {
    const list = [...entries, { pattern: "boss@example.com", role: "viewer" as const }];
    expect(matchAllowlist("boss@example.com", list)?.role).toBe("viewer");
  });
  it("normalises valid patterns and refuses others", () => {
    expect(normalizePattern(" *@Example.com ")).toBe("*@example.com");
    expect(normalizePattern("Ana@Example.com")).toBe("ana@example.com");
    expect(normalizePattern("*@")).toBeNull();
    expect(normalizePattern("*@*.com")).toBeNull();
    expect(normalizePattern("example.com")).toBeNull();
  });
  it("validates owner emails (criterion 2)", () => {
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("owner@atrium.test")).toBe(true);
  });
});

describe("password rules (criterion 11)", () => {
  it("bundles 10,000 common passwords", () => {
    expect(COMMON_PASSWORDS.length).toBeGreaterThanOrEqual(10_000);
  });
  it("refuses 11 characters", () => {
    expect(checkPassword("abcdefghijk")?.rule).toBe("length");
  });
  it("refuses a 12-character password from the common list", () => {
    expect("unbelievable".length).toBe(12);
    expect(COMMON_PASSWORDS).toContain("unbelievable");
    expect(checkPassword("unbelievable")?.rule).toBe("common");
    expect(checkPassword("Unbelievable")?.rule).toBe("common");
  });
  it("accepts a 12-character password not on the list", () => {
    expect(checkPassword("violet-kayak")).toBeNull();
  });
  it("says which rule failed", () => {
    expect(checkPassword("short")?.message).toMatch(/at least 12 characters/);
    expect(checkPassword("unbelievable")?.message).toMatch(/common passwords/);
  });
});

describe("scopes and roles (criteria 30, 31, 32)", () => {
  it("viewers can read but not edit or propose", () => {
    expect(checkScope(user("viewer"), "atrium:read").ok).toBe(true);
    const d = checkScope(user("viewer"), "atrium:edit");
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.status).toBe(403);
      expect(d.missing.role).toBe("member");
      expect(d.message).toContain("member");
    }
  });
  it("a read-only token cannot use edit or propose tools", () => {
    expect(checkScope(agent("owner", ["atrium:read"]), "atrium:edit").ok).toBe(false);
    expect(checkScope(agent("owner", ["atrium:read"]), "atrium:propose").ok).toBe(false);
    const d = checkScope(agent("owner", ["atrium:read"]), "atrium:edit");
    if (!d.ok) expect(d.missing.scope).toBe("atrium:edit");
  });
  it("a viewer's token cannot edit even with the edit scope", () => {
    const d = checkScope(agent("viewer", ["atrium:read", "atrium:edit"]), "atrium:edit");
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.missing.role).toBe("member");
  });
  it("a member's edit token can edit; minRole raises the bar", () => {
    expect(checkScope(agent("member", ["atrium:edit"]), "atrium:edit").ok).toBe(true);
    expect(checkScope(agent("member", ["atrium:edit"]), "atrium:edit", "owner").ok).toBe(false);
  });
});

describe("step-up window (criterion 24)", () => {
  const t0 = Date.parse("2026-10-17T12:00:00Z");
  it("covers 9 minutes and not 11", () => {
    expect(stepUpValid(new Date(t0), t0 + 9 * 60_000)).toBe(true);
    expect(stepUpValid(new Date(t0), t0 + 11 * 60_000)).toBe(false);
    expect(STEP_UP_WINDOW_MS).toBe(600_000);
    expect(stepUpValid(null, t0)).toBe(false);
  });
});

describe("security headers (criterion 42)", () => {
  it("has the strict CSP, nosniff and same-origin referrer; HSTS only over https", () => {
    const h = securityHeaders("abc", false);
    expect(h["Content-Security-Policy"]).toContain("default-src 'self'");
    expect(h["Content-Security-Policy"]).toContain("img-src 'self' data: blob:");
    expect(h["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(h["Content-Security-Policy"]).toContain("'nonce-abc'");
    expect(h["Content-Security-Policy"]).not.toContain("unsafe-eval");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Referrer-Policy"]).toBe("same-origin");
    expect(h["Strict-Transport-Security"]).toBeUndefined();
    expect(securityHeaders("abc", true)["Strict-Transport-Security"]).toMatch(/max-age=\d+/);
    expect(buildCsp("n", true)).toContain("upgrade-insecure-requests");
  });
});

describe("default deny paths (criterion 25)", () => {
  it("opens exactly the listed paths", () => {
    for (const p of ["/sign-in", "/setup-required", "/api/auth/sign-in/email", "/api/health", "/manifest.webmanifest", "/.well-known/oauth-protected-resource", "/_next/static/x.js"]) {
      expect(isPublicPath(p), p).toBe(true);
    }
    for (const p of ["/", "/settings", "/settings/users", "/api/pages", "/mcp", "/integrations/abc/credentials", "/consent", "/step-up", "/sign-up", "/api/healthz", "/sign-in-x"]) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });
});

describe("origin check (criterion 43)", () => {
  const o = "http://127.0.0.1:3111";
  it("accepts the public origin and refuses others", () => {
    expect(originAllowed(new Headers({ origin: o }), o)).toBe(true);
    expect(originAllowed(new Headers({ origin: "https://evil.example" }), o)).toBe(false);
    expect(originAllowed(new Headers({ referer: `${o}/settings` }), o)).toBe(true);
    expect(originAllowed(new Headers({ referer: "https://evil.example/x" }), o)).toBe(false);
    expect(originAllowed(new Headers(), o)).toBe(false);
  });
  it("points the 401 at the protected resource metadata (criterion 33)", () => {
    expect(wwwAuthenticate(o)).toBe(`Bearer resource_metadata="${o}/.well-known/oauth-protected-resource"`);
  });
});

describe("client address (auth gauntlet r1, fix 2)", () => {
  const peer = (ip: string, extra: Record<string, string> = {}) => new Headers({ "x-atrium-peer": stampValue(ip), ...extra });

  it("is the socket peer for a direct client, whatever X-Forwarded-For it sends", () => {
    markPeerStampInstalledForTests(true);
    expect(clientAddress(peer("203.0.113.7", { "x-forwarded-for": "198.51.100.1" }), undefined)).toBe("203.0.113.7");
    expect(clientAddress(peer("203.0.113.7", { "x-forwarded-for": "198.51.100.2" }), undefined)).toBe("203.0.113.7");
    // A peer that is not a listed proxy cannot speak for anyone else either.
    expect(clientAddress(peer("203.0.113.7", { "x-forwarded-for": "198.51.100.1" }), "10.77.99.6")).toBe("203.0.113.7");
  });

  it("reads X-Forwarded-For only when the socket peer is a trusted proxy", () => {
    markPeerStampInstalledForTests(true);
    expect(clientAddress(peer("10.77.99.6", { "x-forwarded-for": "198.51.100.7" }), "10.77.99.6")).toBe("198.51.100.7");
    // Walks from the right past trusted hops; a client-sent left part never wins over the proxy's entry.
    expect(clientAddress(peer("10.77.99.6", { "x-forwarded-for": "1.2.3.4, 198.51.100.7" }), "10.77.99.6")).toBe("198.51.100.7");
    expect(clientAddress(peer("::ffff:10.77.99.6", { "x-forwarded-for": "198.51.100.7" }), "10.77.99.0/24")).toBe("198.51.100.7");
    expect(clientAddress(peer("10.77.99.6"), "10.77.99.6")).toBe("10.77.99.6");
  });

  it("is unknown (null) when the stamp is missing, forged or not installed", () => {
    markPeerStampInstalledForTests(true);
    expect(clientAddress(new Headers({ "x-forwarded-for": "198.51.100.7" }), undefined)).toBeNull();
    expect(clientAddress(new Headers({ "x-atrium-peer": "198.51.100.7;forged" }), undefined)).toBeNull();
    const other = stampValue("198.51.100.7").replace("198.51.100.7", "198.51.100.8");
    expect(verifiedPeer(new Headers({ "x-atrium-peer": other }))).toBeNull();
    markPeerStampInstalledForTests(false);
    expect(clientAddress(peer("203.0.113.7"), undefined)).toBeNull();
    markPeerStampInstalledForTests(true);
  });

  it("matches trusted proxies by exact address or IPv4 CIDR", () => {
    expect(isTrustedProxy("10.77.99.6", "10.77.99.0/24")).toBe(true);
    expect(isTrustedProxy("10.77.98.6", "10.77.99.0/24")).toBe(false);
    expect(isTrustedProxy("::1", "127.0.0.1, ::1")).toBe(true);
    expect(isTrustedProxy("10.77.99.6", undefined)).toBe(false);
  });
});

describe("CSRF exemption (auth gauntlet r1, fix 1)", () => {
  it("never exempts a request that carries an Atrium cookie, whatever Authorization it sends", () => {
    expect(csrfExempt("/api/integrations/detect", new Headers({ authorization: "Bearer x", cookie: "atrium.session=abc.def" }))).toBe(false);
    expect(csrfExempt("/api/auth/oauth2/token", new Headers({ cookie: "atrium.session=abc.def" }))).toBe(false);
  });
  it("exempts only cookie-free bearer calls and cookie-free OAuth client endpoints", () => {
    expect(csrfExempt("/mcp", new Headers({ authorization: "Bearer atr_pat_x" }))).toBe(true);
    expect(csrfExempt("/api/auth/oauth2/token", new Headers())).toBe(true);
    expect(csrfExempt("/api/auth/oauth2/register", new Headers({ cookie: "unrelated=1" }))).toBe(true);
    expect(csrfExempt("/api/auth/sign-in/email", new Headers())).toBe(false);
    expect(csrfExempt("/api/integrations/detect", new Headers())).toBe(false);
  });
});
