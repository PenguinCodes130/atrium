// The Custom API runner with settings (A9.3): placeholders filled only after the settings are
// checked, URL-encoded so a setting can never add a path segment; empty query settings not sent;
// formats put on the answer; Ticks to seconds.
import { describe, expect, it } from "vitest";
import type { AdapterContext, CustomEndpoint } from "@/core/contracts";
import { coerceParams, createCustomApiAdapter, fillPath, fillQuery, withFormats } from "../runner";

const schema = { type: "object", properties: { id: { type: "string", title: "Series" }, pageSize: { type: "integer", default: 50 }, monitored: { type: "boolean" } }, required: ["id"], additionalProperties: false };

function ctx(answer: (path: string, query?: Record<string, string>) => unknown, seen: { path: string; query?: Record<string, string> }[]): AdapterContext {
  return {
    config: {}, log: { info() {}, warn() {}, error() {}, debug() {} } as unknown as AdapterContext["log"], signal: new AbortController().signal, now: () => new Date("2026-10-20T12:00:00Z"),
    http: { async fetch(req) { seen.push({ path: req.path, ...(req.query ? { query: req.query } : {}) }); const body = answer(req.path, req.query); return { status: body === undefined ? 404 : 200, headers: { "content-type": "application/json" }, json: async () => body, text: async () => JSON.stringify(body ?? {}) }; } },
  };
}

const detail: CustomEndpoint = {
  id: "series-by-id", label: "Series details", method: "GET", path: "/api/v3/series/{{ params.id }}", query: { pageSize: "{{ params.pageSize }}", monitored: "{{ params.monitored }}" },
  fields: [{ path: "$.status", label: "Status", role: "status" }, { path: "$.title", label: "Title", role: "label" }], shape: "status", refreshSec: 60, params: schema,
};

describe("placeholders", () => {
  it("encodes each value so it stays one path segment", () => {
    expect(fillPath("/x/{{ params.id }}/y", { id: "a/../b?c" }, schema)).toBe("/x/a%2F..%2Fb%3Fc/y");
    expect(() => fillPath("/x/{{ params.id }}", {}, schema)).toThrow(/Pick series first/);
  });
  it("leaves out query entries whose setting is empty", () => {
    expect(fillQuery({ a: "{{ params.a }}", b: "{{ params.b }}", fixed: "1" }, { a: 5 })).toEqual({ a: "5", fixed: "1" });
    expect(fillQuery({ a: "{{ params.a }}" }, {})).toBeUndefined();
  });
  it("reads text settings back to their types and fills defaults", () => {
    expect(coerceParams(schema, { id: 7, pageSize: "20", monitored: "true" })).toEqual({ id: "7", pageSize: 20, monitored: true });
    expect(coerceParams(schema, { id: "1" })).toEqual({ id: "1", pageSize: 50 });
  });
});

describe("reads", () => {
  it("checks settings before sending, then shapes a single status object", async () => {
    const seen: { path: string; query?: Record<string, string> }[] = [];
    const a = createCustomApiAdapter([detail]);
    const c = ctx((p) => (p === "/api/v3/series/2" ? { title: "Severance", status: "continuing" } : undefined), seen);
    const bad = await a.read(c, "series-by-id", { id: "2", evil: "x" });
    expect(bad).toMatchObject({ ok: false, error: { code: "config" } });
    expect(seen).toHaveLength(0);
    const r = await a.read(c, "series-by-id", { id: "2" });
    expect(r).toMatchObject({ ok: true, data: { kind: "status", items: [{ label: "Severance", state: "unknown", detail: "continuing" }] } });
    expect(seen[0]).toEqual({ path: "/api/v3/series/2", query: { pageSize: "50" } });
    const missing = await a.read(c, "series-by-id", {});
    expect(missing).toMatchObject({ ok: false, error: { code: "config" } });
  });
  it("puts formats on stats and table columns; Ticks become seconds", () => {
    const e = { id: "t", label: "T", method: "GET", path: "/t", fields: [{ path: "$[*].name", label: "name", role: "column" }, { path: "$[*].sizeOnDisk", label: "sizeOnDisk", role: "value" }, { path: "$[*].RunTimeTicks", label: "RunTimeTicks", role: "value" }], shape: "table", refreshSec: 60, columnFormats: { sizeondisk: "bytes", runtimeticks: "seconds" } } satisfies CustomEndpoint;
    const out = withFormats({ kind: "table", columns: [{ key: "name", label: "name", type: "text" }, { key: "sizeondisk", label: "sizeOnDisk", type: "number" }, { key: "runtimeticks", label: "RunTimeTicks", type: "number" }], rows: [{ name: "a", sizeondisk: 1024, runtimeticks: 36_000_000_000 }] }, e);
    expect(out).toMatchObject({ columns: [{ key: "name" }, { key: "sizeondisk", format: "bytes" }, { key: "runtimeticks", format: "seconds" }], rows: [{ sizeondisk: 1024, runtimeticks: 3600 }] });
    const stat = withFormats({ kind: "stat", value: 5, label: "x" }, { ...e, shape: "stat", format: "bytes", fields: [{ path: "$.free", label: "free", role: "value" }] });
    expect(stat).toMatchObject({ format: "bytes", value: 5 });
  });
  it("health uses the first read that needs no settings", async () => {
    const seen: { path: string }[] = [];
    const list: CustomEndpoint = { id: "series", label: "Series", method: "GET", path: "/api/v3/series", fields: [{ path: "$[*].title", label: "title", role: "column" }], shape: "table", refreshSec: 60 };
    const a = createCustomApiAdapter([detail, list]);
    await a.health(ctx(() => [{ title: "x" }], seen));
    expect(seen.map((s) => s.path)).toEqual(["/api/v3/series"]);
  });
});
