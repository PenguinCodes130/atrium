// The server half of the start page (A10.8): what each picked service is (name, icon, kind, address,
// headline stats, from integrations' service information), which reads give the resource bar its CPU,
// memory, disk and uptime, and the one DraftChange that makes the page. The route and the
// apps.startPage agent tool both come here; neither ever sees config or secrets.
import "server-only";
import type { App, DraftOp, PageDoc, Principal, PropValue, StartPageRequest, ValueFormat } from "@/core/contracts";
import { FieldError } from "./errors";
import { canBindReads } from "@/features/integrations/commands";
import { getIntegrationRow, SYSTEM_INTEGRATION_ID } from "@/features/integrations/repo";
import { endpointsOf, getPackage, getRegistry } from "@/features/integrations/runtime";
import { serviceInfoOf } from "@/features/integrations/service-info";
import { measureOf } from "@/features/data/measure";
import { choicesSpecs } from "@/features/integrations/choices";
import * as repo from "./repo";
import { appForEditor, applyDraftOps } from "./service";
import { cleanLink, linkName, startPageOps, type BarItem, type MachineSource, type StartPlan, type StartService } from "./start-page";

/**
 * F1: the "every machine" reads of each package, by endpoint id: a table with one row per machine
 * (name, cpu, memory, disk, uptime) and a series of one measure across every machine. Prometheus has both
 * (node-exporter recipes). Proxmox has no such read yet (its "nodes" read is up/down only): listed as an
 * interface request in the Wave 2.10b layout report, and picked up here by id once it exists.
 */
const MACHINE_READS: Record<string, { rows: string; history?: string }> = {
  prometheus: { rows: "machines-overview", history: "machines-history" },
  proxmox: { rows: "nodes-overview" },
};

export const MAX_START_SERVICES = 40;
export const MAX_START_LINKS = 40;

const BAR_MEASURES: { measure: "cpu" | "memory" | "disk" | "uptime"; label: string; icon: string; percent: boolean }[] = [
  { measure: "cpu", label: "CPU", icon: "cpu", percent: true },
  { measure: "memory", label: "Memory", icon: "memory", percent: true },
  { measure: "disk", label: "Disk", icon: "disk", percent: true },
  { measure: "uptime", label: "Up", icon: "clock", percent: false },
];

export type StartInput = StartPageRequest & { machine?: StartPageRequest["machine"] & { label?: string } };

/** Reads the request body loosely: ids and links as sent, junk dropped. */
export function parseStartInput(b: Record<string, unknown>): StartInput {
  const ids = Array.isArray(b.integrationIds) ? [...new Set(b.integrationIds.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 100))] : [];
  const links = Array.isArray(b.links) ? b.links.flatMap((l) => (l && typeof l === "object" && typeof (l as { href?: unknown }).href === "string" ? [{ name: String((l as { name?: unknown }).name ?? "").slice(0, 80), href: (l as { href: string }).href.slice(0, 2000) }] : [])) : [];
  const m = b.machine as { integrationId?: unknown; thing?: unknown; label?: unknown } | undefined;
  const machine = m && typeof m.integrationId === "string" && typeof m.thing === "string" ? { integrationId: m.integrationId, thing: m.thing, ...(typeof m.label === "string" ? { label: m.label.slice(0, 80) } : {}) } : undefined;
  if (ids.length > MAX_START_SERVICES) throw new FieldError("integrationIds", `A start page can hold at most ${MAX_START_SERVICES} services.`);
  if (links.length > MAX_START_LINKS) throw new FieldError("links", `A start page can hold at most ${MAX_START_LINKS} links.`);
  return { integrationIds: ids, links, ...(machine ? { machine } : {}) };
}

/** Everything the pure builder needs, for one person: only services they may bind are used. */
export function planStartPage(p: Principal, input: StartInput): StartPlan {
  getRegistry(); // the built-in Atrium integration exists from here on
  const rows = new Map<string, ReturnType<typeof getIntegrationRow>>();
  const rowOf = (id: string) => { if (!rows.has(id)) rows.set(id, getIntegrationRow(id)); return rows.get(id); };
  const usable = (id: string) => { const r = rowOf(id); return r && r.status === "active" && canBindReads(p, r) ? r : undefined; };
  const services: StartService[] = [];
  for (const id of input.integrationIds) {
    if (id === SYSTEM_INTEGRATION_ID) continue;
    const row = usable(id);
    if (!row) continue;
    const manifest = getPackage(row.packageId)?.manifest;
    const info = serviceInfoOf(row, manifest);
    const pkgName = manifest?.name ?? "";
    services.push({ integrationId: row.id, name: row.name, packageId: row.packageId, kind: info.kind, headline: info.headline, ...(info.openUrl ? { openUrl: info.openUrl } : {}), ...(pkgName && pkgName !== row.name ? { description: pkgName } : {}) });
  }
  const links: StartPlan["links"] = [];
  for (const l of input.links) {
    const href = cleanLink(l.href);
    if (!href) throw new FieldError("links", `"${l.href}" is not an http or https address.`);
    links.push({ name: linkName(l.name, href), href });
  }
  const info: StartPlan["info"] = (integrationId, endpointId) => {
    const row = rowOf(integrationId);
    const ep = row ? endpointsOf(row).find((e) => e.id === endpointId) : undefined;
    return ep ? { label: ep.label, shape: ep.shape, defaultRefreshSec: ep.defaultRefreshSec, minRefreshSec: ep.minRefreshSec } : null;
  };
  return { services, links, bar: barFor(p, input, usable), info, machines: machinesFor(input.integrationIds, usable, services) };
}

