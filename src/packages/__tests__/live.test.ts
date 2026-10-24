// Check V2: live services. Run with ATRIUM_LIVE=1. A service whose token variable is not set is
// skipped, never passed. Addresses come from ATRIUM_TEST_PROM_URL, ATRIUM_TEST_NPM_URL and
// ATRIUM_TEST_PROXMOX_URL (the real ones live outside git); the defaults are placeholders. Only read requests are sent; no guessed token is ever sent anywhere.
import { describe, expect, it } from "vitest";
import type { Adapter, PackageManifest } from "@/core/contracts";
import { createHostHttp, type RequestRecord } from "@/features/integrations/host/http";
import prometheus from "../prometheus/adapter";
import prometheusManifest from "../prometheus/manifest.json";
import rss from "../rss/adapter";
import rssManifest from "../rss/manifest.json";
import npm from "../npm/adapter";
import npmManifest from "../npm/manifest.json";
import proxmox from "../proxmox/adapter";
import proxmoxManifest from "../proxmox/manifest.json";
import docker from "../docker/adapter";
import dockerManifest from "../docker/manifest.json";
import ha from "../home-assistant/adapter";
import haManifest from "../home-assistant/manifest.json";
import { safeRequest } from "@/features/integrations/host/request";

const LIVE = process.env.ATRIUM_LIVE === "1";
const PROM_URL = process.env.ATRIUM_TEST_PROM_URL ?? "http://10.77.99.7:9090";
const NPM_URL = process.env.ATRIUM_TEST_NPM_URL ?? "http://10.77.99.6:81";
const PROXMOX_URL = process.env.ATRIUM_TEST_PROXMOX_URL ?? "https://10.77.99.4:8006";
const log = { debug() {}, info() {}, warn() {}, error() {} };

function ctx(manifest: unknown, config: Record<string, unknown>, secret?: string, sent?: RequestRecord[]) {
  const http = createHostHttp({ manifest: manifest as PackageManifest, config, secrets: async () => secret ?? null, ...(sent ? { onRequest: (r) => sent.push(r) } : {}) });
  return { config, http, log, signal: new AbortController().signal, now: () => new Date() };
}

describe.skipIf(!LIVE)(`live Prometheus ${PROM_URL}`, () => {
  const sent: RequestRecord[] = [];
  const c = ctx(prometheusManifest, { baseUrl: PROM_URL }, undefined, sent);
  const p: Adapter = prometheus;
  it("health is ok with a version, within 10 seconds", async () => {
    const h = await p.health(c);
    console.log("LIVE prometheus health", JSON.stringify(h));
    expect(h.status).toBe("ok");
    expect(h.version).toMatch(/^\d+\.\d+/);
    expect(h.latencyMs).toBeLessThan(10_000);
  });
  it("target health as status", async () => {
    const r = await p.read(c, "targets", {});
    console.log("LIVE prometheus targets", r.ok && r.data.kind === "status" ? `${r.data.items.length} targets, ${r.data.items.filter((i) => i.state === "up").length} up` : JSON.stringify(r));
    expect(r.ok && r.data.kind === "status" && r.data.items.length).toBeGreaterThan(0);
  });
  it("an instant query as a stat", async () => {
    const r = await p.read(c, "query", { query: "count(up)" });
    console.log("LIVE prometheus query count(up) =", r.ok && r.data.kind === "stat" ? r.data.value : JSON.stringify(r));
    expect(r.ok && r.data.kind === "stat" && typeof r.data.value).toBe("number");
  });
  it("a range query as a series", async () => {
    const r = await p.read(c, "range", { query: "up", rangeSec: 900, stepSec: 60 });
    console.log("LIVE prometheus range up:", r.ok && r.data.kind === "series" ? `${r.data.series.length} series, ${r.data.series[0]?.points.length} points` : JSON.stringify(r));
    expect(r.ok && r.data.kind === "series" && r.data.series[0]!.points.length).toBeGreaterThan(5);
    expect(sent.every((s) => s.method === "GET")).toBe(true);
  });
});

describe.skipIf(!LIVE)("live RSS feeds", () => {
  it.each(["https://hnrss.org/frontpage", "https://www.theverge.com/rss/index.xml"])("%s gives items newest first", async (url) => {
    const r = await rss.read(ctx(rssManifest, { baseUrl: url, limit: 10 }), "items", {});
    console.log("LIVE rss", url, r.ok && r.data.kind === "table" ? `${r.data.rows.length} rows, first: ${String(r.data.rows[0]?.title).slice(0, 60)}` : JSON.stringify(r));
    expect(r.ok).toBe(true);
    if (r.ok && r.data.kind === "table") {
      expect(r.data.rows.length).toBeGreaterThan(0);
      const times = r.data.rows.map((x) => x.published as number).filter((t) => t !== null);
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    }
  });
});

describe.skipIf(!LIVE || !process.env.ATRIUM_TEST_NPM_TOKEN)("live Nginx Proxy Manager (needs ATRIUM_TEST_NPM_TOKEN)", () => {
  it("health and proxy hosts", async () => {
    const c = ctx(npmManifest, { baseUrl: NPM_URL }, process.env.ATRIUM_TEST_NPM_TOKEN);
    expect((await npm.health(c)).status).toBe("ok");
    expect((await npm.read(c, "proxy-hosts", {})).ok).toBe(true);
  });
});

