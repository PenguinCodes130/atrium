// Spec import v2 (recipes spec 3.3, architecture A9.3, research section 2.2): turns a whole
// OpenAPI 3.0/3.1 or Swagger 2 document into ranked, grouped, named Custom API reads with
// "pick which thing" dropdowns, plus the changes the service could make (hidden command
// candidates) and its auth schemes. Every operation is considered, never cut off in spec order.
// Pure: no I/O.
import type { AuthPlacement, CustomEndpoint, DataShapeKind, JsonSchema, ValueFormat } from "@/core/contracts";
import { specVersion, type SpecDoc } from "./load";
import { isScalar, propsOf, resolve, typeOf, type S } from "./schema";
import { columnKey, firstSentence, formatFor, groupName, idFrom, isTimeProp, labelFor, pathWords, titleOf, words } from "./words";

export const REFRESH_SEC = 60;
export const PAGE_SIZE = 50;
const MAX_COLUMNS = 6;
const SMALL_GROUP = 1;

export type SpecRead = CustomEndpoint & { headline: boolean; source: { path: string; tag?: string }; pairedWith?: string };
export type CommandCandidate = {
  id: string; label: string; description: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE"; path: string;
  params: JsonSchema; body?: unknown;
  /** False when Atrium cannot send it as a command (a setting in its address, or a body it cannot fill). */
  auth?: string;
  canAdd: boolean; why?: string;
};
export type AuthOption = { key: string; scheme: string; label: string; hint: string; auth: AuthPlacement; needsUser?: boolean };
export type Skipped = { method: string; path: string; reason: string };
export type SpecImport = {
  title: string; version: string; specVersion: string; basePath: string;
  reads: SpecRead[];
  commands: CommandCandidate[];
  auth: AuthOption[];
  unsupportedAuth: string[];
  skipped: Skipped[];
  totals: { operations: number; gets: number; reads: number; headline: number };
};

const READ_METHOD = "get";
const CHANGE_METHODS = ["post", "put", "patch", "delete"] as const;
const OTHER_METHODS = ["head", "options", "trace"];

// Path segments and tags that mark noise (research 2.2 "Drop noise").
const NOISE = new Set([
  "login", "logout", "loggedout", "auth", "authentication", "authorize", "sso", "oauth", "oauth2", "token", "tokens", "apikey", "apikeys", "keys", "password", "quickconnect", "startup",
  "config", "configuration", "configurations", "settings", "schema", "admin", "backup", "backups", "restore",
  "file", "files", "filesystem", "directorycontents", "image", "images", "thumbnail", "thumbnails", "mediacover", "logo", "logos", "icon", "icons", "avatar", "avatars", "profileimage",
  "stream", "streams", "download", "downloads", "upload", "uploads", "hls", "audio", "video", "videos", "subtitles", "subtitle", "trickplay", "playbackinfo", "socket", "websocket", "sync",
  "static", "staticresource", "content", "original", "branding", "localization", "environment", "ics", "routes", "openapi", "swagger", "docs",
]);
const NOISE_LOG_FILE = /\/log\/file/i;

// Headline words (research 2.2 "Headline vs advanced"), strongest first.
const HEADLINE = ["status", "health", "summary", "statistics", "stats", "counts", "count", "queue", "sessions", "session", "missing", "calendar", "diskspace", "storage", "info", "version", "activity", "upcoming", "wanted", "server", "system", "usage"];

const JSON_TYPE = /(^|\/|\+)json(;|$)|^\*\/\*$/i;

type Param = { name: string; in: string; required: boolean; description?: string; schema: S };
type Op = { method: string; path: string; op: S; params: Param[]; tag?: string };
type Columns = { fields: CustomEndpoint["fields"]; columnFormats: Record<string, ValueFormat>; keys: Map<string, string> };
type Shaped =
  | { kind: "rows"; prefix: string; item: S | undefined; scalarItems: boolean; total?: string }
  | { kind: "series"; prefix: string; time: string; value: string; valueSchema: S }
  | { kind: "status"; prop: string; label?: string }
  | { kind: "value"; path: string; name: string; schema: S }
  | { kind: "none"; reason: string };

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** servers[].url (variables filled with defaults, absolute addresses reduced to their path) or Swagger 2 basePath. */
export function basePathOf(doc: SpecDoc): string {
  let raw: string | undefined;
  if (Array.isArray(doc.servers) && doc.servers[0] && typeof doc.servers[0] === "object") {
    const sv = doc.servers[0] as S;
    raw = str(sv.url);
    const vars = (sv.variables ?? {}) as Record<string, S>;
    if (raw) raw = raw.replace(/\{([^}]+)\}/g, (_, n: string) => String(vars[n]?.default ?? ""));
  } else raw = str(doc.basePath);
  if (!raw) return "";
  let path = raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.startsWith("//")) {
    try { path = new URL(raw.startsWith("//") ? `http:${raw}` : raw).pathname; } catch { path = ""; }
  } else if (!raw.startsWith("/")) {
    // "localhost:8989/api" after variables: keep the part after the first slash.
    const i = raw.indexOf("/");
    path = i >= 0 ? raw.slice(i) : "";
  }
  return path.replace(/\/+$/, "");
}