/** F1: every picked service with an "every machine" read, in the order picked. */
function machinesFor(ids: string[], usable: (id: string) => ReturnType<typeof getIntegrationRow>, services: StartService[]): MachineSource[] {
  const out: MachineSource[] = [];
  for (const id of ids) {
    const row = id === SYSTEM_INTEGRATION_ID ? undefined : usable(id);
    const want = row ? MACHINE_READS[row.packageId] : undefined;
    if (!row || !want) continue;
    const eps = endpointsOf(row);
    const rows = eps.find((e) => e.id === want.rows && e.shape === "table");
    if (!rows) continue;
    const hist = want.history ? eps.find((e) => e.id === want.history && e.shape === "series") : undefined;
    const measures = ((hist?.params as { properties?: { measure?: { enum?: unknown[] } } } | undefined)?.properties?.measure?.enum ?? []).filter((m): m is string => typeof m === "string");
    const read = (e: NonNullable<typeof rows>) => ({ endpointId: e.id, label: e.label, defaultRefreshSec: e.defaultRefreshSec, minRefreshSec: e.minRefreshSec, ...(e.params ? { schema: e.params as Record<string, unknown> } : {}) });
    out.push({ integrationId: row.id, serviceName: services.find((x) => x.integrationId === row.id)?.name ?? row.name, rows: read(rows), ...(hist ? { history: { ...read(hist), measures } } : {}) });
  }
  return out;
}

/** The resource bar's readings: the machine's CPU, memory, disk and uptime reads, or the Atrium host's. */
function barFor(p: Principal, input: StartInput, usable: (id: string) => ReturnType<typeof getIntegrationRow>): StartPlan["bar"] {
  const m = input.machine;
  const row = m ? usable(m.integrationId) : undefined;
  if (m && row) {
    const eps = endpointsOf(row).filter((e) => !e.advanced && !e.id.startsWith("h:") && e.shape === "stat");
    const items: BarItem[] = [];
    for (const want of BAR_MEASURES) {
      // The first plain read of this measure that takes one thing from a live list (the machine).
      const ep = eps.find((e) => measureOf(e) === want.measure && Object.keys(choicesSpecs(e.params)).length > 0);
      if (!ep) continue;
      const param = Object.keys(choicesSpecs(ep.params))[0]!;
      items.push({ endpointId: ep.id, params: { [param]: m.thing }, label: want.label, icon: want.icon, percent: want.percent, readLabel: ep.label, defaultRefreshSec: ep.defaultRefreshSec, minRefreshSec: ep.minRefreshSec, ...(ep.params ? { schema: ep.params } : {}) });
    }
    return { integrationId: row.id, thingLabel: m.label ?? m.thing, items };
  }
  // The Atrium host itself (A10.6 `host`), when the built-in integration is there.
  const sys = getIntegrationRow(SYSTEM_INTEGRATION_ID);
  const host = sys ? endpointsOf(sys).find((e) => e.id === "host") : undefined;
  if (!sys || !host) return { integrationId: SYSTEM_INTEGRATION_ID, thingLabel: "this server", items: [] };
  return {
    integrationId: SYSTEM_INTEGRATION_ID,
    thingLabel: "this server",
    items: BAR_MEASURES.map((w) => ({ endpointId: "host", params: { measure: w.measure } as Record<string, PropValue>, label: w.label, icon: w.icon, percent: w.percent, readLabel: w.label === "Up" ? "Uptime" : w.label, defaultRefreshSec: host.defaultRefreshSec, minRefreshSec: host.minRefreshSec, ...(host.params ? { schema: host.params } : {}), ...(w.measure === "uptime" ? { format: "seconds" as ValueFormat } : {}) })),
  };
}

/** The ops for this app's draft, without applying them (the builder applies them as one undoable edit). */
export function startPagePlanOps(p: Principal, app: App, input: StartInput): { ops: DraftOp[]; pageId: string; nodes: string[]; page: PageDoc | null } {
  const draft = repo.getDraft(app.id);
  if (!draft) throw new FieldError("app", "This app has no draft.", 404);
  const plan = planStartPage(p, input);
  if (!plan.services.length && !plan.links.length) throw new FieldError("integrationIds", "Tick at least one service, or add a link.");
  const r = startPageOps(draft.doc, plan);
  return { ...r, page: null };
}

/** POST /api/apps/:id/start-page and apps.startPage: one DraftChange, summary "Start page" (A10.8). */
export function makeStartPage(p: Principal, appId: string, input: StartInput, opts: { plan?: boolean; expectRev?: number } = {}): { ops?: DraftOp[]; rev?: number; pageId: string; nodes: string[] } {
  const app = appForEditor(p, appId);
  const planned = startPagePlanOps(p, app, input);
  if (opts.plan) return { ops: planned.ops, pageId: planned.pageId, nodes: planned.nodes };
  const r = applyDraftOps({ appId: app.id, ops: planned.ops, by: p, summary: "Start page", ...(opts.expectRev !== undefined ? { expectRev: opts.expectRev } : {}) });
  return { rev: r.rev, pageId: planned.pageId, nodes: planned.nodes };
}
