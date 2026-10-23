// Round 2 (gauntlet r1 Fix List items 7, 9, 10, 13): Prometheus optional login and query errors,
// the service's own error text, units, readable paths, URL normalising, rate-limit hints, saved
// headers and bodies on custom endpoints. No network; test-only values.
import { describe, expect, it } from "vitest";
import prometheus from "../prometheus/adapter";
import prometheusManifest from "../prometheus/manifest.json";
import { createGenericAdapter } from "../declarative/runner";
import { fakeCtx, fixture } from "./fake";
import type { PackageManifest } from "@/core/contracts";
import { secretKeysFor } from "@/features/integrations/config-ui";
import { withScheme } from "@/features/integrations/address-input";
import { serviceSaid, statusError } from "@/features/integrations/host/errors";
import { isPrivateAddress } from "@/features/integrations/host/address";
import { isCredentialHeader } from "@/features/integrations/header-rules";
import { customEndpointSchema, validateManifest } from "@/features/integrations/manifest";
import { readablePath, shapeFromFields, unitFor } from "@/features/integrations/shape";

const routes = {
  "api/v1/status/buildinfo": { body: fixture("prometheus-buildinfo.json") },
  "api/v1/targets": { body: fixture("prometheus-targets.json") },
};

describe("Prometheus login (Fix List item 10)", () => {
  it("the manifest is still valid and every secret has a hint", () => {
    expect(validateManifest(prometheusManifest, { hasAdapter: true, source: "official" }).ok).toBe(true);
    for (const s of prometheusManifest.secrets) expect(s.hint.length).toBeGreaterThan(20);
  });
  it("no login by default: no secret is asked for or sent", async () => {
    const f = fakeCtx(routes, { baseUrl: "http://p:9090" });
    await prometheus.health(f.ctx);
    expect(f.calls.every((c) => c.auth === undefined)).toBe(true);
    expect([...secretKeysFor(prometheusManifest.config, {}, ["password", "token"])]).toEqual([]);
  });
  it("Basic auth sends the password secret on every read; bearer sends the token", async () => {
    const basic = fakeCtx(routes, { authMode: "basic", username: "atrium" });
    await prometheus.health(basic.ctx);
    await prometheus.read(basic.ctx, "targets", {});
    expect(basic.calls.map((c) => c.auth)).toEqual(["password", "password"]);
    expect([...secretKeysFor(prometheusManifest.config, { authMode: "basic" }, ["password", "token"])]).toEqual(["password"]);
    const bearer = fakeCtx(routes, { authMode: "bearer" });
    await prometheus.read(bearer.ctx, "targets", {});
    expect(bearer.calls.map((c) => c.auth)).toEqual(["token"]);
    expect([...secretKeysFor(prometheusManifest.config, { authMode: "bearer" }, ["password", "token"])]).toEqual(["token"]);
  });
  it("Basic auth without a username is a config problem; a 401 names the field", async () => {
    await expect(prometheus.health(fakeCtx(routes, { authMode: "basic" }).ctx)).rejects.toMatchObject({ adapterError: { code: "config" } });
    const f = fakeCtx({ "api/v1/status/buildinfo": { status: 401, body: "Unauthorized" } }, { authMode: "bearer" });
    await expect(prometheus.health(f.ctx)).rejects.toMatchObject({ adapterError: { code: "auth", message: expect.stringContaining('"Bearer token"') } });
  });
  it("a bad query says Query error with Prometheus's own text (Fix List item 9)", async () => {
    const f = fakeCtx({ "api/v1/query": { status: 400, body: JSON.stringify({ status: "error", errorType: "bad_data", error: '1:4: parse error: unexpected end of input inside braces' }) } });
    const r = await prometheus.read(f.ctx, "query", { query: "up{" });
    expect(r).toMatchObject({ ok: false, error: { code: "bad_response", message: "Query error: 1:4: parse error: unexpected end of input inside braces" } });
  });
  it("target health lists down targets first", async () => {
    const body = JSON.stringify({ status: "success", data: { activeTargets: [
      { labels: { job: "a", instance: "1" }, health: "up" },
      { labels: { job: "b", instance: "2" }, health: "down", lastError: "connection refused" },
    ] } });
    const r = await prometheus.read(fakeCtx({ "api/v1/targets": { body } }).ctx, "targets", {});
    expect(r.ok && r.data.kind === "status" && r.data.items.map((i) => i.state)).toEqual(["down", "up"]);
  });
  it("PromQL fields carry examples for the screen", () => {
    const q = prometheusManifest.endpoints.find((e) => e.id === "query")!.params!.properties.query as { examples: string[] };
    expect(q.examples).toContain("count(up)");
  });
});