function paramsOf(doc: SpecDoc, item: S, op: S): Param[] {
  const byKey = new Map<string, Param>();
  for (const list of [item.parameters, op.parameters]) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const p = resolve(doc, raw);
      if (!p || typeof p.name !== "string" || typeof p.in !== "string") continue;
      // Swagger 2 keeps type, enum and format on the parameter itself.
      const schema = resolve(doc, p.schema) ?? { type: p.type ?? "string", ...(p.enum ? { enum: p.enum } : {}), ...(p.format ? { format: p.format } : {}), ...(p.default !== undefined ? { default: p.default } : {}), ...(p.items ? { items: p.items } : {}) };
      byKey.set(`${p.in}:${p.name}`, { name: p.name, in: p.in, required: p.required === true || p.in === "path", ...(str(p.description) ? { description: firstSentence(String(p.description)).slice(0, 300) } : {}), schema });
    }
  }
  return [...byKey.values()];
}

/** The JSON response schema of a GET, or why there is none. */
function responseOf(doc: SpecDoc, op: S): { schema: S } | { reason: string } {
  const responses = (op.responses ?? {}) as Record<string, unknown>;
  const key = ["200", "2XX", "2xx", "201", "203", "206", "default"].find((k) => responses[k] !== undefined);
  const ok = key ? resolve(doc, responses[key]) : undefined;
  if (!ok) return { reason: "The spec does not describe a successful answer." };
  if (doc.swagger) {
    const produces = (Array.isArray(op.produces) ? op.produces : Array.isArray(doc.produces) ? doc.produces : undefined) as string[] | undefined;
    if (produces && produces.length && !produces.some((t) => JSON_TYPE.test(t))) return { reason: "It does not answer with JSON." };
    const schema = resolve(doc, ok.schema);
    return schema ? { schema } : { reason: "The spec does not say what it answers." };
  }
  const content = ok.content as Record<string, S> | undefined;
  if (!content || !Object.keys(content).length) return { reason: "The spec does not say what it answers." };
  const jsonKey = Object.keys(content).find((t) => JSON_TYPE.test(t));
  if (!jsonKey) return { reason: "It does not answer with JSON." };
  const schema = resolve(doc, content[jsonKey]?.schema);
  return schema ? { schema } : { reason: "The spec does not say what it answers." };
}

function noiseReason(path: string, tag: string | undefined, op: S): string | undefined {
  if (NOISE_LOG_FILE.test(path)) return "Log files are not dashboard data.";
  const segs = path.toLowerCase().split("/").filter((s) => s && !s.startsWith("{")).flatMap((s) => [s, s.replace(/[^a-z0-9]/g, "")]);
  const hit = segs.find((s) => NOISE.has(s) || /\.(ics|png|jpe?g|svg|ico|css|js|html?)$/.test(s));
  if (hit) return `Not dashboard data (${hit}).`;
  if (/^\/\{[^}]+\}$/.test(path) || path === "/") return "Not dashboard data (static pages).";
  const t = (tag ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (t && NOISE.has(t)) return `Not dashboard data (${tag}).`;
  if (op.deprecated === true) return "The spec marks it deprecated.";
  return undefined;
}

const NAME_PROPS = ["name", "title", "displayname", "hostname", "label", "username", "devicename", "client", "sorttitle"];
const STATUS_PROPS = /^(status|state|health|healthy|up|online|isonline|isactive|active|running|ok)$/i;
const TOTAL_PROPS = ["totalrecords", "totalrecordcount", "total", "totalcount", "totalitems", "count", "recordcount", "itemcount"];

function nameProp(props: [string, S][]): string | undefined {
  for (const want of NAME_PROPS) {
    const hit = props.find(([k, s]) => k.toLowerCase() === want && typeOf(s) === "string");
    if (hit) return hit[0];
  }
  return props.find(([k, s]) => /name$/i.test(k) && typeOf(s) === "string")?.[0];
}

