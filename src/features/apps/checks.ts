// Server checks on draft operations and on whole documents (architecture v3 sections 4.9, 6.2 and
// 9b "validate"; amendment A1.4). The structural rules live in ops.ts; here are the ones that need
// the component definitions, the integrations and the cache.
import "server-only";
import type { AppDocument, CommandDef, ComponentNode, ControlDef, DataSourceDef, Principal, Problem } from "@/core/contracts";
import { canBindCommands, canBindReads, commandCatalog, listCommands } from "@/features/integrations/commands";
import { getIntegrationRow } from "@/features/integrations/repo";
import { endpointsOf, getPackage } from "@/features/integrations/runtime";
import { targetParams } from "@/features/controls/input";
import { cachedWidgetData } from "@/features/data/runtime";
import { canvasThemeCssWithReport, compileChromeCss, compileNodeCss, getComponentDef, libraryForDoc, validateNodes } from "./deps";
import { allNodes, controlsOfNode, findPage, isBinding, orderedPages, RESERVED_PAGE_SLUGS, SLUG_PATTERN, unmappedPackage, walk } from "./doc";
import { SOURCE_NAME, type OpChecks } from "./ops";
import { missingParams, unsentParams } from "./control-params";
import { reviewWarnings } from "./review-warnings";
import { checksMap } from "@/features/recipes/repo";

const ATRIUM_REFRESH_FLOOR = 5;

function err(code: string, message: string, where: Problem["where"] = {}, fix?: string): Problem {
  return { severity: "error", code, where, message, ...(fix ? { fix } : {}) };
}
function warn(code: string, message: string, where: Problem["where"] = {}, fix?: string): Problem {
  return { severity: "warning", code, where, message, ...(fix ? { fix } : {}) };
}

/** The display name of a package ("Docker", "Proxmox VE"), or the id when the package is unknown. */
export function packageTitle(packageId: string): string {
  try {
    return getPackage(packageId)?.manifest.name ?? packageId;
  } catch {
    return packageId;
  }
}

/** "No data: connect Docker" for a source whose integration was skipped (gauntlet w2-r1 item 2). */
export function unmappedMessage(packageId: string): string {
  return `No data: connect ${packageTitle(packageId)}`;
}

/** A data source: the integration exists, the principal may bind its reads, the endpoint exists, the interval is allowed. */
export function checkSource(s: DataSourceDef, p: Principal | null): Problem[] {
  const pkg = unmappedPackage(s.integrationId);
  if (pkg) {
    const title = packageTitle(pkg);
    return [warn("source.unmapped", `${s.name} shows "No data" until you connect ${title}.`, { field: "integrationId" }, `Add a ${title} integration, then pick it for ${s.name} under App data sources.`)];
  }
  const row = getIntegrationRow(s.integrationId);
  if (!row) return [err("source.unknown_integration", `The integration for data source ${s.name} no longer exists.`, { field: "integrationId" }, "Pick another integration, or remove the data source.")];
  if (p && !canBindReads(p, row)) return [err("source.not_allowed", `You cannot use ${row.name} in apps: it is not shared with you.`, { field: "integrationId" })];
  const ep = endpointsOf(row).find((e) => e.id === s.endpointId);
  if (!ep) return [err("source.unknown_endpoint", `${row.name} has no endpoint "${s.endpointId}".`, { field: "endpointId" })];
  const min = Math.max(ep.minRefreshSec, ATRIUM_REFRESH_FLOOR);
  // A11.8: 0 is Off, read once per page open; the read's minimum still spaces those reads.
  if (s.refreshSec !== 0 && s.refreshSec < min) return [err("source.refresh_below_min", `The refresh interval must be at least ${min} seconds for ${ep.label}.`, { field: "refreshSec" }, `Set it to ${min} seconds or more.`)];
  return [];
}

const INPUT_REF = /\$input/;

function commandOf(c: ControlDef): { def?: CommandDef; integrationName?: string; problem?: Problem } {
  if (c.run.kind !== "command") return {};
  const row = getIntegrationRow(c.run.integrationId);
  if (!row) return { problem: err("control.unknown_integration", `The integration control ${c.label} uses no longer exists.`, { field: "run.integrationId" }) };
  const def = commandCatalog(row).get(c.run.commandId)?.def;
  if (!def) return { integrationName: row.name, problem: err("control.unknown_command", `${row.name} cannot run "${c.run.commandId}".`, { field: "run.commandId" }) };
  return { def, integrationName: row.name };
}

/**
 * A control: who may bind the command, the command exists, target fields are literals the author
 * picked, and every other required parameter has a source (gauntlet w2-r2 item 2). A missing parameter
 * is a warning while editing and an error in the publish review (`opts.publishing`), so a control that
 * would fail on every run can never be published.
 */
