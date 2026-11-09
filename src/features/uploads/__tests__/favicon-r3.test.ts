// Wave 2.10c round 3, builder S (gauntlet r2 Fix List item 12, the security note): a LAN favicon run that
// is refused for leaving the network says so in its own sentence, not the link-local or metadata one.
// Test-only addresses (.fake.lan); nothing here leaves this machine.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SafeRequest } from "@/features/integrations/host/request";
import { OWNER, freshDataDir, useInstance } from "@/features/settings/test/harness";
import { FAVICON_MESSAGES as M } from "../favicon/messages";

async function boot() {
  vi.resetModules();
  useInstance(freshDataDir());
  const m = await import("../favicon/fetch");
  const errors = await import("@/features/integrations/host/errors");
  const req = await import("@/features/integrations/host/request");
  m.resetFaviconLimits();
  return { ...m, errors, req };
}

const lanDns = async () => [{ address: "192.168.1.20" }];

describe("item 12 note: a LAN run refused for going public has its own sentence", () => {
  let m: Awaited<ReturnType<typeof boot>>;
  beforeEach(async () => {
    m = await boot();
  });

  it("maps the private-only refusal to publicFromPrivate, not to the link-local sentence", () => {
    const err = m.errors.hostError("permission", `${m.req.PRIVATE_ONLY_MESSAGE}.`, "x.fake.example is not on your network, and this read started on your network.");
    expect(m.reasonOf(err)).toBe("publicFromPrivate");
    expect(M.publicFromPrivate).not.toMatch(/link-local|metadata/);
  });

  it("a LAN page whose redirect goes public answers 403 with the leaving-the-network sentence", async () => {
    const request = async (r: SafeRequest) => {
      void r;
      throw m.errors.hostError("permission", `${m.req.PRIVATE_ONLY_MESSAGE}.`);
    };
    await expect(m.fetchFavicon(OWNER, "http://pve.fake.lan:8006/", { request, resolve: lanDns })).rejects.toMatchObject({ status: 403, code: "favicon_refused", message: M.publicFromPrivate });
  });

  it("the link-local and metadata refusal keeps its own sentence", () => {
    expect(m.reasonOf(m.errors.hostError("permission", m.errors.BLOCKED_ADDRESS_MESSAGE))).toBe("refused");
  });
});