describe.skipIf(!LIVE || !process.env.ATRIUM_TEST_PROXMOX_TOKEN)("live Proxmox VE (needs ATRIUM_TEST_PROXMOX_TOKEN)", () => {
  it("health and nodes", async () => {
    const c = ctx(proxmoxManifest, { baseUrl: PROXMOX_URL, verifyTls: false }, process.env.ATRIUM_TEST_PROXMOX_TOKEN);
    expect((await proxmox.health(c)).status).toBe("ok");
    expect((await proxmox.read(c, "nodes", {})).ok).toBe(true);
  });
});

// Docker: a read-only socket proxy on this VM (GET only; it answers POST with 403). Atrium itself
// also refuses anything but GET for the Docker package, so no write can be sent from here.
describe.skipIf(!LIVE)("live Docker tcp://127.0.0.1:2375 (read-only socket proxy)", () => {
  const sent: RequestRecord[] = [];
  const c = ctx(dockerManifest, { endpoint: "tcp://127.0.0.1:2375" }, undefined, sent);
  it("health is ok with the engine version", async () => {
    const h = await docker.health(c);
    console.log("LIVE docker health", JSON.stringify(h));
    expect(h.status).toBe("ok");
    expect(h.version).toMatch(/^\d+\.\d+/);
  });
  it("lists containers with name, image, state and status", async () => {
    const r = await docker.read(c, "containers", {});
    console.log("LIVE docker containers", r.ok && r.data.kind === "table" ? `${r.data.rows.length} containers: ${r.data.rows.map((x) => `${String(x.name)} (${String(x.image)}, ${String(x.state)}, ${String(x.status)})`).join("; ").slice(0, 600)}` : JSON.stringify(r));
    expect(r.ok && r.data.kind === "table").toBe(true);
    if (r.ok && r.data.kind === "table") {
      expect(r.data.columns.map((x) => x.key)).toEqual(["name", "image", "state", "status"]);
      for (const row of r.data.rows) {
        expect(typeof row.name).toBe("string");
        expect(typeof row.image).toBe("string");
        expect(typeof row.state).toBe("string");
        expect(typeof row.status).toBe("string");
      }
    }
  });
  it("running containers as a stat", async () => {
    const r = await docker.read(c, "running", {});
    console.log("LIVE docker running =", r.ok && r.data.kind === "stat" ? r.data.value : JSON.stringify(r));
    expect(r.ok && r.data.kind === "stat" && typeof r.data.value).toBe("number");
  });
  it("sent only GET requests, and a POST is refused before it leaves Atrium", async () => {
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((s) => s.method === "GET")).toBe(true);
    const before = sent.length;
    await expect(c.http.fetch({ path: "containers/create", method: "POST", body: {} })).rejects.toMatchObject({ adapterError: { code: "permission" } });
    expect(sent.length).toBe(before); // nothing was sent
  });
});
// Home Assistant (spec v2 criteria 31, 32, 34): read-only. Skipped unless BOTH variables are set.
// No command or write request is ever sent to the live instance from these tests.
const HA_URL = process.env.ATRIUM_TEST_HA_URL;
const HA_TOKEN = process.env.ATRIUM_TEST_HA_TOKEN;
describe.skipIf(!HA_URL || !HA_TOKEN)("live Home Assistant (needs ATRIUM_TEST_HA_URL and ATRIUM_TEST_HA_TOKEN)", () => {
  const sent: RequestRecord[] = [];
  const c = () => ctx(haManifest, { baseUrl: HA_URL, verifyTls: false }, HA_TOKEN, sent);
  it("GET /api/ answers 401 without a token, and /manifest.json names Home Assistant", async () => {
    const base = new URL(HA_URL!);
    const api = await safeRequest({ url: new URL("api/", base.href.endsWith("/") ? base : `${base.href}/`).toString(), redirect: { mode: "same-host" }, verifyTls: false });
    expect(api.status).toBe(401);
    const m = await safeRequest({ url: new URL("/manifest.json", base).toString(), redirect: { mode: "same-host" }, verifyTls: false });
    expect(JSON.parse(m.body.toString("utf8")).name).toBe("Home Assistant");
  });
  it("health is ok with the version", async () => {
    const h = await ha.health(c());
    console.log("LIVE home assistant health", JSON.stringify(h));
    expect(h.status).toBe("ok");
    expect(h.version).toMatch(/^\d{4}\.\d+/);
  });
  it("states filtered to lights returns entity rows, with only GET requests sent", async () => {
    const r = await ha.read(c(), "states", { domain: "light" });
    console.log("LIVE home assistant lights", r.ok && r.data.kind === "table" ? `${r.data.rows.length} lights` : JSON.stringify(r));
    expect(r.ok && r.data.kind === "table" && r.data.rows.every((x) => String(x.entity_id).startsWith("light."))).toBe(true);
    expect(sent.every((s) => s.method === "GET")).toBe(true);
  });
});
describe.skip("live Home Assistant control toggle (criterion 33, SKIPPED: needs a chosen test light and the Wave 2 control path)", () => { it("toggles a test light", () => {}); });
describe.skip("live Uptime Kuma (SKIPPED: not deployed)", () => { it("monitors", () => {}); });
describe.skip("live pfSense (SKIPPED: REST API deferred)", () => { it("gateways", () => {}); });
