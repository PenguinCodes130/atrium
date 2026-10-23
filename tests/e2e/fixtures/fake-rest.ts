// A stand-in REST service for spec import v2 (Wave 2.8, recipes spec 3.3, criterion 11): "Shelfarr",
// a small media manager shaped like Sonarr. It serves its OpenAPI 3.0 spec as JSON at
// /openapi.json, the same spec as YAML at /openapi.yaml and /docs/spec.yaml, and answers the GET
// reads the spec lists. The API key goes in the X-Api-Key header; without it every API call answers
// 401. /api/v1/tag answers 404 although the spec lists it (a spec that lies), so the live check has
// a read to mark failed. Changes (POST, PUT, DELETE) answer 405 and are counted, so a test can prove
// none was sent. Test-only key; not a credential.
//
//   const rest = await startFakeRest();   // or startFakeRest(9392)
//   ... import rest.url + "/openapi.json" in the Custom API screen ...
//   rest.writes  // changes received (must stay 0)
//   await rest.close();
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export const FAKE_REST_KEY = "atrium-v10-FAKE-shelfarr-key-7e1d2c";

const date = (s: string) => ({ type: "string", format: "date-time", description: s });
const id = { type: "integer", format: "int32" };

const SeriesResource = {
  type: "object",
  properties: { id, title: { type: "string" }, status: { type: "string", enum: ["continuing", "ended"] }, sizeOnDisk: { type: "integer", format: "int64" }, added: date("When it was added"), monitored: { type: "boolean" } },
};
const QueueResource = {
  type: "object",
  properties: { id, title: { type: "string" }, status: { type: "string" }, size: { type: "number" }, sizeleft: { type: "number" }, added: date("When it was queued") },
};
const paged = (ref: string) => ({
  type: "object",
  properties: { page: { type: "integer" }, pageSize: { type: "integer" }, totalRecords: { type: "integer" }, records: { type: "array", items: { $ref: ref } } },
});
const ok = (schema: unknown) => ({ "200": { description: "OK", content: { "application/json": { schema } } } });
const pageParams = [
  { name: "page", in: "query", schema: { type: "integer", default: 1 } },
  { name: "pageSize", in: "query", schema: { type: "integer", default: 10 } },
];