/** Shape rules (research 2.2 "List calls vs detail calls" and "Shapes"). */
function shapeOf(doc: SpecDoc, schema: S): Shaped {
  const t = typeOf(schema);
  if (t === "array") {
    const item = resolve(doc, schema.items);
    const it = typeOf(item);
    if (it === "object" || item?.properties) {
      const props = propsOf(doc, item);
      const time = props.find(([k, s]) => isTimeProp(k, s) || /^(t|time|timestamp)$/i.test(k));
      const nums = props.filter(([, s]) => typeOf(s) === "number" || typeOf(s) === "integer");
      if (time && nums.length >= 1 && props.length <= 3) return { kind: "series", prefix: "$[*]", time: time[0], value: nums.find(([k]) => k !== time[0])?.[0] ?? nums[0]![0], valueSchema: nums[0]![1] };
      return { kind: "rows", prefix: "$[*]", item, scalarItems: false };
    }
    // A list whose items the spec does not describe is one "Value" column (the live check says if it is useful).
    if (isScalar(it) || it === undefined) return { kind: "rows", prefix: "$[*]", item, scalarItems: true };
    return { kind: "none", reason: "Its answer is a list of lists." };
  }
  if (t === "object") {
    const props = propsOf(doc, schema);
    const arrays = props.filter(([, s]) => typeOf(s) === "array");
    if (arrays.length >= 1) {
      // A paged wrapper or an object holding one list: rows from the list, a count from its total.
      const pick = arrays.find(([k]) => /^(records|items|results|data|rows|list|entries|value)$/i.test(k)) ?? (arrays.length === 1 ? arrays[0] : undefined);
      if (pick) {
        const item = resolve(doc, pick[1].items);
        const total = props.find(([k, s]) => TOTAL_PROPS.includes(k.toLowerCase()) && (typeOf(s) === "integer" || typeOf(s) === "number"))?.[0];
        if (typeOf(item) === "object" || item?.properties) return { kind: "rows", prefix: `$.${pick[0]}[*]`, item, scalarItems: false, ...(total ? { total } : {}) };
        if (isScalar(typeOf(item))) return { kind: "rows", prefix: `$.${pick[0]}[*]`, item, scalarItems: true, ...(total ? { total } : {}) };
      }
    }
    const status = props.find(([k, s]) => STATUS_PROPS.test(k) && (typeOf(s) === "string" || typeOf(s) === "boolean"));
    if (status) return { kind: "status", prop: status[0], ...(nameProp(props) ? { label: nameProp(props)! } : {}) };
    const nums = props.filter(([, s]) => typeOf(s) === "number" || typeOf(s) === "integer");
    if (nums.length >= 1 && nums.length <= 3) return { kind: "value", path: `$.${nums[0]![0]}`, name: nums[0]![0], schema: nums[0]![1] };
    const version = props.find(([k, s]) => /^(version|serverversion|appversion)$/i.test(k) && isScalar(typeOf(s)));
    if (version) return { kind: "value", path: `$.${version[0]}`, name: version[0], schema: version[1] };
    if (nums.length > 3) return { kind: "value", path: `$.${nums[0]![0]}`, name: nums[0]![0], schema: nums[0]![1] };
    const named = nameProp(props);
    if (named) return { kind: "value", path: `$.${named}`, name: named, schema: props.find(([k]) => k === named)![1] };
    const firstScalar = props.find(([, s]) => isScalar(typeOf(s)));
    if (firstScalar) return { kind: "value", path: `$.${firstScalar[0]}`, name: firstScalar[0], schema: firstScalar[1] };
    return { kind: "none", reason: "Its answer has no fixed fields to show." };
  }
  if (isScalar(t)) return { kind: "value", path: "$", name: "value", schema };
  return { kind: "none", reason: "The spec does not say what its answer holds." };
}

/** Up to six scalar columns: name, title and status first, ids last, nested objects skipped. */
function columnsFor(doc: SpecDoc, prefix: string, item: S | undefined, scalarItems: boolean, must: string[] = []): Columns {
  const keys = new Map<string, string>();
  if (scalarItems || !item) {
    keys.set("$value", "value");
    return { fields: [{ path: prefix, label: "Value", role: "column" }], columnFormats: {}, keys };
  }
  const props = propsOf(doc, item).filter(([, s]) => isScalar(typeOf(s)));
  const rank = ([k]: [string, S]) => {
    const l = k.toLowerCase();
    if (NAME_PROPS.includes(l)) return 0;
    if (STATUS_PROPS.test(l)) return 1;
    if (l === "id" || /id$/.test(l)) return 9;
    return 5;
  };
  const sorted = props.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map((x) => x.p);
  const chosen = sorted.slice(0, MAX_COLUMNS);
  for (const m of must) if (!chosen.some(([k]) => k === m)) { const hit = props.find(([k]) => k === m); if (hit) chosen.push(hit); }
  const fields: CustomEndpoint["fields"] = [];
  const columnFormats: Record<string, ValueFormat> = {};
  chosen.forEach(([k, s], i) => {
    const t = typeOf(s);
    const role: CustomEndpoint["fields"][number]["role"] = isTimeProp(k, s) ? "time" : STATUS_PROPS.test(k) ? "status" : t === "number" || t === "integer" ? "value" : "column";
    fields.push({ path: `${prefix}.${k}`, label: k, role });
    const key = columnKey(k, i);
    keys.set(k, key);
    const f = role === "value" ? formatFor(k, s) : undefined;
    if (f) columnFormats[key] = f;
  });
  return { fields, columnFormats, keys };
}

