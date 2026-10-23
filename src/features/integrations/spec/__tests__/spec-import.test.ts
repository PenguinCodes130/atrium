// Spec import v2 (recipes spec 3.3, criteria 8, 9, 10, 12): ranking, pairing, units, shapes, auth,
// YAML equals JSON, on the Sonarr v3, Immich and Jellyfin specs saved in the research folder (copied
// here, minified) and the Shelfarr stand-in. Pure: no network.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateRecipe } from "@/features/recipes/schema";
import { customEndpointSchema } from "@/features/integrations/manifest";
import { FAKE_REST_SPEC, toYaml } from "../../../../../tests/e2e/fixtures/fake-rest";
import { basePathOf, importSpec, toEndpoint, type SpecImport, type SpecRead } from "../import";
import { parseSpecText, SpecError } from "../load";
import { specRecipe, specRecipeId } from "../recipe";
import { formatFor, isTimeProp, labelFor } from "../words";
import { safeLoaderFrom, setYamlLoader } from "../yaml";

const FIX = path.join(__dirname, "fixtures");
const load = (name: string) => parseSpecText(readFileSync(path.join(FIX, name), "utf8"));
const specs = { sonarr: load("sonarr.json"), immich: load("immich.json"), jellyfin: load("jellyfin.json") };
const imports = Object.fromEntries(Object.entries(specs).map(([k, d]) => [k, importSpec(d)])) as Record<keyof typeof specs, SpecImport>;

/** js-yaml as eslint's own copy carries it (the app has no direct YAML dependency yet). */
function jsYaml() {
  const req = createRequire(path.join(process.cwd(), "package.json"));
  try { return req("js-yaml"); } catch {
    const eslintrc = path.dirname(req.resolve("@eslint/eslintrc/package.json", { paths: [path.join(process.cwd(), "node_modules/eslint")] }));
    return createRequire(path.join(eslintrc, "package.json"))("js-yaml");
  }
}

const choices = (r: SpecRead | undefined) => Object.values(((r?.params as { properties?: Record<string, Record<string, unknown>> } | undefined)?.properties ?? {})).map((p) => p["x-atrium-choices"]).filter(Boolean) as { endpointId: string; value: string; label: string }[];
const byPath = (imp: SpecImport, p: string) => imp.reads.find((r) => r.source.path === p);

function getsOf(doc: Record<string, unknown>): string[] {
  return Object.entries(doc.paths as Record<string, Record<string, unknown>>).filter(([, item]) => item.get).map(([p]) => p);
}

afterEach(() => setYamlLoader(undefined));