describe("the service's own error text (Fix List item 9)", () => {
  it("picks error, message, detail or reason out of a JSON body, cut to 200 characters", () => {
    expect(serviceSaid(JSON.stringify({ error: true, reason: "Parameter 'latitude' and 'longitude' must have the same number of elements" }), "application/json")).toBe("Parameter 'latitude' and 'longitude' must have the same number of elements");
    expect(serviceSaid(JSON.stringify({ message: "Not Found", documentation_url: "https://docs" }))).toBe("Not Found");
    expect(serviceSaid(JSON.stringify({ errors: [{ message: "bad field" }] }))).toBe("bad field");
    expect(serviceSaid("x".repeat(300), "text/plain")).toHaveLength(200);
    expect(serviceSaid("<html>no</html>", "text/html")).toBeUndefined();
  });
  it("a 4xx hint quotes it instead of 'check the logs'", () => {
    expect(statusError(400, { said: "latitude is required" })).toMatchObject({ message: "The service answered with an error (HTTP 400).", hint: 'The service said: "latitude is required"' });
    expect(statusError(400)?.hint).not.toMatch(/logs/);
  });
  it("a saved custom endpoint shows it too", async () => {
    const a = createGenericAdapter([{ id: "x", label: "X", method: "GET", path: "/v1/forecast", fields: [{ path: "$.v", label: "v", role: "value" }], shape: "stat", refreshSec: 30 }]);
    const r = await a.read(fakeCtx({ "/v1/forecast": { status: 400, body: JSON.stringify({ error: true, reason: "Latitude must be in range of -90 to 90°." }), headers: { "content-type": "application/json" } } }).ctx, "x", {});
    expect(r).toMatchObject({ ok: false, error: { hint: 'The service said: "Latitude must be in range of -90 to 90°."' } });
  });
});

describe("saved headers and body (Fix List item 7, architecture amendment)", () => {
  it("non-secret headers are kept; credential-looking ones are refused", () => {
    const base = { id: "e", label: "E", method: "GET", path: "/x", fields: [{ path: "$.a", label: "a", role: "value" }], shape: "stat", refreshSec: 30 };
    expect(customEndpointSchema.safeParse({ ...base, headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } }).success).toBe(true);
    for (const [k, v] of [["Authorization", "Bearer x"], ["Cookie", "a=b"], ["X-API-Key", "k"], ["X-Auth-Token", "t"], ["My-Secret", "s"], ["X-Thing", "Bearer abc"]] as const) {
      expect(customEndpointSchema.safeParse({ ...base, headers: { [k]: v } }).success, k).toBe(false);
      expect(isCredentialHeader(k, v)).toBe(true);
    }
    expect(customEndpointSchema.safeParse({ ...base, body: { q: 1 } }).success).toBe(false);
    expect(customEndpointSchema.safeParse({ ...base, method: "POST", body: { q: 1 } }).success).toBe(true);
  });
  it("the generic runner sends the saved headers and the POST body", async () => {
    const seen: unknown[] = [];
    const a = createGenericAdapter([{ id: "x", label: "X", method: "POST", path: "/graphql", headers: { Accept: "application/json" }, body: { query: "{ a }" }, fields: [{ path: "$.a", label: "a", role: "value" }], shape: "stat", refreshSec: 30 }]);
    const f = fakeCtx({ "/graphql": { body: JSON.stringify({ a: 1 }) } });
    const orig = f.ctx.http.fetch.bind(f.ctx.http);
    f.ctx.http.fetch = async (req) => { seen.push(req); return orig(req); };
    expect(await a.read(f.ctx, "x", {})).toMatchObject({ ok: true, data: { value: 1 } });
    expect(seen[0]).toMatchObject({ method: "POST", headers: { Accept: "application/json" }, body: { query: "{ a }" } });
  });
});

describe("small usability fixes (Fix List item 13)", () => {
  it("a stat keeps the unit the API prints beside it", () => {
    const json = { current: { temperature_2m: 6.2 }, current_units: { temperature_2m: "°C" } };
    expect(unitFor(json, "$.current.temperature_2m")).toBe("°C");
    expect(shapeFromFields(json, "stat", [{ path: "$.current.temperature_2m", label: "temperature_2m", role: "value" }], "x")).toMatchObject({ value: 6.2, unit: "°C" });
  });
  it("paths read as words", () => {
    expect(readablePath("$.current.temperature_2m")).toBe("current > temperature_2m");
    expect(readablePath("$[*].login")).toBe("each item > login");
    expect(readablePath("$[0].login")).toBe("item 1 > login");
  });
  it("every URL field fills in http:// for a bare address", () => {
    expect(withScheme("10.77.99.7:9090")).toBe("http://10.77.99.7:9090");
    expect(withScheme("api.open-meteo.com/v1")).toBe("http://api.open-meteo.com/v1");
    expect(withScheme("https://x")).toBe("https://x");
    expect(withScheme("javascript:alert(1)")).toBe("javascript:alert(1)");
  });
  it("the private address classifier covers loopback, LAN, CGNAT, ULA and wrapped forms", () => {
    for (const ip of ["127.0.0.1", "10.77.99.7", "192.168.1.1", "172.20.0.1", "100.64.0.1", "0.0.0.0", "::1", "fd12::1", "::ffff:127.0.0.1", "64:ff9b::a00:1"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["1.1.1.1", "140.82.112.3", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe("Prometheus manifest config", () => {
  it("authMode is an enum with labels and a no-login default", () => {
    const p = (prometheusManifest as unknown as PackageManifest).config as { properties: Record<string, { enum?: string[]; default?: string }> };
    expect(p.properties.authMode).toMatchObject({ enum: ["none", "basic", "bearer"], default: "none" });
  });
});

describe("refresh default that fits a rate limit (Fix List item 13)", () => {
  it("GitHub's 60 per hour suggests every 120 seconds; no header, no hint", async () => {
    const { rateHint } = await import("@/features/integrations/try-it");
    expect(rateHint({ "x-ratelimit-limit": "60", "x-ratelimit-remaining": "59", "x-ratelimit-reset": "1792290000" })).toEqual({ limit: 60, windowSec: 3600, refreshSec: 120 });
    expect(rateHint({ "ratelimit-limit": "100", "ratelimit-policy": "100;w=60" })).toEqual({ limit: 100, windowSec: 60, refreshSec: 10 });
    expect(rateHint({})).toBeUndefined();
  });
});
