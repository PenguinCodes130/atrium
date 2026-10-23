import { describe, expect, it } from "vitest";
import type { PackageProblem } from "@/core/contracts";
import { validateManifest } from "../manifest";
import { OFFICIAL_PACKAGES } from "../official";
import { buildRegistry, galleryOrder, type ProblemSink } from "../registry";

const good = () => ({
  atriumApi: "1", kind: "code", id: "demo", name: "Demo", version: "1.2.3", author: "me", description: "d", icon: "icon.svg",
  permissions: [{ kind: "network", hosts: "configured" }, { kind: "secret", key: "token" }],
  config: {}, secrets: [{ key: "token", label: "Token", hint: "From settings", auth: { as: "bearer" } }],
  endpoints: [{ id: "e", label: "E", description: "d", shape: "stat", defaultRefreshSec: 30, minRefreshSec: 10 }],
});
const opts = { hasAdapter: true, source: "official" as const };

describe("manifest validation", () => {
  it("accepts a valid code manifest", () => expect(validateManifest(good(), opts)).toMatchObject({ ok: true }));
  it("rejects an Atrium API version other than 1", () => {
    expect(validateManifest({ ...good(), atriumApi: "2" }, opts)).toEqual({ ok: false, reason: 'atriumApi must be "1" (at atriumApi)' });
  });
  it("rejects a kind other than code or declarative", () => {
    expect(validateManifest({ ...good(), kind: "plugin" }, opts)).toMatchObject({ ok: false, reason: expect.stringContaining('kind must be "code" or "declarative"') });
  });
  it("rejects a declarative manifest that ships adapter code", () => {
    expect(validateManifest({ ...good(), id: "local/demo", kind: "declarative" }, { hasAdapter: true, source: "declarative" })).toMatchObject({ ok: false, reason: expect.stringContaining("must not ship adapter code") });
  });
  it("rejects a code manifest without adapter code", () => {
    expect(validateManifest(good(), { hasAdapter: false, source: "official" })).toMatchObject({ ok: false, reason: expect.stringContaining("must ship adapter code") });
  });
  it("rejects a default refresh below the minimum", () => {
    const m = good();
    m.endpoints[0]!.defaultRefreshSec = 5;
    expect(validateManifest(m, opts)).toMatchObject({ ok: false, reason: expect.stringContaining("default refresh below its minimum") });
  });
  it("rejects a secret permission naming an undeclared key", () => {
    const m = good();
    m.permissions.push({ kind: "secret", key: "password" });
    expect(validateManifest(m, opts)).toMatchObject({ ok: false, reason: expect.stringContaining('undeclared key "password"') });
  });
  it.each([
    ["missing name", (m: ReturnType<typeof good>) => ({ ...m, name: "" })],
    ["bad semver", (m: ReturnType<typeof good>) => ({ ...m, version: "1.0" })],
    ["missing icon", (m: ReturnType<typeof good>) => ({ ...m, icon: undefined })],
    ["secret without hint", (m: ReturnType<typeof good>) => ({ ...m, secrets: [{ ...m.secrets[0]!, hint: "" }] })],
    ["bad auth placement", (m: ReturnType<typeof good>) => ({ ...m, secrets: [{ ...m.secrets[0]!, auth: { as: "cookie" } }] })],
    ["bad shape", (m: ReturnType<typeof good>) => ({ ...m, endpoints: [{ ...m.endpoints[0]!, shape: "pie" }] })],
    ["community id form", (m: ReturnType<typeof good>) => ({ ...m, id: "just-a-name" })],
  ])("rejects %s", (_n, f) => {
    const source = _n === "community id form" ? "community" : "official";
    expect(validateManifest(f(good()), { hasAdapter: true, source })).toMatchObject({ ok: false });
  });
  it("rejects a declarative endpoint record with a refresh below 10 seconds", () => {
    const m = { ...good(), id: "local/demo", kind: "declarative", endpoints: [{ id: "e", label: "E", description: "d", shape: "stat", defaultRefreshSec: 10, minRefreshSec: 10 }] };
    const eps = [{ id: "e", label: "E", method: "GET", path: "/x", fields: [{ path: "$.v", label: "v", role: "value" }], shape: "stat", refreshSec: 5 }];
    expect(validateManifest(m, { hasAdapter: false, source: "declarative", declarativeEndpoints: eps })).toMatchObject({ ok: false, reason: expect.stringContaining("at least 10 seconds") });
    eps[0]!.refreshSec = 10;
    expect(validateManifest(m, { hasAdapter: false, source: "declarative", declarativeEndpoints: eps })).toMatchObject({ ok: true });
  });
  it("every official manifest is valid and every secret field has a non-empty hint", () => {
    for (const p of OFFICIAL_PACKAGES) {
      const v = validateManifest(p.manifest, opts);
      expect(v, JSON.stringify(v)).toMatchObject({ ok: true });
      if (v.ok) for (const s of v.manifest.secrets) expect(s.hint.trim().length).toBeGreaterThan(10);
    }
  });
});