/** The spec as a plain object (OpenAPI 3.0.3). */
export const FAKE_REST_SPEC = {
  openapi: "3.0.3",
  info: { title: "Shelfarr", version: "2.1.0", description: "A stand-in media manager for Atrium's spec import tests." },
  servers: [{ url: "{protocol}://{hostpath}", variables: { protocol: { default: "http" }, hostpath: { default: "localhost:8990" } } }],
  security: [{ ApiKey: [] }],
  components: {
    securitySchemes: { ApiKey: { type: "apiKey", in: "header", name: "X-Api-Key", description: "The API key from Settings > General" } },
    schemas: { SeriesResource, QueueResource, QueuePage: paged("#/components/schemas/QueueResource"), SeriesPage: paged("#/components/schemas/SeriesResource") },
  },
  paths: {
    "/api/v1/system/status": { get: { tags: ["System"], responses: ok({ type: "object", properties: { appName: { type: "string" }, version: { type: "string" }, status: { type: "string" }, startTime: date("When it started"), uptimeSeconds: { type: "integer" } } }) } },
    "/api/v1/health": { get: { tags: ["Health"], responses: ok({ type: "array", items: { type: "object", properties: { source: { type: "string" }, type: { type: "string" }, message: { type: "string" } } } }) } },
    "/api/v1/diskspace": { get: { tags: ["DiskSpace"], responses: ok({ type: "array", items: { type: "object", properties: { path: { type: "string" }, label: { type: "string" }, freeSpace: { type: "integer", format: "int64" }, totalSpace: { type: "integer", format: "int64" } } } }) } },
    "/api/v1/queue": { get: { tags: ["Queue"], parameters: pageParams, responses: ok({ $ref: "#/components/schemas/QueuePage" }) } },
    "/api/v1/wanted/missing": { get: { tags: ["Missing"], parameters: pageParams, responses: ok({ $ref: "#/components/schemas/SeriesPage" }) } },
    "/api/v1/series": {
      get: { tags: ["Series"], responses: ok({ type: "array", items: { $ref: "#/components/schemas/SeriesResource" } }) },
      post: { tags: ["Series"], requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/SeriesResource" } } } }, responses: ok({ $ref: "#/components/schemas/SeriesResource" }) },
    },
    "/api/v1/series/{id}": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
      get: { tags: ["Series"], responses: ok({ $ref: "#/components/schemas/SeriesResource" }) },
      put: { tags: ["Series"], requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/SeriesResource" } } } }, responses: ok({ $ref: "#/components/schemas/SeriesResource" }) },
      delete: { tags: ["Series"], responses: { "200": { description: "OK" } } },
    },
    "/api/v1/calendar": { get: { tags: ["Calendar"], parameters: [{ name: "start", in: "query", schema: { type: "string", format: "date-time" } }, { name: "end", in: "query", schema: { type: "string", format: "date-time" } }], responses: ok({ type: "array", items: { type: "object", properties: { id, title: { type: "string" }, airDateUtc: date("When it airs") } } }) } },
    "/api/v1/tag": { get: { tags: ["Tag"], responses: ok({ type: "array", items: { type: "object", properties: { id, label: { type: "string" } } } }) } },
    "/api/v1/command": { post: { tags: ["Command"], summary: "Run a task", requestBody: { content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string", enum: ["RefreshSeries", "RssSync"] } } } } } }, responses: ok({ type: "object", properties: { id } }) } },
    "/api/v1/config/host": { get: { tags: ["HostConfig"], responses: ok({ type: "object", properties: { port: { type: "integer" } } }) } },
    "/api/v1/mediacover/{seriesId}/{filename}": { get: { tags: ["MediaCover"], parameters: [{ name: "seriesId", in: "path", required: true, schema: { type: "integer" } }, { name: "filename", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "OK", content: { "image/jpeg": {} } } } } },
    "/login": { get: { tags: ["Authentication"], responses: { "200": { description: "OK", content: { "text/html": {} } } } } },
  },
} as const;

/** A tiny YAML writer for plain JSON values (block style, every scalar quoted as JSON, which YAML reads as a double-quoted string). */
export function toYaml(v: unknown, indent = 0): string {
  const pad = " ".repeat(indent);
  const scalar = (x: unknown) => (typeof x === "string" ? JSON.stringify(x) : x === null ? "null" : String(x));
  if (Array.isArray(v)) {
    if (!v.length) return `${pad}[]\n`;
    return v.map((x) => (x && typeof x === "object" && !(Array.isArray(x) && !x.length) && Object.keys(x).length ? `${pad}-\n${toYaml(x, indent + 2)}` : `${pad}- ${x && typeof x === "object" ? (Array.isArray(x) ? "[]" : "{}") : scalar(x)}\n`)).join("");
  }
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (!entries.length) return `${pad}{}\n`;
    return entries.map(([k, x]) => (x && typeof x === "object" && Object.keys(x).length ? `${pad}${JSON.stringify(k)}:\n${toYaml(x, indent + 2)}` : `${pad}${JSON.stringify(k)}: ${x && typeof x === "object" ? (Array.isArray(x) ? "[]" : "{}") : scalar(x)}\n`)).join("");
  }
  return `${pad}${scalar(v)}\n`;
}

const SERIES = [
  { id: 1, title: "The Expanse", status: "ended", sizeOnDisk: 412_316_860_416, added: "2024-03-01T10:00:00Z", monitored: true },
  { id: 2, title: "Severance", status: "continuing", sizeOnDisk: 96_636_764_160, added: "2025-01-17T08:30:00Z", monitored: true },
  { id: 3, title: "Andor", status: "ended", sizeOnDisk: 128_849_018_880, added: "2025-05-02T19:45:00Z", monitored: false },
];
const QUEUE = [
  { id: 11, title: "Severance S02E10", status: "downloading", size: 4_294_967_296, sizeleft: 1_073_741_824, added: "2026-10-20T07:00:00Z" },
  { id: 12, title: "Andor S02E12", status: "queued", size: 3_221_225_472, sizeleft: 3_221_225_472, added: "2026-10-20T07:05:00Z" },
];

export type FakeRest = { url: string; port: number; writes: number; hits: { method: string; path: string; key: boolean }[]; close: () => Promise<void> };

export async function startFakeRest(port = 0): Promise<FakeRest> {
  const state: FakeRest = { url: "", port: 0, writes: 0, hits: [], close: async () => {} };
  const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? "/", "http://x");
    const key = req.headers["x-api-key"] === FAKE_REST_KEY;
    state.hits.push({ method: req.method ?? "", path: u.pathname, key });
    if (req.method !== "GET") { state.writes++; return json(res, 405, { message: "Shelfarr stand-in: read only" }); }
    if (u.pathname === "/openapi.json") return json(res, 200, FAKE_REST_SPEC);
    if (u.pathname === "/openapi.yaml" || u.pathname === "/docs/spec.yaml") { res.writeHead(200, { "content-type": "application/yaml" }); return res.end(toYaml(FAKE_REST_SPEC)); }
    if (u.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html><title>Shelfarr</title></html>"); }
    if (!u.pathname.startsWith("/api/")) return json(res, 404, { message: "Not found" });
    if (!key) return json(res, 401, { message: "Unauthorized" });
    const page = (rows: unknown[]) => {
      const size = Math.max(1, Number(u.searchParams.get("pageSize") ?? 10));
      const p = Math.max(1, Number(u.searchParams.get("page") ?? 1));
      return { page: p, pageSize: size, totalRecords: rows.length, records: rows.slice((p - 1) * size, p * size) };
    };
    const m = /^\/api\/v1\/series\/([^/]+)$/.exec(u.pathname);
    if (m) {
      const s = SERIES.find((x) => String(x.id) === decodeURIComponent(m[1]!));
      return s ? json(res, 200, s) : json(res, 404, { message: "Series not found" });
    }
    switch (u.pathname) {
      case "/api/v1/system/status": return json(res, 200, { appName: "Shelfarr", version: "2.1.0", status: "ok", startTime: "2026-10-19T07:00:00Z", uptimeSeconds: 86_400 });
      case "/api/v1/health": return json(res, 200, [{ source: "IndexerCheck", type: "warning", message: "One indexer is slow" }]);
      case "/api/v1/diskspace": return json(res, 200, [{ path: "/tv", label: "TV", freeSpace: 1_099_511_627_776, totalSpace: 4_398_046_511_104 }, { path: "/", label: "System", freeSpace: 53_687_091_200, totalSpace: 107_374_182_400 }]);
      case "/api/v1/queue": return json(res, 200, page(QUEUE));
      case "/api/v1/wanted/missing": return json(res, 200, page(SERIES.slice(1)));
      case "/api/v1/series": return json(res, 200, SERIES);
      case "/api/v1/calendar": return json(res, 200, [{ id: 21, title: "Severance S03E01", airDateUtc: "2026-11-01T02:00:00Z" }]);
      case "/api/v1/config/host": return json(res, 200, { port: 8990 });
      default: return json(res, 404, { message: "Not found" });
    }
  };
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  state.port = (server.address() as { port: number }).port;
  state.url = `http://127.0.0.1:${state.port}`;
  state.close = () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); });
  return state;
}
