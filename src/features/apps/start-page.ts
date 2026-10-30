// Start page from your services (direct-data-spec.md 3.7; Amendment 10, A10.8; Wave 2.10b F1). One
// DraftChange built from existing ops, on a new page or the current empty one, in the spec's order:
// (1) Machines: one health row (CPU, memory and disk as bars, uptime) for every machine a picked service
//     reports, as a "card for each" over that service's "every machine" read, so a new machine shows up
//     with no edit. With no machine-reporting service, a resource bar for the Atrium host, as before.
// (2) Services: one group per service kind in a fixed order, a service tile per integration (icon, name,
//     address, status from atrium/health, headline stats as managed sources).
// (3) Charts: "CPU, every machine, last 6 h", and "Network in, every machine" when that read exists.
// (4) Links: a group of link tiles with atrium/reach status.
// Pure: the caller gathers what each service is.
import type { AppDocument, ComponentNode, DraftOp, PageDoc, PropValue, ServiceKind, ValueFormat } from "@/core/contracts";
import { ensureManaged, type ManagedWant } from "./managed";
import { tileOps, type ReadInfo, type TileService } from "@/features/builder/direct-data";
import { newId, slugify } from "./doc";

export const KIND_ORDER: ServiceKind[] = ["containers", "media", "monitoring", "network", "smart-home", "storage", "other"];
export const KIND_TITLES: Record<ServiceKind, string> = { containers: "Containers", media: "Media", monitoring: "Monitoring", network: "Network", "smart-home": "Smart home", storage: "Storage", other: "Other" };

export type StartService = TileService & { kind: ServiceKind };
/** One reading of the resource bar: a read of the machine (or the host), its words and look. */
export type BarItem = { endpointId: string; params: Record<string, PropValue>; label: string; icon: string; format?: ValueFormat; percent: boolean; readLabel: string; defaultRefreshSec: number; minRefreshSec: number; /** The read's params schema, so defaults drop out and the source is shared with other picks. */ schema?: Record<string, unknown> };
/** A read the start page binds: which endpoint, its params and timing (the managed source's want). */
export type StartRead = { endpointId: string; params?: Record<string, PropValue>; label: string; defaultRefreshSec: number; minRefreshSec: number; schema?: Record<string, unknown> };
/**
 * F1: a service that reports every machine. `rows` is a table read with one row per machine and the
 * columns name, cpu, memory, disk (percent) and uptime (seconds); `history` a series read of one measure
 * across every machine (params get the measure and hours).
 */
export type MachineSource = { integrationId: string; serviceName: string; rows: StartRead; history?: StartRead & { measures: string[] } };
export type StartPlan = {
  services: StartService[];
  links: { name: string; href: string }[];
  bar: { integrationId: string; thingLabel: string; items: BarItem[] };
  info: ReadInfo;
  /** F1: machine-reporting services among the ones picked (none: the bar shows the Atrium host). */
  machines?: MachineSource[];
};

/** Rows of the 8 px grid one tile takes inside a group (icon, name, line, stats), and a group's title. */
export const TILE_ROWS = 13;
export const GROUP_HEAD_ROWS = 6;
export const BAR_ROWS = 8;
export const GROUPS_PER_ROW = 4;
/** F1: rows of one machine's health card (title bar and one resource bar line), and the chart's box. */
export const MACHINE_ROWS = 22;
export const MACHINE_COLUMNS = 2;
/** The first guess at how many machines there are; the box grows to the real number (fit, A11.2). */
export const MACHINE_GUESS = 4;
export const CHART_ROWS = 44;

/** The page the start page goes on: the first empty page (home first), or a new "Start" page. */
export function startPageTarget(doc: AppDocument): { page: PageDoc; add: boolean } {
  const ordered = [doc.app.homePage, ...doc.app.pageOrder].map((id) => doc.pages.find((p) => p.id === id)).filter((p): p is PageDoc => !!p);
  const empty = ordered.find((p) => !(p.root.children ?? []).length);
  if (empty) return { page: empty, add: false };
  const taken = new Set(doc.pages.map((p) => p.slug));
  let slug = "start";
  for (let n = 2; taken.has(slug); n++) slug = `start-${n}`;
  return { page: { id: newId("p"), slug, title: "Start", inNav: true, root: { id: newId("c"), type: "grid", props: {}, children: [] } }, add: true };
}

