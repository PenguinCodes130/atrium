// Skeleton tests (architecture v3 sections 2 and 7): the audit writer and the app access hook.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { AppAccessResolver, Principal } from "@/core/contracts";

const dir = mkdtempSync(path.join(tmpdir(), "atrium-audit-"));
process.env.ATRIUM_DATA_DIR = dir;
process.env.ATRIUM_MASTER_KEY = randomBytes(32).toString("base64"); // test-only key
process.env.ATRIUM_PUBLIC_URL = "http://127.0.0.1:3100";
execFileSync("pnpm", ["exec", "drizzle-kit", "migrate"], { cwd: path.resolve(__dirname, "../.."), env: { ...process.env }, stdio: "ignore" });

let audit: typeof import("@/features/audit/write");
let hooks: typeof import("@/core/hooks");
let sqlite: typeof import("@/core/db").sqlite;

beforeAll(async () => {
  audit = await import("@/features/audit/write");
  hooks = await import("@/core/hooks");
  sqlite = (await import("@/core/db")).sqlite;
});

const guest: Principal = { kind: "guest", guestLinkId: "gl1", appId: "a1", label: "Guest room, Sam", via: "guest-link" };
const agent: Principal = { kind: "agent", userId: "u1", role: "member", via: "pat", tokenId: "t1", agentName: "Claude", scopes: ["atrium:edit"] };

describe("audit.write", () => {
  it("stores a guest actor with no user id and the link label", () => {
    const e = audit.write({ actor: guest, event: "control.run", result: "ok", target: { type: "control", id: "k_1", label: "Bedroom lamp" } });
    expect(e.actor).toEqual({ kind: "guest", guestLinkId: "gl1", guestLabel: "Guest room, Sam", ip: undefined });
    const row = sqlite().prepare("select * from audit_log where id = ?").get(e.id) as Record<string, unknown>;
    expect(row.actor_user_id).toBeNull();
    expect(row.actor_guest_label).toBe("Guest room, Sam");
    expect(row.event).toBe("control.run");
  });

  it("keeps the agent's token and name", () => {
    const e = audit.write({ actor: agent, event: "tool.called", result: "error", detail: { tool: "components.add" } });
    expect(e.actor.tokenId).toBe("t1");
    expect(e.actor.agentName).toBe("Claude");
  });

  it("never stores a secret-looking value", () => {
    const e = audit.write({ actor: guest, event: "guest.pin_failed", result: "error", detail: { pin: "1234", nested: { apiKey: "abc", token: "" }, entityId: "light.lamp" } });
    expect(e.detail).toEqual({ pin: "[set]", nested: { apiKey: "[set]", token: "" }, entityId: "light.lamp" });
    const raw = JSON.stringify(sqlite().prepare("select detail from audit_log where id = ?").get(e.id));
    expect(raw).not.toContain("1234");
    expect(raw).not.toContain("abc");
  });

  it("accepts an already-built actor", () => {
    const e = audit.write({ actor: { kind: "user", userId: "u9" }, event: "settings.updated", result: "ok" });
    expect(e.actor).toEqual({ kind: "user", userId: "u9" });
  });
});

describe("app access hook", () => {
  it("is unregistered until app-builder registers it", () => {
    hooks.resetAppAccess();
    expect(hooks.appAccess()).toBeUndefined();
    const fake: AppAccessResolver = {
      appBySlug: async () => null,
      appById: async () => null,
      appsFor: async () => [],
      guestValues: async () => ({}),
      canOpenApp: async () => true,
      canEditApp: async () => false,
      publishedControl: async () => null,
    };
    hooks.registerAppAccess(fake);
    expect(hooks.appAccess()).toBe(fake);
    hooks.resetAppAccess();
  });
});