export function checkControl(c: ControlDef, p: Principal | null, opts: { publishing?: boolean } = {}): Problem[] {
  const out: Problem[] = [];
  if (c.cooldownMs !== undefined && c.cooldownMs < 250) out.push(err("control.cooldown", "The cooldown is at least 250 ms.", { field: "cooldownMs" }));
  if (c.run.kind !== "command") return out;
  const row = getIntegrationRow(c.run.integrationId);
  const { def, problem } = commandOf(c);
  if (problem) return [...out, problem];
  if (p && row && !canBindCommands(p, row)) return [...out, err("control.not_allowed", `Only the owner and the person who set up ${row.name} can use its commands in a control.`, { field: "run.integrationId" })];
  if (p && def?.ownerOnly && (p.kind === "guest" || p.role !== "owner")) return [...out, err("control.owner_only", `Only the owner can place "${def.label}".`, { field: "run.commandId" })];
  const run = c.run;
  const params = run.params ?? {};
  for (const name of targetParams(def)) {
    const v = params[name];
    const field = `run.params.${name}`;
    if (v === undefined || v === null || v === "") {
      out.push(err("control.target_missing", `Pick which ${name === "entityId" ? "device" : name} this control changes.`, { field }));
      continue;
    }
    if (isBinding(v) || typeof v !== "string" || INPUT_REF.test(v) || v.includes("{{")) {
      out.push(err("control.target_from_input", `${name} is the control's target: pick it from the list. It can never come from the control's input or a binding.`, { field }, "Choose a fixed value from the target list."));
      continue;
    }
    // A1.4: the target must appear in the target endpoint's rows, when Atrium has them.
    if (p && p.kind !== "guest") {
      const listing = listCommands(p).find((l) => l.integrationId === run.integrationId && l.command.id === def!.id);
      if (listing?.targets && listing.targets.length > 0 && !listing.targets.some((t) => t.id === v)) out.push(err("control.unknown_target", `"${v}" is not one of the targets this command can change.`, { field }));
    }
  }
  if (def) {
    for (const row of missingParams(def, params)) {
      const make = opts.publishing ? err : warn;
      out.push(make("control.param_missing", `${c.label} needs a value for ${row.title}.`, { field: `run.params.${row.name}` }, `Open App controls, edit ${c.label}, and choose where ${row.title} comes from: the control's value, a fixed value, or the viewer's name.`));
    }
    // Gauntlet w2-r3 item 3: a mapped parameter the command's body never uses is dropped on every run (the
    // switch flips, the device never hears it). A warning while editing and in the publish review.
    const record = row ? commandCatalog(row).get(c.run.commandId)?.custom : undefined;
    for (const u of unsentParams(def, record, params)) {
      out.push(warn("control.param_unsent", `${c.label} sets ${u.title}, but the command ${def.label} never sends it: its body has no {{ params.${u.name} }}.`, { field: `run.params.${u.name}` }, `In Integrations, open ${row?.name ?? "the integration"}, change the command ${def.label} so its body uses "{{ params.${u.name} }}" (for example {"${u.name}": "{{ params.${u.name} }}"}), and publish it.`));
    }
  }
  return out;
}

/** Op checks for applyOpsToDoc: component schemas (components' validateNodes) and the checks above. */
export function opChecks(p: Principal | null): OpChecks {
  return {
    isContainer: (type) => getComponentDef(type as never)?.container,
    nodes: (doc, ids) => {
      const set = new Set(ids);
      return validateNodes(doc).filter((x) => x.severity === "error" && x.where.nodeId && set.has(x.where.nodeId));
    },
    source: (s) => checkSource(s, p),
    control: (c) => checkControl(c, p),
  };
}

// ---- Whole-document validation (validate tool, publish review) ----

