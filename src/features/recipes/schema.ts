// Recipe files (architecture A9.1): validation, ids and the export format. Pure, no I/O, so the
// loader, the import routes, the Grafana importer and tests share it.
//
// A recipe is data, never code. Built-in Prometheus reads also carry "x-atrium-prometheus", the
// Wave 2.7 recipe record (packages/prometheus/recipe.ts) that the Prometheus package runs with its
// own escaping interpreter; it is plain data too and is validated by that package's schema.
import { z } from "zod";
import type { Recipe, RecipeRead } from "@/core/contracts";
import { endpointPathProblem, VALUE_FORMATS } from "@/features/integrations/manifest";
import { recipeSchema as promRecordSchema, type Recipe as PromRecord } from "@/packages/prometheus/recipe";

export const RECIPE_MAX_BYTES = 2 * 1024 * 1024;
export const MAX_READS = 1000;
export const RECIPE_ID = /^[a-z0-9][a-z0-9._-]{0,30}(\/[a-z0-9][a-z0-9._-]{0,30}){0,2}$/;
export const READ_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,44}$/;
const METRIC = /^[A-Za-z_:][A-Za-z0-9_:]*$/;
const LABEL = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PARAM_REF = /\{\{\s*params\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const SHAPES = ["stat", "series", "table", "status"] as const;

/** The endpoint id a recipe read gets on an integration (A9.1): r:<recipeId>:<readId>. */
export function recipeEndpointId(recipeId: string, readId: string): string {
  return `r:${recipeId}:${readId}`;
}

/** Splits an r:<recipeId>:<readId> endpoint id, or null when it is not one. */
export function parseRecipeEndpointId(id: string): { recipeId: string; readId: string } | null {
  const m = /^r:([^:]+):([^:]+)$/.exec(id);
  return m ? { recipeId: m[1]!, readId: m[2]! } : null;
}

const text = (max: number) => z.string().trim().min(1).max(max);
const params = z
  .record(z.string(), z.unknown())
  .refine((s) => s.type === "object", "must be an object schema with \"type\": \"object\"")
  .refine((s) => JSON.stringify(s).length <= 16_384, "is larger than 16 KB");

const httpRequest = z.strictObject({
  kind: z.literal("http"),
  path: z.string().min(1).max(2048).startsWith("/", "must start with /").superRefine((p, ctx) => {
    const why = endpointPathProblem(p);
    if (why) ctx.addIssue({ code: "custom", message: why });
  }),
  query: z.record(z.string().min(1).max(200), z.string().max(2048)).refine((q) => Object.keys(q).length <= 30, "has more than 30 entries").optional(),
});
const promqlRequest = z.strictObject({
  kind: z.literal("promql"),
  expr: z.string().trim().min(1).max(8000),
  range: z.strictObject({ hours: z.number().min(0.25).max(24 * 90), stepSec: z.number().int().min(5).max(86_400) }).optional(),
});
const labelValuesRequest = z.strictObject({
  kind: z.literal("label-values"),
  metric: z.string().regex(METRIC, "must be a metric name (letters, numbers, _ and :)").max(200),
  label: z.string().regex(LABEL, "must be a label name (letters, numbers and _)").max(100),
  display: z.string().regex(LABEL, "must be a label name (letters, numbers and _)").max(100).optional(),
});

const field = z.strictObject({ path: z.string().startsWith("$", "must start with $").max(500), label: z.string().max(120), role: z.enum(["value", "label", "time", "status", "column"]) });

export const recipeReadSchema = z.strictObject({
  id: z.string().regex(READ_ID, "must be letters, numbers, ., - or _ (at most 45)"),
  label: text(120),
  description: z.string().trim().max(1000).optional(),
  group: text(60).optional(),
  advanced: z.boolean().optional(),
  needs: text(200).optional(),
  params: params.optional(),
  request: z.discriminatedUnion("kind", [httpRequest, promqlRequest, labelValuesRequest], { error: "kind must be http, promql or label-values" }),
  fields: z.array(field).min(1).max(50).optional(),
  shape: z.enum(SHAPES, { error: "must be stat, series, table or status" }),
  format: z.enum(VALUE_FORMATS).optional(),
  columnFormats: z.record(z.string().max(120), z.enum(VALUE_FORMATS)).optional(),
  seriesName: z.string().max(300).optional(),
  refreshSec: z.number().int().min(5).max(86_400).optional(),
  "x-atrium-prometheus": z.record(z.string(), z.unknown()).optional(),
});

const appliesTo = z.union([
  z.strictObject({ package: z.string().min(1).max(120) }),
  z.strictObject({ spec: z.strictObject({ title: text(200) }) }),
  z.strictObject({ metrics: z.array(z.string().regex(METRIC, "must be metric names")).min(1).max(50) }),
], { error: "must be { package }, { spec: { title } } or { metrics: [...] }" });

const SOURCES = ["builtin", "file", "url", "grafana", "spec"] as const;

const base = z.strictObject({
  atriumRecipe: z.literal("1", { error: "must be \"1\" (this is not an Atrium recipe file, or a newer one)" }),
  id: z.string().regex(RECIPE_ID, "must be lower-case words with up to two /, such as grafana/1860"),
  name: text(120),
  version: text(40),
  author: text(120),
  description: z.string().trim().max(2000),
  source: z.enum(SOURCES, { error: "must be builtin, file, url, grafana or spec" }),
  appliesTo,
  reads: z.array(recipeReadSchema).min(1, "has no reads").max(MAX_READS, `has more than ${MAX_READS} reads`),
});

/** Names declared in a read's params schema. */
function declared(r: z.infer<typeof recipeReadSchema>): Set<string> {
  return new Set(Object.keys(((r.params as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}) as Record<string, unknown>));
}

function refs(...texts: (string | undefined)[]): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const m of (t ?? "").matchAll(PARAM_REF)) out.add(m[1]!);
  return [...out];
}

