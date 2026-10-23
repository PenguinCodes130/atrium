import { describe, expect, it, vi } from "vitest";
import { Client, freshDataDir, setEnv } from "./test/harness";
import { MESSAGES, messageFor } from "./ui/messages";
import { stepUpReason } from "./ui/step-up";

// Round 4 (gauntlet r2 fix list): sign-in messages for empty fields, and the step-up reason.

const OWNER = { email: "owner@atrium.test", password: "unit-owner-password-123" };

vi.setConfig({ testTimeout: 30_000 });

async function boot() {
  setEnv({ ATRIUM_DATA_DIR: freshDataDir(), ATRIUM_OWNER_EMAIL: OWNER.email, ATRIUM_OWNER_PASSWORD: OWNER.password });
  vi.resetModules();
  const handler = await import("./server/handler");
  await (await import("./server/bootstrap")).ensureBootstrapped();
  return new Client(handler.handleAuthRequest);
}

describe("fix 2: empty sign-in fields", () => {
  it("an empty email is answered 'Enter your email.' (400 missing_email), never the allowlist message", async () => {
    const c = await boot();
    for (const email of ["", "   "]) {
      const res = await c.post("/api/auth/sign-in/email", { email, password: "" });
      expect(res.status).toBe(400);
      const body = (await res.clone().json()) as { error: { code: string; message: string } };
      expect(body.error).toMatchObject({ code: "missing_email", message: "Enter your email." });
      expect(await messageFor(res, "password")).toBe(MESSAGES.enterEmail);
      expect(res.headers.get("set-cookie") ?? "").not.toMatch(/atrium\.session/);
    }
  });

  it("an email that is not allowed is still refused with the allowlist message", async () => {
    const c = await boot();
    const res = await c.post("/api/auth/sign-in/email", { email: "stranger@elsewhere.test", password: "whatever-password-1" });
    expect(res.status).toBe(403);
    expect(await messageFor(res, "password")).toBe(MESSAGES.notAllowlisted);
  });

  it("the form's own messages name the field", () => {
    expect(MESSAGES.enterEmail).toBe("Enter your email.");
    expect(MESSAGES.enterPassword).toBe("Enter your password.");
  });
});

describe("fix 4: the step-up sheet says why it opened", () => {
  it("shows a refusal message that names the action, not the generic one", () => {
    expect(stepUpReason("Confirm it is you to allow this credential on another server.")).toBe("Confirm it is you to allow this credential on another server.");
    expect(stepUpReason("Confirm it is you to continue.")).toBeNull();
    expect(stepUpReason("")).toBeNull();
    expect(stepUpReason(undefined)).toBeNull();
  });
});