/** App-level checks; component-level ones come from components' validateNodes. */
export function validateDocument(doc: AppDocument, p: Principal | null): Problem[] {
  const out: Problem[] = [];
  if (!findPage(doc, doc.app.homePage)) out.push(err("app.bad_home", "The home page is missing.", { field: "homePage" }, "Pick a home page in the page switcher."));
  const slugs = new Set<string>();
  for (const page of orderedPages(doc)) {
    if (!SLUG_PATTERN.test(page.slug) || RESERVED_PAGE_SLUGS.has(page.slug)) out.push(err("page.bad_slug", `Page ${page.title} has an invalid URL name.`, { pageId: page.id, field: "slug" }));
    if (slugs.has(page.slug)) out.push(err("page.slug_taken", `Two pages use the URL name "${page.slug}".`, { pageId: page.id, field: "slug" }));
    slugs.add(page.slug);
    if (!page.root.children || page.root.children.length === 0) out.push(warn("page.empty", `Page ${page.title} has no components yet.`, { pageId: page.id }, "Add a component from Insert."));
  }
  const names = new Set<string>();
  for (const s of doc.dataSources) {
    if (!SOURCE_NAME.test(s.name)) out.push(err("source.bad_name", `Data source name "${s.name}" is not valid.`, { field: "name" }));
    if (names.has(s.name)) out.push(err("source.duplicate", `Two data sources are named ${s.name}.`, { field: "name" }));
    names.add(s.name);
    // An unmapped source's one warning points at the first component that shows it, so the review can select it.
    const user = unmappedPackage(s.integrationId) ? firstNodeUsing(doc, s.name) : null;
    out.push(...checkSource(s, null).map((x) => (user ? { ...x, where: { ...x.where, pageId: user.pageId, nodeId: user.nodeId } } : x)));
  }
  const controlIds = new Set(doc.controls.map((c) => c.id));
  for (const c of doc.controls) {
    // Point each control problem at the first component that runs it, so the review can select it.
    const user = allNodes(doc).find((l) => controlsOfNode(l.node).includes(c.id));
    out.push(...checkControl(c, p, { publishing: true }).map((x) => (user && !x.where.nodeId ? { ...x, where: { ...x.where, pageId: user.page.id, nodeId: user.node.id } } : x)));
  }
  for (const l of allNodes(doc)) {
    for (const id of controlsOfNode(l.node)) {
      if (!controlIds.has(id)) out.push(err(l.node.type === "html" ? "html.unknown_control" : "control.missing", `${l.node.type === "html" ? "An HTML block" : "A component"} on ${l.page.title} uses a control that does not exist.`, { pageId: l.page.id, nodeId: l.node.id, field: l.node.type === "html" ? "controls" : "control" }));
    }
  }
  // A library instance whose pinned component is not on this instance cannot render (gauntlet w2-r1 item 3).
  let library: Record<string, unknown> = {};
  try {
    library = libraryForDoc(doc);
  } catch {
    library = {};
  }
  for (const l of allNodes(doc)) {
    const ref = l.node.libraryRef;
    if (ref && !library[`${ref.componentId}@${ref.version}`]) out.push(err("library.missing", `A library component on ${l.page.title} is missing from this Atrium (${l.node.name ?? "unnamed"}, version ${ref.version}).`, { pageId: l.page.id, nodeId: l.node.id }, "Import the app file again so it brings the component, or detach or remove this instance."));
  }
  try {
    out.push(...validateNodes(doc));
  } catch {
    out.push(warn("components.unavailable", "Component checks could not run.", {}));
  }
  return out;
}

/**
 * One review warning when the sanitiser removes CSS the document carries: node CSS and style, the app's
 * navigation CSS and style, and inline theme CSS (gauntlet w2-r1 item 9: "N CSS rules were removed").
 */
export function cssWarnings(doc: AppDocument): Problem[] {
  let n = 0;
  let first: { pageId: string; nodeId: string } | null = null;
  try {
    if (doc.chrome.css || doc.chrome.style) n += compileChromeCss(doc.chrome, "review").removed.length;
    for (const l of allNodes(doc)) {
      if (!l.node.css && !l.node.style) continue;
      const removed = compileNodeCss(l.node).removed.length;
      if (removed && !first) first = { pageId: l.page.id, nodeId: l.node.id };
      n += removed;
    }
    for (const ref of [doc.theme, ...doc.pages.map((p) => p.theme)]) if (ref && "inline" in ref && ref.inline?.customCss) n += canvasThemeCssWithReport(ref.inline).dropped.length;
  } catch {
    return [];
  }
  if (!n) return [];
  return [warn("css.removed", `${n} CSS ${n === 1 ? "rule was" : "rules were"} removed`, first ?? {}, "Atrium keeps app CSS inside the app's frame. Open the component's Advanced CSS, or App look, to see what was removed.")];
}

