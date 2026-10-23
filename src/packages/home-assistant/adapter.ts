// Home Assistant adapter (architecture v3 section 3.2, amendment A1.5). Reads use GET, plus the
// documented read POST /api/template for areas. Commands each send one POST to a service.
import type { AdapterContext, ValueFormat } from "@/core/contracts";
import { arr, checkStatus, defineAdapter, fail, getJson, num, obj, saidBy, sendCommand, str, type CommandFn } from "../lib";

const TOKEN = { auth: "token", secretLabel: "Long-lived access token" };
const AREA = /^[a-z0-9_]+$/;
const DOMAIN = /^[a-z_]+$/;
const ENTITY = /^[a-z_]+\.[a-z0-9_]+$/;

const UP = new Set(["on", "home", "open", "playing", "unlocked", "active", "above_horizon"]);
const DOWN = new Set(["off", "unavailable", "not_home", "closed", "idle", "paused", "locked", "below_horizon"]);

/** Renders a template through the documented read POST. The template is never built from unchecked input. */
async function template(ctx: AdapterContext, tpl: string): Promise<unknown> {
  const res = await ctx.http.fetch({ path: "api/template", method: "POST", body: { template: tpl }, auth: TOKEN.auth });
  checkStatus(res, TOKEN.secretLabel, await saidBy(res));
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fail("bad_response", "Home Assistant's template answer was not in the expected format.", "Check the Home Assistant version.");
  }
}

function attrsText(a: Record<string, unknown>): string {
  const t = JSON.stringify(a);
  return t.length > 300 ? `${t.slice(0, 297)}...` : t;
}

function entityRow(e: unknown) {
  const s = obj(e, "entity");
  const id = str(s.entity_id);
  const attributes = s.attributes && typeof s.attributes === "object" ? (s.attributes as Record<string, unknown>) : {};
  return { entity_id: id, name: str(attributes.friendly_name) || id, domain: id.split(".")[0] ?? "", state: str(s.state), unit: str(attributes.unit_of_measurement), device_class: str(attributes.device_class), last_changed: str(s.last_changed), attributes: attrsText(attributes) };
}

type Row = ReturnType<typeof entityRow>;

/** A8.4: the value format a sensor's unit maps to. A unit the formats do not cover stays as the unit. */
function sensorFormat(unit: string): { format: ValueFormat; unit?: string } {
  if (unit === "°C" || unit === "C") return { format: "celsius" };
  if (unit === "%") return { format: "percent" };
  if (unit === "s") return { format: "seconds" };
  if (unit === "B") return { format: "bytes" };
  return { format: "number", ...(unit ? { unit } : {}) };
}

/** Entities whose state is a number (sensors, numbers, inputs), with what the number means. */
function sensorRows(rows: Row[]) {
  return rows
    .filter((r) => r.state.trim() !== "" && Number.isFinite(Number(r.state)))
    .map((r) => ({ entity_id: r.entity_id, name: r.name, value: Number(r.state), unit: r.unit, device_class: r.device_class, detail: `${r.state}${r.unit ? ` ${r.unit}` : ""} · ${r.entity_id}` }))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}

const SENSOR_COLUMNS = [
  { key: "name", label: "Name", type: "text" as const },
  { key: "entity_id", label: "Entity", type: "text" as const },
  { key: "value", label: "Value", type: "number" as const },
  { key: "unit", label: "Unit", type: "text" as const },
  { key: "device_class", label: "Kind", type: "text" as const },
  { key: "detail", label: "Detail", type: "text" as const },
];

function stateMark(state: string): "up" | "down" | "unknown" {
  if (UP.has(state)) return "up";
  if (DOWN.has(state)) return "down";
  return "unknown";
}

function entityParam(params: Record<string, unknown>): string {
  const id = str(params.entityId).trim();
  if (!id) fail("config", 'The "entityId" parameter is required for this endpoint.');
  if (!ENTITY.test(id)) fail("config", `"${id}" is not an entity id.`, "Entity ids look like light.living_room.");
  return id;
}

/** One service call. The entity id is re-checked against the command's domain before anything is sent. */
function service(domain: string, name: string, extra?: (p: Record<string, unknown>) => Record<string, unknown>): CommandFn {
  return async (ctx, params) => {
    const id = str(params.entityId);
    if (!id.startsWith(`${domain}.`) || !ENTITY.test(id)) fail("config", `"${id}" is not a ${domain} entity.`, `Pick a ${domain} entity.`);
    await sendCommand(ctx, { path: `api/services/${domain}/${name}`, method: "POST", body: { entity_id: id, ...(extra ? extra(params) : {}) }, ...TOKEN });
    return { message: "Done" };
  };
}

function lightOptions(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof p.brightnessPct === "number") out.brightness_pct = p.brightnessPct;
  if (typeof p.colorTempK === "number") out.color_temp_kelvin = p.colorTempK;
  if (Array.isArray(p.rgb)) out.rgb_color = p.rgb;
  return out;
}

const AREAS_TEMPLATE = "{% set ns = namespace(a=[]) %}{% for id in areas() %}{% set ns.a = ns.a + [{'id': id, 'name': area_name(id)}] %}{% endfor %}{{ ns.a | tojson }}";