function memorySink() {
  const rows = new Map<string, { alerted: boolean; resolved: boolean }>();
  const id = (p: PackageProblem) => `${p.source}|${p.packageId}|${p.reason}`;
  const sink: ProblemSink = {
    record(p) {
      const r = rows.get(id(p));
      if (r && !r.resolved) return false;
      rows.set(id(p), { alerted: true, resolved: false });
      return true;
    },
    resolveOthers(seen) {
      const keep = new Set(seen.map(id));
      for (const [k, v] of rows) if (!keep.has(k)) v.resolved = true;
    },
  };
  return sink;
}

describe("registry", () => {
  const broken = { manifest: { ...good(), id: "broken", atriumApi: "9" }, adapter: OFFICIAL_PACKAGES[0]!.adapter };

  it("lists exactly the eight official packages, Home Assistant included, plus Custom API last (spec v2 criterion 16)", () => {
    const r = buildRegistry(OFFICIAL_PACKAGES, [], memorySink(), () => {});
    expect(galleryOrder(r).map((p) => p.manifest.id)).toEqual(["prometheus", "npm", "pfsense", "rss", "proxmox", "docker", "uptime-kuma", "home-assistant", "custom-api"]);
    expect(r.problems).toEqual([]);
  });

  it("skips a failing package, lists it with id, source, reason and time, and still loads the others", () => {
    const r = buildRegistry([...OFFICIAL_PACKAGES.slice(0, 7), broken, OFFICIAL_PACKAGES[7]!], [{ id: "local/bad", manifest: { ...good(), id: "local/bad", kind: "declarative" }, endpoints: [], status: "active" }], memorySink(), () => {});
    expect(galleryOrder(r)).toHaveLength(8);
    expect(r.problems).toEqual([
      { packageId: "broken", source: "official", reason: 'atriumApi must be "1" (at atriumApi)', at: expect.any(String) },
      { packageId: "local/bad", source: "declarative", reason: 'endpoint "e" has no record in endpoints.json', at: expect.any(String) },
    ]);
    expect(Number.isNaN(Date.parse(r.problems[0]!.at))).toBe(false);
  });

  it("sends exactly one warning per problem, and none on a later restart with the same problem", () => {
    const sink = memorySink();
    const alerts: string[] = [];
    buildRegistry([...OFFICIAL_PACKAGES, broken], [], sink, (p) => alerts.push(p.packageId));
    buildRegistry([...OFFICIAL_PACKAGES, broken], [], sink, (p) => alerts.push(p.packageId));
    buildRegistry([...OFFICIAL_PACKAGES, broken], [], sink, (p) => alerts.push(p.packageId));
    expect(alerts).toEqual(["broken"]);
  });

  it("refuses a duplicate package id", () => {
    const r = buildRegistry([...OFFICIAL_PACKAGES, OFFICIAL_PACKAGES[0]!], [], memorySink(), () => {});
    expect(r.problems[0]).toMatchObject({ packageId: "prometheus", reason: expect.stringContaining("already taken") });
  });
});