function paramSchemaOf(p: Param): S {
  const s = p.schema;
  const t = typeOf(s);
  const out: S = {
    // Path settings travel as text (a dropdown stores text); query settings keep their type.
    type: p.in === "path" ? "string" : t === "integer" || t === "number" || t === "boolean" ? t : "string",
    title: titleOf(p.name),
    ...(p.description ? { description: p.description } : {}),
  };
  if (Array.isArray(s.enum) && s.enum.length && s.enum.length <= 200) {
    out.type = "string";
    out.enum = s.enum.map(String);
    out["x-atrium-labels"] = Object.fromEntries(s.enum.map((v) => [String(v), titleOf(String(v))]));
  }
  if (s.default !== undefined && isScalar(typeof s.default === "number" ? "number" : typeof s.default === "boolean" ? "boolean" : typeof s.default === "string" ? "string" : undefined)) out.default = p.in === "path" || out.type === "string" ? String(s.default) : s.default;
  if (/^(pagesize|limit|page_size|per_page|perpage|take|count|maxitems)$/i.test(p.name) && (out.type === "integer" || out.type === "number")) out.default = PAGE_SIZE;
  if (typeof s.minimum === "number" && out.type !== "string") out.minimum = s.minimum;
  if (typeof s.maximum === "number" && out.type !== "string") out.maximum = s.maximum;
  return out;
}

function headlineScore(path: string, tag: string | undefined, label: string): number {
  const hay = `${pathWords(path).join(" ")} ${tag ?? ""} ${label}`.toLowerCase().replace(/[^a-z0-9 ]/g, " ");
  const tokens = new Set(hay.split(/\s+/).filter(Boolean));
  const joined = hay.replace(/\s+/g, "");
  for (let i = 0; i < HEADLINE.length; i++) {
    const w = HEADLINE[i]!;
    if (tokens.has(w) || (w.length >= 6 && joined.includes(w))) return HEADLINE.length - i;
  }
  return 0;
}

/** Endpoint ids fit both a Custom API endpoint and a recipe read id (at most 45 characters). */
const MAX_ID = 45;

function uniqueId(base: string, taken: Set<string>): string {
  let id = base.slice(0, MAX_ID).replace(/-+$/, "") || "read";
  if (!/^[a-z0-9]/.test(id)) id = `r-${id}`.slice(0, MAX_ID);
  if (!taken.has(id)) { taken.add(id); return id; }
  for (let n = 2; ; n++) {
    const c = `${id.slice(0, MAX_ID - 1 - String(n).length).replace(/-+$/, "")}-${n}`;
    if (!taken.has(c)) { taken.add(c); return c; }
  }
}

const MAX_QUERY = 20;
const MAX_PARAMS_JSON = 15_000;

/**
 * Keeps a read's settings small enough to save (a params schema is at most 16 KB, a recipe read at
 * most 30 query entries): required settings and page sizes first, then the rest in spec order up
 * to 20; descriptions and long enum lists go before settings do.
 */
function fitParams(properties: Record<string, S>, required: string[], query: Record<string, string>): void {
  const queryKeys = Object.entries(query).map(([q, v]) => ({ q, k: /params\.([A-Za-z0-9_]+)/.exec(v)?.[1] ?? "" }));
  const keep = (k: string) => required.includes(k) || properties[k]?.default !== undefined;
  const ordered = [...queryKeys.filter((x) => keep(x.k)), ...queryKeys.filter((x) => !keep(x.k))];
  for (const x of ordered.slice(MAX_QUERY)) { delete query[x.q]; delete properties[x.k]; }
  const size = () => JSON.stringify({ type: "object", properties, required }).length;
  if (size() > MAX_PARAMS_JSON) for (const p of Object.values(properties)) delete p.description;
  if (size() > MAX_PARAMS_JSON) for (const p of Object.values(properties)) if (Array.isArray(p.enum) && p.enum.length > 30) { delete p.enum; delete p["x-atrium-labels"]; }
  const optional = Object.keys(properties).filter((k) => !required.includes(k)).reverse();
  while (size() > MAX_PARAMS_JSON && optional.length) {
    const k = optional.shift()!;
    delete properties[k];
    for (const [q, v] of Object.entries(query)) if (v.includes(`params.${k} `)) delete query[q];
  }
}

function placeholder(name: string): string {
  return `{{ params.${name} }}`;
}

/** A safe settings key for a spec parameter name ("api-key" -> "api_key"). */
function settingKey(name: string, taken: Set<string>): string {
  let k = name.replace(/[^A-Za-z0-9_]/g, "_").replace(/^([0-9])/, "_$1") || "p";
  while (taken.has(k)) k = `${k}_`;
  taken.add(k);
  return k;
}