const ROOT_REF = /\{\{\s*([a-z][a-z0-9_]*)/g;

/** The first node (in page order) whose props bind the named source. */
export function firstNodeUsing(doc: AppDocument, name: string): { pageId: string; nodeId: string } | null {
  for (const page of orderedPages(doc)) {
    for (const l of walk(page)) {
      for (const m of JSON.stringify(l.node.props).matchAll(ROOT_REF)) if (m[1] === name) return { pageId: page.id, nodeId: l.node.id };
    }
  }
  return null;
}

// ---- Publish review helpers ----

export type ControlLine = { controlId: string; label: string; change: "added" | "changed"; integration: string; command: string; draftOnly: boolean };

/** "This version lets people": every control added or changed against the live document. */
export function controlLines(live: AppDocument | null, next: AppDocument): ControlLine[] {
  const before = new Map((live?.controls ?? []).map((c) => [c.id, JSON.stringify(c)]));
  const out: ControlLine[] = [];
  for (const c of next.controls) {
    const prev = before.get(c.id);
    if (prev === JSON.stringify(c)) continue;
    let integration = "workflow";
    let command = c.run.kind === "workflow" ? `actions · ${c.run.actionId}` : "";
    if (c.run.kind === "command") {
      const row = getIntegrationRow(c.run.integrationId);
      integration = row ? row.name : "missing integration";
      const target = Object.entries(c.run.params ?? {}).find(([, v]) => typeof v === "string" && !v.includes("{{"));
      command = `${row?.packageId ?? "?"} · ${c.run.commandId}${target ? ` ${String(target[1])}` : ""}`;
    }
    out.push({ controlId: c.id, label: c.label, change: prev ? "changed" : "added", integration, command, draftOnly: !prev });
  }
  return out;
}

const WHOLE_SOURCE = /^\{\{\s*([a-z][a-z0-9_]{0,31})(?:\.(rows|items|series))?\s*\}\}$/;

/** Guest warnings: an html block in a guest app that binds a whole source ("Guests will receive 48 rows of ha"). */
export function guestWarnings(doc: AppDocument, guestsOn: boolean, rowCount: (s: DataSourceDef) => number | null = defaultRowCount): Problem[] {
  if (!guestsOn) return [];
  const out: Problem[] = [];
  const seen = new Set<string>();
  for (const l of allNodes(doc)) {
    if (l.node.type !== "html") continue;
    const data = l.node.props.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    for (const v of Object.values(data as Record<string, unknown>)) {
      const t = isBinding(v) ? v.$bind.trim() : null;
      const m = t ? WHOLE_SOURCE.exec(t) : null;
      if (!m) continue;
      const s = doc.dataSources.find((d) => d.name === m[1]);
      if (!s || seen.has(`${l.node.id}:${s.name}`)) continue;
      seen.add(`${l.node.id}:${s.name}`);
      const n = rowCount(s);
      out.push(warn("guest.whole_source", `Guests will receive ${n ?? "every"} rows of ${s.name}`, { pageId: l.page.id, nodeId: l.node.id, field: "data" }, "Bind only the values the block shows."));
    }
  }
  return out;
}

function defaultRowCount(s: DataSourceDef): number | null {
  try {
    const d = cachedWidgetData({ integrationId: s.integrationId, endpointId: s.endpointId, ...(s.params !== undefined ? { params: s.params } : {}) }, s.refreshSec).data;
    if (!d) return null;
    if (d.kind === "table") return d.rows.length;
    if (d.kind === "status") return d.items.length;
    if (d.kind === "series") return d.series.length;
    return 1;
  } catch {
    return null;
  }
}

/**
 * The publish review's data warnings (Wave 2.7 spec 3.6): unused sources, the wrong kind, widgets hidden
 * under others, bound fields with no data, and widgets whose read failed its live check (Wave 2.8). Judged on what the cache already holds; nothing is fetched.
 */
export function dataReviewWarnings(doc: AppDocument): Problem[] {
  // A9.2: the live check results per integration, read once (editors only: the review is theirs).
  const checks = new Map<string, Map<string, { status: string; reason?: string }>>();
  const failedWhy = (integrationId: string, endpointId: string): string | undefined => {
    if (!checks.has(integrationId)) { try { checks.set(integrationId, checksMap(integrationId)); } catch { checks.set(integrationId, new Map()); } }
    const c = checks.get(integrationId)!.get(endpointId);
    return c?.status === "failed" ? c.reason?.trim() || "This read stopped working." : undefined;
  };
  try {
    return reviewWarnings(doc, (name) => {
      const s = doc.dataSources.find((d) => d.name === name);
      if (!s || unmappedPackage(s.integrationId)) return {};
      const failed = failedWhy(s.integrationId, s.endpointId);
      let data;
      try { data = cachedWidgetData({ integrationId: s.integrationId, endpointId: s.endpointId, ...(s.params !== undefined ? { params: s.params } : {}) }, s.refreshSec).data ?? undefined; } catch { data = undefined; }
      let kind;
      try { const row = getIntegrationRow(s.integrationId); kind = row ? endpointsOf(row).find((e) => e.id === s.endpointId)?.shape : undefined; } catch { kind = undefined; }
      return { ...(data ? { data } : {}), ...(kind ? { kind } : {}), ...(failed ? { failed } : {}) };
    });
  } catch {
    return [];
  }
}

export type { ComponentNode };