/** The Wave 2.7 record a built-in read carries, rebuilt with the read's own words (or null). */
export function promRecordOf(r: Pick<RecipeRead, "id" | "label" | "description" | "group" | "advanced" | "needs" | "params"> & { "x-atrium-prometheus"?: Record<string, unknown> | undefined }): PromRecord | null {
  const ext = r["x-atrium-prometheus"];
  if (!ext) return null;
  const needs = ext.needs as { anyMetric?: string[] } | undefined;
  return promRecordSchema.parse({
    ...ext,
    id: r.id,
    label: r.label,
    description: r.description ?? r.label,
    group: r.group ?? "Other",
    ...(r.advanced ? { advanced: true } : {}),
    ...(r.params ? { params: r.params } : {}),
    ...(needs?.anyMetric ? { needs: { anyMetric: needs.anyMetric, text: r.needs ?? "these metrics" } } : {}),
  });
}

/** A recipe file as parsed: the contract's Recipe, plus the built-in extension on reads. */
export type RecipeFile = Recipe & { reads: (RecipeRead & { "x-atrium-prometheus"?: Record<string, unknown> })[] };

export const recipeSchema = base.superRefine((rec, ctx) => {
  const ids = new Set<string>();
  const prom = "package" in rec.appliesTo ? rec.appliesTo.package === "prometheus" : "metrics" in rec.appliesTo;
  rec.reads.forEach((r, i) => {
    const at = (...p: (string | number)[]) => ["reads", i, ...p];
    if (ids.has(r.id)) ctx.addIssue({ code: "custom", path: at("id"), message: `"${r.id}" is used by two reads` });
    ids.add(r.id);
    const names = declared(r);
    const used = r.request.kind === "http" ? refs(r.request.path, ...Object.values(r.request.query ?? {})) : r.request.kind === "promql" && !r["x-atrium-prometheus"] ? refs(r.request.expr) : [];
    for (const n of used) if (!names.has(n)) ctx.addIssue({ code: "custom", path: at("request"), message: `uses {{ params.${n} }} but the read has no setting named "${n}"` });
    if (r.request.kind !== "http" && !prom) ctx.addIssue({ code: "custom", path: at("request", "kind"), message: `${r.request.kind} reads need appliesTo Prometheus (a package "prometheus" or metrics)` });
    if (r.request.kind === "http" && !r.fields) ctx.addIssue({ code: "custom", path: at("fields"), message: "an http read needs the fields to pick from its answer" });
    if (r.request.kind === "label-values" && r.shape !== "table") ctx.addIssue({ code: "custom", path: at("shape"), message: "a label-values read is a table (a list of choices)" });
    if (r["x-atrium-prometheus"]) {
      if (!prom) ctx.addIssue({ code: "custom", path: at("x-atrium-prometheus"), message: "only Prometheus recipes may carry a Prometheus record" });
      else {
        try { promRecordOf(r); } catch (e) {
          const issue = e instanceof z.ZodError ? e.issues[0] : undefined;
          ctx.addIssue({ code: "custom", path: at("x-atrium-prometheus", ...((issue?.path ?? []) as (string | number)[])), message: issue?.message ?? "is not a valid Prometheus record" });
        }
      }
    }
  });
});