type Draft = {
  read: SpecRead;
  /** A count read scores by the words of the read it counts, never by the word "count" alone. */
  scoreLabel?: string;
  /** Spec param name -> settings key. */
  keys: Map<string, string>;
  /** For list reads: property -> column key. */
  columns?: Map<string, string>;
  rowProps?: [string, S][];
  listPath?: string;
  requiredFree: boolean;
};

function authOptions(doc: SpecDoc): { options: AuthOption[]; unsupported: string[] } {
  const schemes = ((doc.components as S | undefined)?.securitySchemes ?? doc.securityDefinitions ?? {}) as Record<string, unknown>;
  const options: AuthOption[] = [];
  const unsupported: string[] = [];
  const used = new Set<string>();
  for (const [name, raw] of Object.entries(schemes)) {
    const s = resolve(doc, raw);
    if (!s) continue;
    const key = settingKey(`secret_${name}`.toLowerCase(), used);
    const desc = str(s.description) ? firstSentence(String(s.description)) : undefined;
    const type = String(s.type ?? "").toLowerCase();
    const scheme = String(s.scheme ?? "").toLowerCase();
    if (type === "http" && scheme === "bearer") {
      options.push({ key, scheme: name, label: "Bearer token", hint: desc ?? "A long-lived token from the service's settings. Sent as Authorization: Bearer.", auth: { as: "bearer" } });
    } else if ((type === "http" && scheme === "basic") || type === "basic") {
      options.push({ key, scheme: name, label: "Password", hint: desc ?? "Sent with the username as Basic auth.", auth: { as: "basic", userKey: `${key}_user` }, needsUser: true });
    } else if (type === "apikey" && (s.in === "header" || s.in === "query") && typeof s.name === "string") {
      const where = s.in === "header" ? `the ${s.name} header` : `the ${s.name} query parameter`;
      options.push({ key, scheme: name, label: "API key", hint: `${desc ?? "The API key from the service's settings"}. Sent in ${where}.`, auth: s.in === "header" ? { as: "header", name: s.name } : { as: "query", name: s.name } });
    } else {
      unsupported.push(`${name} (${type === "apikey" ? `API key in a ${String(s.in)}` : type || "unknown"}): not supported automatically, use a token`);
    }
  }
  // Header keys first, then bearer, then query, then basic (research 2.2 "Auth").
  const order = (o: AuthOption) => (o.auth.as === "header" ? 0 : o.auth.as === "bearer" ? 1 : o.auth.as === "query" ? 2 : 3);
  options.sort((a, b) => order(a) - order(b));
  return { options, unsupported };
}

/** False only when the operation says it needs no auth (an empty security list). */
function needsAuth(op: S): boolean {
  return !(Array.isArray(op.security) && op.security.length === 0);
}

const CHANGE_VERB: Record<string, string> = { post: "Add to", put: "Change", patch: "Change", delete: "Remove" };

function commandFrom(doc: SpecDoc, o: Op, taken: Set<string>): CommandCandidate {
  const named = typeof o.op.summary === "string" || typeof o.op.description === "string";
  const base0 = labelFor(o.op, o.path, o.tag);
  // Without words in the spec, say what the change does: "Remove series details", not "Series details".
  const label = named ? base0 : `${CHANGE_VERB[o.method] ?? "Change"} ${base0[0]!.toLowerCase()}${base0.slice(1)}`;
  const base = `${idFrom(o.path).replace(/-/g, ".")}.${o.method}`.replace(/[^a-z0-9.]/g, "").replace(/\.+/g, ".").replace(/^\./, "");
  let id = base || `cmd.${o.method}`;
  for (let n = 2; taken.has(id); n++) id = `${base}${n}`;
  taken.add(id);
  const description = (str(o.op.description) ? firstSentence(String(o.op.description)) : `${o.method.toUpperCase()} ${o.path}`).slice(0, 300);
  const pathParams = o.params.filter((p) => p.in === "path");
  const reqQuery = o.params.filter((p) => p.in === "query" && p.required);
  // A request body's top-level scalar properties become command settings filled into the body.
  let bodySchema: S | undefined;
  if (doc.swagger) bodySchema = resolve(doc, o.params.find((p) => p.in === "body")?.schema);
  else {
    const rb = resolve(doc, o.op.requestBody);
    const content = (rb?.content ?? {}) as Record<string, S>;
    const k = Object.keys(content).find((t) => JSON_TYPE.test(t));
    bodySchema = k ? resolve(doc, content[k]?.schema) : undefined;
    if (rb && !k && Object.keys(content).length) return { id, label, description, method: o.method.toUpperCase() as CommandCandidate["method"], path: o.path, params: { type: "object", properties: {} }, canAdd: false, why: "Its body is not JSON." };
  }
  const props = propsOf(doc, bodySchema).filter(([, s]) => isScalar(typeOf(s)));
  const required = Array.isArray(bodySchema?.required) ? (bodySchema!.required as string[]) : [];
  const nonScalarRequired = required.some((r) => !props.some(([k]) => k === r));
  const params: JsonSchema = {
    type: "object",
    properties: Object.fromEntries(props.map(([k, s]) => [k, { type: typeOf(s) === "integer" || typeOf(s) === "number" || typeOf(s) === "boolean" ? typeOf(s) : "string", title: titleOf(k), ...(Array.isArray(s.enum) ? { enum: s.enum } : {}) }])),
    required: required.filter((r) => props.some(([k]) => k === r)),
    additionalProperties: false,
  };
  const body = bodySchema ? Object.fromEntries(props.map(([k]) => [k, placeholder(k)])) : undefined;
  const cand: CommandCandidate = { id, label, description, method: o.method.toUpperCase() as CommandCandidate["method"], path: o.path, params, ...(body && Object.keys(body).length ? { body } : {}), canAdd: true };
  if (pathParams.length) return { ...cand, canAdd: false, why: "Its address needs a setting; add it by hand from the commands screen." };
  if (reqQuery.length) return { ...cand, canAdd: false, why: "It needs query settings; add it by hand from the commands screen." };
  if (nonScalarRequired) return { ...cand, canAdd: false, why: "Its body needs nested values Atrium cannot fill." };
  return cand;
}

