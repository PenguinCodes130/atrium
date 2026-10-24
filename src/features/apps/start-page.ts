// Start page from your services (direct-data-spec.md 3.7; Amendment 10, A10.8). One DraftChange built
// from existing ops: a page (or the current empty page) with a resource bar for a machine (or the Atrium
// host), then one group per service kind in a fixed order, each with a service tile per integration
// (icon, name, address, status from atrium/health, headline stats as managed sources), then a Links group
// of link tiles with atrium/reach status. Pure: the caller gathers what each service is.
import type { AppDocument, ComponentNode, DraftOp, PageDoc, PropValue, ServiceKind, ValueFormat } from "@/core/contracts";
import { ensureManaged, type ManagedWant } from "./managed";
import { tileOps, type ReadInfo, type TileService } from "@/features/builder/direct-data";
import { newId, slugify } from "./doc";

export const KIND_ORDER: ServiceKind[] = ["containers", "media", "monitoring", "network", "smart-home", "storage", "other"];
export const KIND_TITLES: Record<ServiceKind, string> = { containers: "Containers", media: "Media", monitoring: "Monitoring", network: "Network", "smart-home": "Smart home", storage: "Storage", other: "Other" };

export type StartService = TileService & { kind: ServiceKind };
/** One reading of the resource bar: a read of the machine (or the host), its words and look. */
export type BarItem = { endpointId: string; params: Record<string, PropValue>; label: string; icon: string; format?: ValueFormat; percent: boolean; readLabel: string; defaultRefreshSec: number; minRefreshSec: number; /** The read's params schema, so defaults drop out and the source is shared with other picks. */ schema?: Record<string, unknown> };
export type StartPlan = {
  services: StartService[];
  links: { name: string; href: string }[];
  bar: { integrationId: string; thingLabel: string; items: BarItem[] };
  info: ReadInfo;
};

/** Rows of the 8 px grid one tile takes inside a group (icon, name, line, stats), and a group's title. */
export const TILE_ROWS = 13;
export const GROUP_HEAD_ROWS = 6;
export const BAR_ROWS = 8;
export const GROUPS_PER_ROW = 4;

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

  // The resource bar: one managed source per reading.
  const items: PropValue[] = [];
  for (const it of plan.bar.items.slice(0, 8)) {
    const w: ManagedWant = { integrationId: plan.bar.integrationId, endpointId: it.endpointId, params: it.params, label: `${it.readLabel}, ${plan.bar.thingLabel}`, defaultRefreshSec: it.defaultRefreshSec, minRefreshSec: it.minRefreshSec, ...(it.schema ? { schema: it.schema } : {}) };
    const m = ensureManaged(sources, w, { ...(opts.random ? { random: opts.random } : {}), taken });
    remember(m.ops);
    items.push({ icon: it.icon, label: it.label, value: { $bind: `{{ ${m.name} }}` }, ...(it.percent ? { percent: { $bind: `{{ ${m.name}.value }}` } } : {}), ...(it.format ? { format: it.format } : {}) });
  }
  let y = 0;
  const bar: ComponentNode = { id: makeId("c"), type: "resource-bar", name: "Resource bar", props: { items, clock: true, clockFormat: "date-time", search: true }, slot: { x: 0, y, w: cols, h: BAR_ROWS } };
  children.push(bar);
  y += BAR_ROWS;

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
  if (plan.links.length) {
    const tiles = plan.links.map((l) => {
      const t = tileOps(sources, { link: l }, plan.info, { ...(opts.random ? { random: opts.random } : {}), taken });
      remember(t.ops);
      return { id: makeId("c"), type: "service-tile", name: l.name.slice(0, 60), props: t.props } as ComponentNode;
    });
    groups.push({ title: "Links", tiles });
  }
  // Groups sit side by side, up to four across, as Homepage lays them out (reference 2).
  for (let i = 0; i < groups.length; i += GROUPS_PER_ROW) {
    const row = groups.slice(i, i + GROUPS_PER_ROW);
    const w = cols / Math.max(row.length, Math.min(GROUPS_PER_ROW, groups.length));
    const h = GROUP_HEAD_ROWS + Math.max(...row.map((g) => g.tiles.length)) * TILE_ROWS;
    row.forEach((g, j) => {
      children.push({ id: makeId("c"), type: "group", name: g.title, props: { title: g.title, columns: 1, collapsible: false }, slot: { x: j * w, y, w, h }, children: g.tiles });
    });
    y += h;
  }

  if (add) {
    ops.push({ op: "page.add", page: { ...page, root: { ...page.root, children } } });
  } else {
    children.forEach((c, i) => ops.push({ op: "node.add", parentId: page.root.id, index: i, node: c }));
  }
  return { ops, pageId: page.id, nodes: children.map((c) => c.id) };
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
