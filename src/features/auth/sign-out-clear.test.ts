// app-builder gauntlet w2-r2 item 1 (Shared File Request): a successful sign-out tells the browser to
// forget its caches and storage (the per-app offline copies and last values), and nothing else changes.
import { describe, expect, it, vi } from "vitest";
import { Client, freshDataDir, setEnv } from "./test/harness";

const OWNER = { email: "owner@atrium.test", password: "unit-owner-password-123" };

async function boot() {
  setEnv({ ATRIUM_DATA_DIR: freshDataDir(), ATRIUM_OWNER_EMAIL: OWNER.email, ATRIUM_OWNER_PASSWORD: OWNER.password });
  vi.resetModules();
  const handler = await import("./server/handler");
  await (await import("./server/bootstrap")).ensureBootstrapped();
  return handler;
}

describe("sign-out clears site data", () => {
  it("a signed-in sign-out answers with Clear-Site-Data and still ends the session cookie", async () => {
    const h = await boot();
    const c = new Client(h.handleAuthRequest);
    const signIn = await c.post("/api/auth/sign-in/email", OWNER);
    expect(signIn.status).toBe(200);
    expect(signIn.headers.get("clear-site-data")).toBeNull();
    expect(c.jar.size).toBeGreaterThan(0);
    const out = await c.post("/api/auth/sign-out", {});
    expect(out.status).toBe(200);
    expect(out.headers.get("clear-site-data")).toBe('"cache", "storage"');
    expect(out.headers.getSetCookie().length).toBeGreaterThan(0);
    expect([...c.jar.keys()].some((k) => k.includes("session_token"))).toBe(false);
  });
  it("only a successful sign-out carries the header", () => {
    return boot().then((h) => {
      const ok = h.withSignOutClear("/sign-out", new Response("{}", { status: 200 }));
      expect(ok.headers.get("clear-site-data")).toBe(h.SIGN_OUT_CLEAR_SITE_DATA);
      expect(h.withSignOutClear("/sign-out", new Response("{}", { status: 401 })).headers.get("clear-site-data")).toBeNull();
      expect(h.withSignOutClear("/get-session", new Response("{}", { status: 200 })).headers.get("clear-site-data")).toBeNull();
    });
  });
});