describe("every operation is considered (criterion 8)", () => {
  it.each(Object.keys(specs) as (keyof typeof specs)[])("%s: each GET is a read or listed as left out with a reason, never cut off", (name) => {
    const imp = imports[name];
    const gets = getsOf(specs[name]);
    const covered = new Set([...imp.reads.map((r) => r.source.path), ...imp.skipped.filter((s) => s.method === "GET").map((s) => s.path)]);
    expect(gets.every((p) => covered.has(p))).toBe(true);
    expect(imp.totals.gets).toBe(gets.length);
    for (const s of imp.skipped) expect(s.reason.length).toBeGreaterThan(5);
  });
  it("keeps far more than the old 200-row cut on Jellyfin and keeps /Sessions and /System/Info", () => {
    const j = imports.jellyfin;
    expect(j.totals.operations).toBeGreaterThan(300);
    expect(j.reads.length).toBeGreaterThan(100);
    expect(byPath(j, "/Sessions")).toBeDefined();
    expect(byPath(j, "/System/Info")).toBeDefined();
    expect(byPath(j, "/Sessions")!.headline).toBe(true);
    expect(byPath(j, "/System/Info")!.headline).toBe(true);
  });
  it("drops noise: login, config, schema, backup, images, files and streams", () => {
    const s = imports.sonarr;
    for (const p of ["/login", "/api/v3/config/host", "/api/v3/autotagging/schema", "/api/v3/system/backup", "/api/v3/mediacover/{seriesId}/{filename}", "/api/v3/log/file", "/api/v3/filesystem"]) {
      expect(byPath(s, p), p).toBeUndefined();
      expect(s.skipped.some((x) => x.path === p), p).toBe(true);
    }
    expect(imports.jellyfin.reads.some((r) => /\/Images|\/Audio\/|\/Videos\//.test(r.source.path))).toBe(false);
  });
});

describe("headline reads first (criterion 8)", () => {
  it.each(Object.keys(specs) as (keyof typeof specs)[])("%s: every headline read comes before every advanced read", (name) => {
    const reads = imports[name].reads;
    const lastHeadline = reads.map((r) => r.headline).lastIndexOf(true);
    const firstAdvanced = reads.findIndex((r) => !r.headline);
    expect(lastHeadline).toBeGreaterThanOrEqual(0);
    expect(lastHeadline).toBeLessThan(firstAdvanced);
    for (const r of reads) expect(!!r.advanced).toBe(!r.headline);
  });
  it("Sonarr's headline reads are the dashboard ones (status, health, queue, missing, calendar, disk space)", () => {
    const head = imports.sonarr.reads.filter((r) => r.headline).map((r) => r.source.path);
    for (const p of ["/api/v3/system/status", "/api/v3/health", "/api/v3/queue", "/api/v3/wanted/missing", "/api/v3/calendar", "/api/v3/diskspace", "/api/v3/queue/status"]) expect(head, p).toContain(p);
    expect(head).not.toContain("/api/v3/series/lookup");
    expect(imports.sonarr.reads.filter((r) => r.headline).length).toBeLessThan(30);
  });
  it("a count read is headline only when the list it counts is", () => {
    const j = imports.jellyfin;
    expect(j.reads.filter((r) => r.headline && / count$/.test(r.label)).every((r) => byPath(j, r.source.path)!.headline)).toBe(true);
    expect(j.reads.filter((r) => r.headline).length).toBeLessThan(40);
  });
  it("labels are plain words: summary first, else path words (Sonarr has no summaries)", () => {
    expect(byPath(imports.sonarr, "/api/v3/wanted/missing")!.label).toBe("Wanted missing");
    expect(byPath(imports.sonarr, "/api/v3/system/status")!.label).toBe("System status");
    expect(byPath(imports.sonarr, "/api/v3/diskspace")!.label).toBe("Disk space");
    expect(byPath(imports.jellyfin, "/Sessions")!.label).toBe("Sessions");
    expect(labelFor({ summary: "Gets a list of sessions." }, "/Sessions")).toBe("Sessions");
    expect(labelFor({ operationId: "getServerStatistics" }, "/x")).toBe("Server statistics");
    const labels = imports.jellyfin.reads.map((r) => r.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(imports.sonarr.reads.every((r) => !/^GET /.test(r.label))).toBe(true);
  });
  it("groups come from tags, with one-read tags merged into Other", () => {
    const s = imports.sonarr;
    const counts = new Map<string, number>();
    for (const r of s.reads) counts.set(r.group!, (counts.get(r.group!) ?? 0) + 1);
    for (const [g, n] of counts) if (g !== "Other") expect(n, g).toBeGreaterThan(1);
    expect(byPath(s, "/api/v3/wanted/missing")!.group).toBe("Missing");
  });
});

describe("pick which thing: list and detail pairs (criterion 8)", () => {
  it("Sonarr detail calls get dropdowns from their list call", () => {
    const s = imports.sonarr;
    const detail = byPath(s, "/api/v3/series/{id}");
    expect(choices(detail)).toEqual([{ endpointId: byPath(s, "/api/v3/series")!.id, value: "id", label: "title" }]);
    expect(choices(byPath(s, "/api/v3/wanted/missing/{id}"))[0]!.endpointId).toBe(byPath(s, "/api/v3/wanted/missing")!.id);
    // A <thing>Id query setting pairs with the list of things.
    expect(choices(byPath(s, "/api/v3/episode")).some((c) => c.endpointId === byPath(s, "/api/v3/series")!.id)).toBe(true);
    expect(s.reads.filter((r) => r.pairedWith).length).toBeGreaterThanOrEqual(25);
  });
  it("the list read's table carries the value and label columns the dropdown names", () => {
    for (const imp of Object.values(imports)) {
      for (const r of imp.reads) {
        for (const c of choices(r)) {
          const list = imp.reads.find((x) => x.id === c.endpointId)!;
          expect(list.shape).toBe("table");
          const keys = list.fields.map((f, i) => f.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || `f${i}`);
          expect(keys, `${r.id} -> ${list.id}`).toContain(c.value);
          expect(keys, `${r.id} -> ${list.id}`).toContain(c.label);
        }
      }
    }
  });
  it("Immich and Jellyfin pair too; unpaired path settings stay text boxes with the spec's help", () => {
    expect(imports.immich.reads.filter((r) => r.pairedWith).length).toBeGreaterThanOrEqual(10);
    expect(imports.jellyfin.reads.filter((r) => r.pairedWith).length).toBeGreaterThanOrEqual(20);
    expect(choices(byPath(imports.immich, "/people/{id}/statistics"))[0]).toMatchObject({ endpointId: byPath(imports.immich, "/people")!.id, value: "id", label: "name" });
    const unpaired = imports.jellyfin.reads.flatMap((r) => Object.entries(((r.params as { properties?: Record<string, Record<string, unknown>> } | undefined)?.properties ?? {}))).filter(([, p]) => !p["x-atrium-choices"] && p.description);
    expect(unpaired.length).toBeGreaterThan(0);
  });
  it("path settings are placeholders, query settings are settings, page sizes default to 50", () => {
    const missing = byPath(imports.sonarr, "/api/v3/wanted/missing")!;
    expect(missing.query).toMatchObject({ page: "{{ params.page }}", pageSize: "{{ params.pageSize }}" });
    expect((missing.params as { properties: Record<string, { default?: unknown }> }).properties.pageSize!.default).toBe(50);
    expect(byPath(imports.sonarr, "/api/v3/series/{id}")!.path).toBe("/api/v3/series/{{ params.id }}");
    expect(byPath(imports.immich, "/server/version")!.path).toBe("/api/server/version");
  });
});

describe("shapes, units and formats (criterion 12)", () => {
  it("lists become tables, paged wrappers a count plus rows, status objects status", () => {
    const s = imports.sonarr;
    const missing = s.reads.filter((r) => r.source.path === "/api/v3/wanted/missing");
    expect(missing.map((r) => r.shape).sort()).toEqual(["stat", "table"]);
    expect(missing.find((r) => r.shape === "stat")!.fields[0]!.path).toBe("$.totalRecords");
    expect(missing.find((r) => r.shape === "table")!.fields[0]!.path).toMatch(/^\$\.records\[\*\]\./);
    expect(byPath(s, "/api/v3/series")!.shape).toBe("table");
    expect(byPath(s, "/api/v3/series")!.fields.length).toBeLessThanOrEqual(7);
    expect(byPath(s, "/api/v3/series")!.fields[0]!.label).toBe("title");
  });
  it("names and schema give formats: bytes, time, percent, seconds (Ticks), never pageSize", () => {
    expect(formatFor("sizeOnDisk", { type: "integer" })).toBe("bytes");
    expect(formatFor("sizeleft", { type: "number" })).toBe("bytes");
    expect(formatFor("freeSpace", { type: "integer" })).toBe("bytes");
    expect(formatFor("totalBytes", { type: "integer" })).toBe("bytes");
    expect(formatFor("pageSize", { type: "integer" })).toBeUndefined();
    expect(formatFor("percentComplete", { type: "number" })).toBe("percent");
    expect(formatFor("RunTimeTicks", { type: "integer" })).toBe("seconds");
    expect(formatFor("uptimeSeconds", { type: "integer" })).toBe("seconds");
    expect(formatFor("title", { type: "string" })).toBeUndefined();
    expect(isTimeProp("added", { type: "string", format: "date-time" })).toBe(true);
    const shelf = importSpec(FAKE_REST_SPEC as unknown as Record<string, unknown>);
    const series = byPath(shelf, "/api/v1/series")!;
    expect(series.fields.find((f) => f.label === "sizeOnDisk")!.role).toBe("value");
    expect(series.columnFormats).toMatchObject({ sizeondisk: "bytes" });
    expect(series.fields.find((f) => f.label === "added")!.role).toBe("time");
    expect(byPath(shelf, "/api/v1/diskspace")!.columnFormats).toMatchObject({ freespace: "bytes", totalspace: "bytes" });
  });
  it("Sonarr's disk space and Immich's statistics carry byte formats", () => {
    expect(Object.values(byPath(imports.sonarr, "/api/v3/diskspace")!.columnFormats ?? {})).toContain("bytes");
  });
});

describe("only GET becomes a read (criterion 10)", () => {
  it.each(Object.keys(specs) as (keyof typeof specs)[])("%s: reads are GET; every other method is a hidden command candidate", (name) => {
    const imp = imports[name];
    expect(imp.reads.every((r) => r.method === "GET")).toBe(true);
    const doc = specs[name];
    const changes = Object.values(doc.paths as Record<string, Record<string, unknown>>).reduce((n, item) => n + ["post", "put", "patch", "delete"].filter((m) => item[m]).length, 0);
    expect(imp.commands.length).toBe(changes);
    for (const c of imp.commands) expect(["POST", "PUT", "PATCH", "DELETE"]).toContain(c.method);
  });
  it("a command with a setting in its address cannot be added automatically and says why", () => {
    const shelf = importSpec(FAKE_REST_SPEC as unknown as Record<string, unknown>);
    expect(shelf.commands.find((c) => c.method === "DELETE")).toMatchObject({ canAdd: false });
    const run = shelf.commands.find((c) => c.path === "/api/v1/command")!;
    expect(run).toMatchObject({ canAdd: true, method: "POST", body: { name: "{{ params.name }}" } });
    expect((run.params as { required: string[] }).required).toEqual(["name"]);
  });
});

describe("auth and base paths", () => {
  it("security schemes become write-only secret fields, header keys first", () => {
    expect(imports.sonarr.auth.map((a) => a.auth)).toEqual([{ as: "header", name: "X-Api-Key" }, { as: "query", name: "apikey" }]);
    expect(imports.immich.auth.map((a) => a.auth.as)).toEqual(["header", "bearer"]);
    expect(imports.immich.unsupportedAuth[0]).toMatch(/cookie.*not supported automatically/);
    expect(imports.jellyfin.auth[0]!.auth).toEqual({ as: "header", name: "Authorization" });
    expect(imports.sonarr.reads.every((r) => r.auth === imports.sonarr.auth[0]!.key)).toBe(true);
    expect(importSpec(specs.sonarr, { authKey: null }).reads.every((r) => !r.auth)).toBe(true);
  });
  it("servers and basePath give the path prefix; absolute localhost servers keep only their path", () => {
    expect(basePathOf(specs.immich)).toBe("/api");
    expect(basePathOf(specs.sonarr)).toBe("");
    expect(basePathOf(specs.jellyfin)).toBe("");
    expect(basePathOf({ swagger: "2.0", basePath: "/v2/", paths: {} })).toBe("/v2");
    expect(basePathOf({ openapi: "3.1.0", servers: [{ url: "http://localhost:8080/jellyfin" }], paths: {} })).toBe("/jellyfin");
  });
  it("reads Swagger 2 too", () => {
    const doc = parseSpecText(JSON.stringify({
      swagger: "2.0", info: { title: "Old", version: "1" }, basePath: "/api", produces: ["application/json"],
      securityDefinitions: { key: { type: "apiKey", in: "header", name: "X-Key" } },
      paths: { "/things": { get: { parameters: [{ name: "limit", in: "query", type: "integer" }], responses: { "200": { schema: { type: "array", items: { type: "object", properties: { name: { type: "string" }, bytes: { type: "integer" } } } } } } } }, "/things/{name}": { get: { parameters: [{ name: "name", in: "path", required: true, type: "string" }], responses: { "200": { schema: { type: "object", properties: { name: { type: "string" }, status: { type: "string" } } } } } } } },
    }));
    const imp = importSpec(doc);
    expect(imp.specVersion).toBe("Swagger 2.0");
    expect(imp.reads.map((r) => r.path)).toEqual(expect.arrayContaining(["/api/things", "/api/things/{{ params.name }}"]));
    expect(choices(imp.reads.find((r) => r.source.path === "/things/{name}"))[0]).toMatchObject({ value: "name", label: "name" });
    expect(imp.auth[0]!.auth).toEqual({ as: "header", name: "X-Key" });
  });
});

describe("saved records", () => {
  it.each(Object.keys(specs) as (keyof typeof specs)[])("%s: every read is a valid Custom API endpoint and the import is a valid spec recipe", (name) => {
    const imp = imports[name];
    for (const r of imp.reads) {
      const v = customEndpointSchema.safeParse(toEndpoint(r));
      expect(v.success, `${r.id}: ${v.success ? "" : v.error.issues[0]?.message}`).toBe(true);
    }
    const rec = specRecipe(imp, { author: "test" });
    const v = validateRecipe(rec);
    expect(v.ok, v.ok ? "" : `${v.problem.field}: ${v.problem.message}`).toBe(true);
    expect(rec.id).toBe(specRecipeId(imp.title));
    expect(rec.appliesTo).toEqual({ spec: { title: imp.title } });
    expect(JSON.stringify(rec).length).toBeLessThan(2 * 1024 * 1024);
    // A recipe holds no auth placement or secret key.
    expect(JSON.stringify(rec)).not.toMatch(/"auth"|secret_/);
  });
});

describe("YAML equals JSON (criterion 9)", () => {
  it("a YAML spec parses to the same document and the same import as its JSON form", () => {
    setYamlLoader(safeLoaderFrom(jsYaml()));
    const fromYaml = parseSpecText(readFileSync(path.join(FIX, "sonarr.yaml"), "utf8"));
    expect(fromYaml).toEqual(specs.sonarr);
    expect(importSpec(fromYaml)).toEqual(imports.sonarr);
    const shelfYaml = parseSpecText(toYaml(FAKE_REST_SPEC));
    expect(shelfYaml).toEqual(JSON.parse(JSON.stringify(FAKE_REST_SPEC)));
  });
  it("the YAML loader is safe: custom tags are refused", () => {
    setYamlLoader(safeLoaderFrom(jsYaml()));
    expect(() => parseSpecText('openapi: 3.0.0\npaths: {}\nx: !!js/function "function () { return 1 }"\n')).toThrow(SpecError);
  });
  it("without a YAML reader, a YAML spec is refused with a plain message and JSON still works", () => {
    setYamlLoader(null);
    expect(() => parseSpecText("openapi: 3.0.0\npaths: {}\n")).toThrow(/cannot read YAML yet/);
    expect(parseSpecText(JSON.stringify({ openapi: "3.0.0", paths: {} }))).toBeTruthy();
  });
  it("refuses what is not a spec, and specs over 10 MB", () => {
    expect(() => parseSpecText('{"hello": 1}')).toThrow(/not an OpenAPI or Swagger spec/);
    expect(() => parseSpecText("x".repeat(10 * 1024 * 1024 + 1))).toThrow(/larger than 10 MB/);
  });
});