/** Turns a Zod path into words: reads[3].request.expr. */
export function pathText(path: readonly PropertyKey[]): string {
  let out = "";
  for (const p of path) out += typeof p === "number" ? `[${p}]` : out ? `.${String(p)}` : String(p);
  return out || "the file";
}

export type RecipeProblem = { field: string; message: string };
export type ParseOutcome = { ok: true; recipe: RecipeFile } | { ok: false; problem: RecipeProblem };

/** Validates a parsed recipe. The first problem names the field and what is wrong with it. */
export function validateRecipe(raw: unknown): ParseOutcome {
  const r = recipeSchema.safeParse(raw);
  if (r.success) return { ok: true, recipe: r.data as RecipeFile };
  const issue = r.error.issues[0]!;
  const field = pathText(issue.path);
  let message = issue.message;
  if (issue.code === "unrecognized_keys") message = `has a field Atrium does not know: ${(issue as { keys?: string[] }).keys?.join(", ")}`;
  if (issue.code === "invalid_type" && /received undefined/i.test(issue.message)) message = "is missing";
  return { ok: false, problem: { field, message } };
}

/** Parses recipe file text (at most 2 MB). */
export function parseRecipeText(textIn: string): ParseOutcome {
  if (Buffer.byteLength(textIn, "utf8") > RECIPE_MAX_BYTES) return { ok: false, problem: { field: "the file", message: "is larger than 2 MB" } };
  let raw: unknown;
  try {
    raw = JSON.parse(textIn);
  } catch (e) {
    return { ok: false, problem: { field: "the file", message: `is not valid JSON (${(e as Error).message.slice(0, 120)})` } };
  }
  return validateRecipe(raw);
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

/** The export file (A9.1): sorted keys, 2-space indent, a final newline. */
export function exportText(r: RecipeFile): string {
  return `${JSON.stringify(sortKeys(r), null, 2)}\n`;
}

/** The export file name: <id>.atrium-recipe.json with / as -. */
export function exportFileName(id: string): string {
  return `${id.replace(/\//g, "-")}.atrium-recipe.json`;
}

/** The read's params with x-atrium-choices pointing at this recipe's own reads rewritten to r: ids. */
export function rewriteChoices(recipeId: string, r: RecipeRead, own: Set<string>): RecipeRead["params"] {
  const p = r.params as { properties?: Record<string, Record<string, unknown>> } | undefined;
  if (!p?.properties) return r.params;
  const properties = Object.fromEntries(Object.entries(p.properties).map(([k, prop]) => {
    const c = prop?.["x-atrium-choices"] as { endpointId?: string } | undefined;
    if (c?.endpointId && own.has(c.endpointId)) return [k, { ...prop, "x-atrium-choices": { ...c, endpointId: recipeEndpointId(recipeId, c.endpointId) } }];
    return [k, prop];
  }));
  return { ...p, properties };
}
