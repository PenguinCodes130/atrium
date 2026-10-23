// Auth round 6 (architecture v3 A4.4): /account moved to /settings/security for good, and the two
// settings panels are exported for settings to mount unchanged.
import { describe, expect, it } from "vitest";
import { ACCOUNT_MOVED_TO, accountRedirectTarget, isAccountPath, isPublicPath } from "./server/security";

describe("A4.4: /account is a permanent redirect to /settings/security", () => {
  it("matches /account and every path under it, nothing else", () => {
    for (const p of ["/account", "/account/", "/account/security", "/account/a/b"]) expect(isAccountPath(p), p).toBe(true);
    for (const p of ["/accounts", "/accountx", "/settings/account", "/", "/api/account", "/invite/account"]) expect(isAccountPath(p), p).toBe(false);
  });

  it("keeps the query, drops the rest of the path", () => {
    expect(ACCOUNT_MOVED_TO).toBe("/settings/security");
    expect(accountRedirectTarget("")).toBe("/settings/security");
    expect(accountRedirectTarget("?")).toBe("/settings/security");
    expect(accountRedirectTarget("?tab=sessions&x=caf%C3%A9")).toBe("/settings/security?tab=sessions&x=caf%C3%A9");
  });

  it("/account stays a gated path (the redirect runs before the gate, the target is gated)", () => {
    expect(isPublicPath("/account")).toBe(false);
    expect(isPublicPath("/settings/security")).toBe(false);
  });
});