/**
 * The ops for a start page (A10.8), in one batch. `random` makes generated source names repeatable in tests.
 * Returns the page id it fills and the node ids of the bar and the groups (in page order).
 */
export function startPageOps(doc: AppDocument, plan: StartPlan, opts: { random?: () => number; makeId?: (p: "c") => string } = {}): { ops: DraftOp[]; pageId: string; nodes: string[] } {
  const makeId = opts.makeId ?? ((p: "c") => newId(p));
  const { page, add } = startPageTarget(doc);
  const cols = page.root.props.columns === 6 || page.root.props.columns === 24 ? (page.root.props.columns as number) : 12;
  const ops: DraftOp[] = [];
  const taken: string[] = [];
  const sources = { dataSources: [...doc.dataSources] };
  const remember = (more: DraftOp[]) => { for (const o of more) if (o.op === "source.set") { sources.dataSources.push(o.source); taken.push(o.source.name); } ops.push(...more); };
  const children: ComponentNode[] = [];

  const managed = (integrationId: string, r: StartRead, label = r.label) => {
    const w: ManagedWant = { integrationId, endpointId: r.endpointId, ...(r.params ? { params: r.params } : {}), label, defaultRefreshSec: r.defaultRefreshSec, minRefreshSec: r.minRefreshSec, ...(r.schema ? { schema: r.schema } : {}) };
    const m = ensureManaged(sources, w, { ...(opts.random ? { random: opts.random } : {}), taken });
    remember(m.ops);
    return m.name;
  };
  let y = 0;
  const machines = plan.machines ?? [];
  if (machines.length) {
    // (1) Machines: a health card for each machine each service reports (F1).
    for (const ms of machines) {
      const src = managed(ms.integrationId, ms.rows, machines.length > 1 ? `${ms.rows.label}, ${ms.serviceName}` : ms.rows.label);
      const h = Math.ceil(MACHINE_GUESS / MACHINE_COLUMNS) * MACHINE_ROWS;
      children.push(machineRows(makeId, src, { x: 0, y, w: cols, h }, machines.length > 1 ? `Machines, ${ms.serviceName}` : "Machines"));
      y += h;
    }
  } else {
    // No machine-reporting service: the resource bar for the Atrium host (or the one machine asked for).
    const items: PropValue[] = [];
    for (const it of plan.bar.items.slice(0, 8)) {
      const name = managed(plan.bar.integrationId, { endpointId: it.endpointId, params: it.params, label: it.readLabel, defaultRefreshSec: it.defaultRefreshSec, minRefreshSec: it.minRefreshSec, ...(it.schema ? { schema: it.schema } : {}) }, `${it.readLabel}, ${plan.bar.thingLabel}`);
      items.push({ icon: it.icon, label: it.label, value: { $bind: `{{ ${name} }}` }, ...(it.percent ? { percent: { $bind: `{{ ${name}.value }}` } } : {}), ...(it.format ? { format: it.format } : {}) });
    }
    children.push({ id: makeId("c"), type: "resource-bar", name: "Resource bar", props: { items, clock: true, clockFormat: "date-time", search: true }, slot: { x: 0, y, w: cols, h: BAR_ROWS } });
    y += BAR_ROWS;
  }

  // Groups by kind, in the fixed order, then Links.
  const groups: { title: string; tiles: ComponentNode[] }[] = [];
  for (const kind of KIND_ORDER) {
    const list = plan.services.filter((s) => s.kind === kind);
    if (!list.length) continue;
    const tiles = list.map((s) => {
      const t = tileOps(sources, s, plan.info, { ...(opts.random ? { random: opts.random } : {}), taken });
      remember(t.ops);
      return { id: makeId("c"), type: "service-tile", name: s.name.slice(0, 60), props: t.props } as ComponentNode;
    });
    groups.push({ title: KIND_TITLES[kind], tiles });
  }
  const linkGroups: typeof groups = [];
  if (plan.links.length) {
    const tiles = plan.links.map((l) => {
      const t = tileOps(sources, { link: l }, plan.info, { ...(opts.random ? { random: opts.random } : {}), taken });
      remember(t.ops);
      return { id: makeId("c"), type: "service-tile", name: l.name.slice(0, 60), props: t.props } as ComponentNode;
    });
    // With machine rows and charts between them, links get their own row after the charts (spec F1 (4)).
    (machines.length ? linkGroups : groups).push({ title: "Links", tiles });
  }
  // Groups sit side by side, up to four across, as Homepage lays them out (reference 2).
  // F1: under full-width machine rows the groups are at most three across, so tile names have room.
  const perRow = machines.length ? 3 : GROUPS_PER_ROW;
  const layGroups = (list: typeof groups) => {
    for (let i = 0; i < list.length; i += perRow) {
      const row = list.slice(i, i + perRow);
      const w = cols / Math.max(row.length, Math.min(perRow, list.length));
      const h = GROUP_HEAD_ROWS + Math.max(...row.map((g) => g.tiles.length)) * TILE_ROWS;
      row.forEach((g, j) => {
        children.push({ id: makeId("c"), type: "group", name: g.title, props: { title: g.title, columns: 1, collapsible: false }, slot: { x: j * w, y, w, h }, children: g.tiles });
      });
      y += h;
    }
  };
  layGroups(groups);
  // (3) Charts: CPU on every machine over 6 hours, and network in beside it when the read has it.
  const charts: { title: string; measure: string; ms: MachineSource }[] = [];
  const hist = machines.find((m) => m.history);
  if (hist?.history) {
    if (hist.history.measures.includes("cpu")) charts.push({ title: "CPU, every machine, last 6 h", measure: "cpu", ms: hist });
    if (hist.history.measures.includes("netIn")) charts.push({ title: "Network in, every machine, last 6 h", measure: "netIn", ms: hist });
  }
  if (charts.length) {
    const w = cols / charts.length;
    charts.forEach((c, j) => {
      const r = c.ms.history!;
      const name = managed(c.ms.integrationId, { ...r, params: { ...(r.params ?? {}), measure: c.measure, hours: 6 } }, c.title);
      children.push({ id: makeId("c"), type: "chart", name: c.title, title: c.title, showTitle: true, props: { data: { $bind: `{{ ${name} }}` }, kind: "line", height: 220 }, slot: { x: j * w, y, w, h: CHART_ROWS } });
    });
    y += CHART_ROWS;
  }
  layGroups(linkGroups);

  if (add) {
    ops.push({ op: "page.add", page: { ...page, root: { ...page.root, children } } });
  } else {
    children.forEach((c, i) => ops.push({ op: "node.add", parentId: page.root.id, index: i, node: c }));
  }
  return { ops, pageId: page.id, nodes: children.map((c) => c.id) };
}