/** Imports a whole spec. `authKey` picks which auth option the reads use (default: the first). */
export function importSpec(doc: SpecDoc, opts: { authKey?: string | null } = {}): SpecImport {
  const info = (doc.info ?? {}) as S;
  const title = str(info.title)?.slice(0, 120) ?? "API";
  const version = str(info.version)?.slice(0, 40) ?? "";
  const basePath = basePathOf(doc);
  const { options: auth, unsupported } = authOptions(doc);
  const chosen = opts.authKey === null ? undefined : auth.find((a) => a.key === opts.authKey) ?? auth[0];
  const paths = (doc.paths ?? {}) as Record<string, unknown>;
  const ops: Op[] = [];
  const skipped: Skipped[] = [];
  let operations = 0;
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = resolve(doc, rawItem);
    if (!item || !path.startsWith("/")) continue;
    for (const method of [READ_METHOD, ...CHANGE_METHODS, ...OTHER_METHODS]) {
      const op = resolve(doc, item[method]);
      if (!op) continue;
      operations++;
      if (OTHER_METHODS.includes(method)) { skipped.push({ method: method.toUpperCase(), path, reason: "Not a read or a change." }); continue; }
      const tag = Array.isArray(op.tags) && typeof op.tags[0] === "string" ? op.tags[0] : undefined;
      ops.push({ method, path, op, params: paramsOf(doc, item, op), ...(tag ? { tag } : {}) });
    }
  }
  const gets = ops.filter((o) => o.method === READ_METHOD);
  const takenIds = new Set<string>();
  const drafts: Draft[] = [];
  const extra: Draft[] = [];
  for (const o of gets) {
    const noise = noiseReason(o.path, o.tag, o.op);
    if (noise) { skipped.push({ method: "GET", path: o.path, reason: noise }); continue; }
    const headerNeeded = o.params.find((p) => (p.in === "header" || p.in === "cookie") && p.required);
    if (headerNeeded) { skipped.push({ method: "GET", path: o.path, reason: `It needs a ${headerNeeded.in} setting (${headerNeeded.name}).` }); continue; }
    if (o.params.some((p) => p.in === "body" || p.in === "formData") && o.params.some((p) => (p.in === "body" || p.in === "formData") && p.required)) { skipped.push({ method: "GET", path: o.path, reason: "It needs a request body." }); continue; }
    const res = responseOf(doc, o.op);
    if ("reason" in res) { skipped.push({ method: "GET", path: o.path, reason: res.reason }); continue; }
    const shaped = shapeOf(doc, res.schema);
    if (shaped.kind === "none") { skipped.push({ method: "GET", path: o.path, reason: shaped.reason }); continue; }
    // Settings: path and query parameters, with {{ params.x }} placeholders.
    const keys = new Map<string, string>();
    const usedKeys = new Set<string>();
    const properties: Record<string, S> = {};
    const required: string[] = [];
    const query: Record<string, string> = {};
    let fullPath = o.path;
    for (const p of o.params) {
      if (p.in !== "path" && p.in !== "query") continue;
      const k = settingKey(p.name, usedKeys);
      keys.set(p.name, k);
      properties[k] = paramSchemaOf(p);
      if (p.required) required.push(k);
      if (p.in === "path") fullPath = fullPath.split(`{${p.name}}`).join(placeholder(k));
      else query[p.name] = placeholder(k);
    }
    fitParams(properties, required, query);
    const label = labelFor(o.op, o.path, o.tag);
    const description = (str(o.op.description) && str(o.op.summary) ? firstSentence(String(o.op.description)) : undefined)?.slice(0, 500);
    const id = uniqueId(idFrom(o.path), takenIds);
    const group = (o.tag ? groupName(o.tag) : "Other").slice(0, 60);
    const base = {
      id, method: "GET" as const,
      path: `${basePath}${fullPath}` || "/",
      ...(Object.keys(query).length ? { query } : {}),
      ...(chosen && needsAuth(o.op) ? { auth: chosen.key } : {}),
      refreshSec: REFRESH_SEC,
      ...(Object.keys(properties).length ? { params: { type: "object", properties, required, additionalProperties: false } as JsonSchema } : {}),
      ...(description && description !== label ? { description } : {}),
      group,
    };
    const requiredFree = required.length === 0;
    if (shaped.kind === "rows") {
      const cols = columnsFor(doc, shaped.prefix, shaped.item, shaped.scalarItems, ["id"]);
      if (!cols.fields.length) { takenIds.delete(id); skipped.push({ method: "GET", path: o.path, reason: "Its rows have no plain values to show." }); continue; }
      const read: SpecRead = {
        ...base, label, shape: "table", fields: cols.fields,
        ...(Object.keys(cols.columnFormats).length ? { columnFormats: cols.columnFormats } : {}),
        headline: false, source: { path: o.path, ...(o.tag ? { tag: o.tag } : {}) },
      };
      drafts.push({ read, keys, columns: cols.keys, rowProps: shaped.scalarItems ? [] : propsOf(doc, shaped.item), listPath: o.path, requiredFree });
      if (shaped.total) {
        const countId = uniqueId(`${id}-count`, takenIds);
        extra.push({
          read: { ...base, id: countId, label: `${label} count`, shape: "stat", fields: [{ path: `$.${shaped.total}`, label: `${label} count`, role: "value" }], headline: false, source: { path: o.path, ...(o.tag ? { tag: o.tag } : {}) } },
          keys, requiredFree, scoreLabel: label,
        });
      }
    } else if (shaped.kind === "series") {
      const f = formatFor(shaped.value, shaped.valueSchema);
      drafts.push({ read: { ...base, label, shape: "series", fields: [{ path: `${shaped.prefix}.${shaped.time}`, label: "time", role: "time" }, { path: `${shaped.prefix}.${shaped.value}`, label: words(shaped.value), role: "value" }], ...(f ? { format: f } : {}), headline: false, source: { path: o.path, ...(o.tag ? { tag: o.tag } : {}) } }, keys, requiredFree });
    } else if (shaped.kind === "status") {
      const fields: CustomEndpoint["fields"] = [{ path: `$.${shaped.prop}`, label: words(shaped.prop), role: "status" }];
      if (shaped.label) fields.push({ path: `$.${shaped.label}`, label: words(shaped.label), role: "label" });
      drafts.push({ read: { ...base, label, shape: "status", fields, headline: false, source: { path: o.path, ...(o.tag ? { tag: o.tag } : {}) } }, keys, requiredFree });
    } else {
      const f = typeOf(shaped.schema) === "string" ? undefined : formatFor(shaped.name, shaped.schema);
      drafts.push({ read: { ...base, label, shape: "stat", fields: [{ path: shaped.path, label: shaped.name === "value" ? label : words(shaped.name), role: "value" }], ...(f ? { format: f } : {}), headline: false, source: { path: o.path, ...(o.tag ? { tag: o.tag } : {}) } }, keys, requiredFree });
    }
  }
  const all = [...drafts, ...extra];
  pair(all);
  // Groups: tags with a single read merge into Other.
  const counts = new Map<string, number>();
  for (const d of all) counts.set(d.read.group!, (counts.get(d.read.group!) ?? 0) + 1);
  for (const d of all) if ((counts.get(d.read.group!) ?? 0) <= SMALL_GROUP) d.read.group = "Other";
  // Labels stay unique within the import.
  const seen = new Map<string, number>();
  for (const d of all) seen.set(d.read.label, (seen.get(d.read.label) ?? 0) + 1);
  for (const d of all) if ((seen.get(d.read.label) ?? 0) > 1) d.read.label = `${d.read.label} (${pathWords(d.read.source.path).join(" ") || "root"})`.slice(0, 116);
  const used = new Set<string>();
  for (const d of all) {
    let l = d.read.label;
    for (let n = 2; used.has(l); n++) l = `${d.read.label} ${n}`;
    used.add(l);
    d.read.label = l;
  }
  // Headline: no settings needed (or only dropdowns), and a headline word in the path, tag or label.
  const scored = all.map((d, i) => {
    const props = ((d.read.params as { properties?: Record<string, S> } | undefined)?.properties ?? {}) as Record<string, S>;
    const req = ((d.read.params as { required?: string[] } | undefined)?.required ?? []) as string[];
    const easy = req.every((k) => !!props[k]?.["x-atrium-choices"] || Array.isArray(props[k]?.enum));
    const score = easy ? headlineScore(d.read.source.path, d.read.source.tag, d.scoreLabel ?? d.read.label) : 0;
    d.read.headline = score > 0;
    if (!d.read.headline) d.read.advanced = true;
    return { d, i, score, settings: req.length };
  });
  scored.sort((a, b) => (b.d.read.headline ? 1 : 0) - (a.d.read.headline ? 1 : 0) || b.score - a.score || a.settings - b.settings || a.d.read.source.path.length - b.d.read.source.path.length || a.i - b.i);
  const reads = scored.map((x) => x.d.read);
  const cmdIds = new Set<string>();
  const commands = ops.filter((o) => o.method !== READ_METHOD).map((o) => ({ ...commandFrom(doc, o, cmdIds), ...(chosen && needsAuth(o.op) ? { auth: chosen.key } : {}) }));
  return {
    title, version, specVersion: specVersion(doc), basePath,
    reads,
    commands,
    auth,
    unsupportedAuth: unsupported,
    skipped,
    totals: { operations, gets: gets.length, reads: reads.length, headline: reads.filter((r) => r.headline).length },
  };
}