export default defineAdapter({
  async health(ctx) {
    const c = obj(await getJson(ctx, "api/config", TOKEN), "configuration");
    const version = str(c.version);
    return { status: "ok", ...(version ? { version } : {}) };
  },
  reads: {
    async states(ctx, params) {
      const domain = str(params.domain).trim();
      const area = str(params.area).trim();
      if (domain && !DOMAIN.test(domain)) fail("config", `"${domain}" is not a domain.`, "Domains look like light, switch or sensor.");
      // Template injection guard: the area goes into a template only after this check.
      if (area && !AREA.test(area)) fail("config", `"${area}" is not an area id.`, "Area ids use lowercase letters, numbers and underscores, such as living_room.");
      let rows = arr(await getJson(ctx, "api/states", TOKEN), "entity list").map(entityRow);
      if (domain) rows = rows.filter((r) => r.domain === domain);
      if (area) {
        const ids = new Set(arr(await template(ctx, `{{ area_entities('${area}') | tojson }}`), "area entity list").map((x) => str(x)));
        rows = rows.filter((r) => ids.has(r.entity_id));
      }
      rows.sort((a, b) => a.entity_id.localeCompare(b.entity_id));
      return {
        data: {
          kind: "table",
          columns: [
            { key: "entity_id", label: "Entity", type: "text" },
            { key: "name", label: "Name", type: "text" },
            { key: "domain", label: "Domain", type: "text" },
            { key: "state", label: "State", type: "text" },
            { key: "unit", label: "Unit", type: "text" },
            { key: "device_class", label: "Kind", type: "text" },
            { key: "attributes", label: "Attributes", type: "text" },
          ],
          rows: rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "last_changed"))),
          total: rows.length,
        },
      };
    },
    async sensors(ctx) {
      const rows = sensorRows(arr(await getJson(ctx, "api/states", TOKEN), "entity list").map(entityRow));
      return { data: { kind: "table", columns: SENSOR_COLUMNS, rows, total: rows.length } };
    },
    async sensor(ctx, params) {
      const raw = str(params.entityId).trim();
      if (raw === "*") return { data: { kind: "table", columns: SENSOR_COLUMNS, rows: sensorRows(arr(await getJson(ctx, "api/states", TOKEN), "entity list").map(entityRow)) } };
      const id = entityParam(params);
      const e = entityRow(await getJson(ctx, `api/states/${id}`, TOKEN));
      const n = Number(e.state);
      if (e.state.trim() === "" || !Number.isFinite(n)) fail("bad_response", `${e.name} is "${e.state.slice(0, 40)}" right now, not a number.`, e.state === "unavailable" || e.state === "unknown" ? "Home Assistant cannot reach this device at the moment." : "Pick a sensor that reports a number, or use One entity.");
      return { data: { kind: "stat", value: n, label: e.name, ...sensorFormat(e.unit) } };
    },
    async unavailable(ctx) {
      const rows = arr(await getJson(ctx, "api/states", TOKEN), "entity list").map(entityRow)
        .filter((r) => r.state === "unavailable" || r.state === "unknown")
        .map((r) => ({ name: r.name, entity_id: r.entity_id, domain: r.domain, state: r.state === "unknown" ? "warn" : "down", since: r.last_changed }))
        .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
      return {
        data: {
          kind: "table",
          columns: [{ key: "name", label: "Name", type: "text" }, { key: "entity_id", label: "Entity", type: "text" }, { key: "domain", label: "Domain", type: "text" }, { key: "state", label: "State", type: "status" }, { key: "since", label: "Since", type: "time" }],
          rows,
          total: rows.length,
        },
      };
    },
    async entity(ctx, params) {
      const id = entityParam(params);
      const e = entityRow(await getJson(ctx, `api/states/${id}`, TOKEN));
      return { data: { kind: "status", items: [{ label: e.name, state: stateMark(e.state), detail: e.state }] } };
    },
    async history(ctx, params) {
      const id = entityParam(params);
      const h = num(params.hours) ?? 24;
      if (h < 1 || h > 168) fail("config", 'The "hours" parameter must be between 1 and 168.');
      const start = new Date(ctx.now().getTime() - h * 3600_000).toISOString();
      const raw = arr(await getJson(ctx, `api/history/period/${start}`, { ...TOKEN, query: { filter_entity_id: id, minimal_response: "1" } }), "history");
      const list = Array.isArray(raw[0]) ? (raw[0] as unknown[]) : [];
      const points: [number, number | null][] = [];
      for (const p of list) {
        const o = obj(p, "history point");
        const s = str(o.state);
        const v = s === "on" ? 1 : s === "off" ? 0 : num(s);
        const t = Date.parse(str(o.last_changed) || str(o.last_updated));
        if (v === null || Number.isNaN(t)) continue;
        points.push([t, v]);
      }
      return { data: { kind: "series", series: [{ name: id, points }] } };
    },
    async areas(ctx) {
      const rows = arr(await template(ctx, AREAS_TEMPLATE), "area list").map((a) => {
        const o = obj(a, "area");
        return { id: str(o.id), name: str(o.name) || str(o.id) };
      });
      return { data: { kind: "table", columns: [{ key: "id", label: "Id", type: "text" }, { key: "name", label: "Name", type: "text" }], rows, total: rows.length } };
    },
  },
  commands: {
    "light.turn_on": service("light", "turn_on", lightOptions),
    "light.turn_off": service("light", "turn_off"),
    "light.toggle": service("light", "toggle"),
    "switch.turn_on": service("switch", "turn_on"),
    "switch.turn_off": service("switch", "turn_off"),
    "switch.toggle": service("switch", "toggle"),
    "scene.turn_on": service("scene", "turn_on"),
    "script.turn_on": service("script", "turn_on"),
  },
});