/**
 * F1: a health row for every machine a read reports: a "card for each" (a fit repeat, A11.2) whose card is
 * titled with the machine's name and holds a resource bar with CPU, memory and disk as bars and uptime.
 */
export function machineRows(makeId: (p: "c") => string, source: string, slot: { x: number; y: number; w: number; h: number }, name = "Machines"): ComponentNode {
  const pct = (key: string, label: string, icon: string): PropValue => ({ icon, label, value: { $bind: `{{ $item.${key} }}` }, percent: { $bind: `{{ $item.${key} }}` }, format: "percent" });
  const bar: ComponentNode = {
    id: makeId("c"), type: "resource-bar", name: "Health of this machine",
    props: { items: [pct("cpu", "CPU", "cpu"), pct("memory", "Memory", "memory"), pct("disk", "Disk", "disk"), { icon: "clock", label: "Up", value: { $bind: "{{ $item.uptime }}" }, format: "seconds" }], clock: false, search: false },
  };
  const card: ComponentNode = { id: makeId("c"), type: "card", name: "Card for each machine", props: { title: { $bind: "{{ $item.name }}" }, padded: true }, children: [bar] };
  return { id: makeId("c"), type: "repeat", name, props: { items: { $bind: `{{ ${source}.rows }}` }, columns: MACHINE_COLUMNS, gap: 12, max: 50, empty: "No machines reported yet" }, slot, children: [card] };
}

/** "jellyfin" from "Jellyfin (Media)": a plain link's tile name, from its address when none was given. */
export function linkName(name: string, href: string): string {
  const n = name.trim();
  if (n) return n.slice(0, 80);
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return slugify(href) || "Link";
  }
}

/** An http or https address with no credentials, or null (the link tile's address, A10.6). */
export function cleanLink(href: string): string | null {
  const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(href.trim()) ? href.trim() : `http://${href.trim()}`;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    return u.toString().slice(0, 2000);
  } catch {
    return null;
  }
}