/**
 * "Pick which thing" (A8.2): a setting named {param} on /x/{param}, or a <x>Id setting, gets its
 * choices from the list read /x (or /xs) when that list's rows hold the matching property. The list
 * must run with no settings of its own. The list's table gets the value and label columns.
 */
function pair(drafts: Draft[]): void {
  const lists = new Map<string, Draft>();
  for (const d of drafts) if (d.read.shape === "table" && d.requiredFree && d.rowProps?.length && d.listPath) lists.set(d.listPath.toLowerCase(), d);
  const listByWord = new Map<string, Draft>();
  for (const [p, d] of [...lists].sort((a, b) => a[0].length - b[0].length)) {
    const last = p.split("/").filter(Boolean).pop();
    if (last && !listByWord.has(last)) listByWord.set(last, d);
  }
  for (const d of drafts) {
    const props = ((d.read.params as { properties?: Record<string, S> } | undefined)?.properties ?? {}) as Record<string, S>;
    for (const [specName, key] of d.keys) {
      const prop = props[key];
      if (!prop || prop.enum) continue;
      let list: Draft | undefined;
      let want: string[] = [];
      const src = d.read.source.path;
      const placeholderSeg = `{${specName}}`;
      const segs = src.split("/");
      const at = segs.indexOf(placeholderSeg);
      if (at > 0) {
        list = lists.get(segs.slice(0, at).join("/").toLowerCase());
        const noun = segs[at - 1] ?? "";
        want = ["id", specName, `${noun.replace(/s$/i, "")}id`, `${noun}id`];
      }
      if (!list && /.+id$/i.test(specName)) {
        const noun = specName.replace(/_?id$/i, "").toLowerCase();
        list = listByWord.get(noun) ?? listByWord.get(`${noun}s`) ?? listByWord.get(`${noun}es`);
        want = ["id", specName];
      }
      if (!list || list === d) continue;
      const rowProps = list.rowProps ?? [];
      const valueProp = want.map((w) => rowProps.find(([k, s]) => k.toLowerCase() === w.toLowerCase() && isScalar(typeOf(s)))).find(Boolean);
      if (!valueProp) continue;
      const labelProp = nameProp(rowProps) ?? valueProp[0];
      ensureColumn(list, valueProp[0], valueProp[1]);
      ensureColumn(list, labelProp, rowProps.find(([k]) => k === labelProp)![1]);
      prop["x-atrium-choices"] = { endpointId: list.read.id, value: list.columns!.get(valueProp[0])!, label: list.columns!.get(labelProp)! };
      d.read.pairedWith = list.read.id;
    }
  }
}

function ensureColumn(list: Draft, prop: string, s: S): void {
  if (list.columns!.has(prop)) return;
  const prefix = list.read.fields[0]!.path.replace(/\.[^.[\]]+$/, "");
  const i = list.read.fields.length;
  list.read.fields.push({ path: `${prefix}.${prop}`, label: prop, role: typeOf(s) === "integer" || typeOf(s) === "number" ? "value" : "column" });
  list.columns!.set(prop, columnKey(prop, i));
}

/** The CustomEndpoint record of a read (the extra import fields dropped). */
export function toEndpoint(r: SpecRead): CustomEndpoint {
  const { headline: _h, source: _s, pairedWith: _p, ...e } = r;
  void _h; void _s; void _p;
  return e;
}

/** A shape kind in words, for the import screen. */
export const SHAPE_WORDS: Record<DataShapeKind, string> = { stat: "One value", series: "Values over time", table: "A table", status: "Up and down" };
