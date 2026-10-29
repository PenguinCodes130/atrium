// Draft operations (architecture v3 section 4.9): applied in order, all or nothing, to a copy of the
// document. Pure and isomorphic: the server applies them in a transaction (service.ts); the builder
// uses the same code to apply edits optimistically and to compute undo (inverse operations).
import type { AppDocument, ComponentNode, ControlDef, DataSourceDef, DraftOp, PageDoc, Problem } from "@/core/contracts";
import { ID_PATTERN, RESERVED_PAGE_SLUGS, SLUG_PATTERN, clone, findNode, findPage, isBinding, mergePatch, nodeLabel, subtreeIds, walk } from "./doc";

export const MAX_OPS_PER_BATCH = 200;
export const SOURCE_NAME = /^[a-z][a-z0-9_]{0,31}$/;

/** Checks the server (or the builder) adds on top of the structural ones. Each returns problems. */
export type OpChecks = {
  /** Props against the component's schema, container rules, html limits (components' definitions). */
  node?(node: ComponentNode, doc: AppDocument): Problem[];
  /** The same, once per batch over every touched node (components' validateNodes). */
  nodes?(doc: AppDocument, nodeIds: string[]): Problem[];
  source?(source: DataSourceDef, doc: AppDocument): Problem[];
  control?(control: ControlDef, doc: AppDocument): Problem[];
  /** Whether a type may hold children. Unknown types answer undefined (treated as "grid-like" only for known containers). */
  isContainer?(type: string): boolean | undefined;
};

export type ApplyResult = { ok: true; doc: AppDocument; changed: string[] } | { ok: false; problems: Problem[] };

const CONTAINERS = new Set(["grid", "stack", "card", "tabs", "section", "repeat", "group"]);

/** A1.4/A7.4: x and w are multiples of an eighth of a column (snapping off), y and h whole 8px rows. */
export function isSlot(s: unknown): s is { x: number; y: number; w: number; h: number } {
  if (!s || typeof s !== "object") return false;
  const { x, y, w, h } = s as Record<string, unknown>;
  const eighth = (n: unknown) => typeof n === "number" && Number.isFinite(n) && Number.isInteger(n * 8);
  return eighth(x) && eighth(w) && Number.isInteger(y) && Number.isInteger(h) && (x as number) >= 0 && (y as number) >= 0 && (w as number) >= 0.125 && (h as number) >= 1;
}
export const PAGE_WIDTHS = [1280, 1440, 1920];
/** A7.5: "none" or a whole number of px from 0 to 64. */
export function isPagePadding(v: unknown): v is "none" | number {
  return v === "none" || (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 64);
}
export const SLOT_RULE = "A grid slot needs x and w in eighths of a column (x from 0, w from 0.125) and y and h in whole rows (y from 0, h from 1).";

function problem(code: string, message: string, where: Problem["where"] = {}, fix?: string): Problem {
  return { severity: "error", code, where, message, ...(fix ? { fix } : {}) };
}

function allIds(doc: AppDocument): Set<string> {
  const ids = new Set<string>();
  for (const p of doc.pages) for (const l of walk(p)) ids.add(l.node.id);
  return ids;
}

function checkTree(node: ComponentNode, taken: Set<string>, where: Problem["where"], checks: OpChecks, out: Problem[]): void {
  const seen = new Set<string>();
  const rec = (n: ComponentNode) => {
    if (typeof n.id !== "string" || !ID_PATTERN.test(n.id) || !n.id.startsWith("c_")) out.push(problem("node.bad_id", `"${String(n.id)}" is not a component id (c_ followed by 10 letters or digits 2 to 7).`, { ...where, nodeId: String(n.id) }));
    else if (taken.has(n.id) || seen.has(n.id)) out.push(problem("node.duplicate_id", `The id ${n.id} is already used in this app.`, { ...where, nodeId: n.id }));
    seen.add(n.id);
    if (typeof n.type !== "string" || !n.type) out.push(problem("node.bad_type", "Every component needs a type.", { ...where, nodeId: n.id }));
    if (!n.props || typeof n.props !== "object" || Array.isArray(n.props)) out.push(problem("node.bad_props", "A component's props must be an object.", { ...where, nodeId: n.id, field: "props" }));
    if (n.children !== undefined) {
      if (!Array.isArray(n.children)) out.push(problem("node.bad_children", "children must be a list.", { ...where, nodeId: n.id }));
      else {
        const container = checks.isContainer?.(n.type) ?? CONTAINERS.has(n.type);
        if (!container && n.children.length > 0) out.push(problem("node.not_container", `A ${n.type} cannot hold other components.`, { ...where, nodeId: n.id }));
        for (const c of n.children) rec(c);
      }
    }
  };
  rec(node);
  for (const id of seen) taken.add(id);
}

function isContainer(type: string, checks: OpChecks): boolean {
  return checks.isContainer?.(type) ?? CONTAINERS.has(type);
}

function slugTaken(doc: AppDocument, slug: string, exceptPageId?: string): boolean {
  return doc.pages.some((p) => p.slug === slug && p.id !== exceptPageId);
}

function pageSlugProblem(doc: AppDocument, slug: unknown, pageId: string | undefined): Problem | null {
  if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) return problem("page.bad_slug", "A page URL name uses 1 to 40 lowercase letters, digits and hyphens.", { pageId, field: "slug" });
  if (RESERVED_PAGE_SLUGS.has(slug)) return problem("page.reserved_slug", `"${slug}" is reserved. Pick another page URL name.`, { pageId, field: "slug" });
  if (slugTaken(doc, slug, pageId)) return problem("page.slug_taken", `Another page already uses "${slug}".`, { pageId, field: "slug" });
  return null;
}

function insertAt<T>(list: T[], item: T, index: number | undefined): void {
  const i = index === undefined || !Number.isInteger(index) ? list.length : Math.max(0, Math.min(list.length, index));
  list.splice(i, 0, item);
}

/** Applies a batch to a copy of `doc`. Nothing is changed unless every op succeeds. */
export function applyOpsToDoc(input: AppDocument, ops: DraftOp[], checks: OpChecks = {}): ApplyResult {
  if (!Array.isArray(ops) || ops.length === 0) return { ok: false, problems: [problem("batch.empty", "The batch has no operations.")] };
  if (ops.length > MAX_OPS_PER_BATCH) return { ok: false, problems: [problem("batch.too_large", `A batch can hold at most ${MAX_OPS_PER_BATCH} operations.`)] };
  const doc = clone(input);
  const changed = new Set<string>();
  const touchedNodes = new Set<string>();
  const touchedSources = new Set<string>();
  const touchedControls = new Set<string>();
  const problems: Problem[] = [];

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    const fail = (p: Problem) => problems.push(p);
    if (!op || typeof op !== "object" || typeof (op as { op?: unknown }).op !== "string") {
      fail(problem("op.unknown", `Operation ${i + 1} is not a draft operation.`));
      break;
    }
    switch (op.op) {
      case "page.add": {
        const page = op.page as PageDoc;
        if (!page || typeof page !== "object") { fail(problem("page.bad", "page.add needs a page.")); break; }
        if (typeof page.id !== "string" || !/^p_[a-z2-7]{10}$/.test(page.id)) { fail(problem("page.bad_id", "A page id is p_ followed by 10 letters or digits 2 to 7.", { pageId: String(page.id) })); break; }
        if (findPage(doc, page.id)) { fail(problem("page.duplicate_id", `A page with id ${page.id} already exists.`, { pageId: page.id })); break; }
        const sp = pageSlugProblem(doc, page.slug, page.id);
        if (sp) { fail(sp); break; }
        if (typeof page.title !== "string" || !page.title.trim()) { fail(problem("page.bad_title", "Give the page a title.", { pageId: page.id, field: "title" })); break; }
        if (page.maxWidth !== undefined && !PAGE_WIDTHS.includes(page.maxWidth)) { fail(problem("page.bad_width", "The page width fills the screen or is at most 1280, 1440 or 1920 px.", { pageId: page.id, field: "maxWidth" })); break; }
        if (page.padding !== undefined && !isPagePadding(page.padding)) { fail(problem("page.bad_padding", "The page padding follows the theme, is none, or is a whole number from 0 to 64 px.", { pageId: page.id, field: "padding" })); break; }
        if (!page.root || !isContainer(page.root.type, checks)) { fail(problem("page.bad_root", "A page's root must be a container (grid, stack, card, tabs or section).", { pageId: page.id, field: "root" })); break; }
        const before = problems.length;
        checkTree(page.root, allIds(doc), { pageId: page.id }, checks, problems);
        if (problems.length > before) break;
        doc.pages.push({ ...clone(page), inNav: page.inNav !== false });
        insertAt(doc.app.pageOrder, page.id, op.index);
        for (const id of subtreeIds(page.root)) touchedNodes.add(id);
        changed.add(page.id);
        break;
      }
      case "page.update": {
        const page = findPage(doc, op.pageId);
        if (!page) { fail(problem("page.missing", "That page no longer exists.", { pageId: op.pageId })); break; }
        const patch = (op.patch ?? {}) as Record<string, unknown>;
        if ("id" in patch || "root" in patch) { fail(problem("page.bad_patch", "page.update cannot change a page's id or component tree.", { pageId: page.id })); break; }
        if ("slug" in patch) { const sp = pageSlugProblem(doc, patch.slug, page.id); if (sp) { fail(sp); break; } }
        if ("title" in patch && (typeof patch.title !== "string" || !patch.title.trim())) { fail(problem("page.bad_title", "Give the page a title.", { pageId: page.id, field: "title" })); break; }
        if ("inNav" in patch && typeof patch.inNav !== "boolean") { fail(problem("page.bad_patch", "inNav is true or false.", { pageId: page.id, field: "inNav" })); break; }
        if ("maxWidth" in patch && patch.maxWidth !== null && !PAGE_WIDTHS.includes(patch.maxWidth as number)) { fail(problem("page.bad_width", "The page width fills the screen or is at most 1280, 1440 or 1920 px.", { pageId: page.id, field: "maxWidth" })); break; }
        if ("padding" in patch && patch.padding !== null && !isPagePadding(patch.padding)) { fail(problem("page.bad_padding", "The page padding follows the theme, is none, or is a whole number from 0 to 64 px.", { pageId: page.id, field: "padding" })); break; }
        const next = mergePatch(page, patch) as PageDoc;
        if ("theme" in patch && patch.theme !== null) next.theme = clone(patch.theme) as PageDoc["theme"];
        Object.assign(page, next, { id: page.id, root: page.root });
        if (patch.theme === null) delete page.theme;
        // A7.5: null clears a page's width or padding (back to filling the screen, or the theme's padding).
        if (patch.maxWidth === null) delete page.maxWidth;
        if (patch.padding === null) delete page.padding;
        changed.add(page.id);
        break;
      }
      case "page.remove": {
        const page = findPage(doc, op.pageId);
        if (!page) { fail(problem("page.missing", "That page no longer exists.", { pageId: op.pageId })); break; }
        if (doc.pages.length === 1) { fail(problem("page.last", "An app needs at least one page.", { pageId: page.id })); break; }
        doc.pages = doc.pages.filter((p) => p.id !== page.id);
        doc.app.pageOrder = doc.app.pageOrder.filter((id) => id !== page.id);
        if (doc.app.homePage === page.id) doc.app.homePage = doc.app.pageOrder[0] ?? doc.pages[0]!.id;
        changed.add(page.id);
        break;
      }
      case "page.move": {
        const page = findPage(doc, op.pageId);
        if (!page) { fail(problem("page.missing", "That page no longer exists.", { pageId: op.pageId })); break; }
        doc.app.pageOrder = doc.app.pageOrder.filter((id) => id !== page.id);
        insertAt(doc.app.pageOrder, page.id, op.index);
        changed.add(page.id);
        break;
      }
      case "node.add": {
        const parent = findNode(doc, op.parentId);
        if (!parent) { fail(problem("parent.missing", "The container for this component no longer exists.", { nodeId: op.parentId })); break; }
        if (!isContainer(parent.node.type, checks)) { fail(problem("node.not_container", `A ${parent.node.type} cannot hold other components.`, { pageId: parent.page.id, nodeId: parent.node.id })); break; }
        if (!op.node || typeof op.node !== "object") { fail(problem("node.bad", "node.add needs a component.")); break; }
        const before = problems.length;
        checkTree(op.node, allIds(doc), { pageId: parent.page.id }, checks, problems);
        if (problems.length > before) break;
        parent.node.children ??= [];
        insertAt(parent.node.children, clone(op.node), op.index);
        for (const id of subtreeIds(op.node)) touchedNodes.add(id);
        changed.add(op.node.id);
        break;
      }
      case "node.update": {
        const at = findNode(doc, op.nodeId);
        if (!at) { fail(problem("node.missing", "That component no longer exists.", { nodeId: op.nodeId })); break; }
        const patch = (op.patch ?? {}) as Record<string, unknown>;
        if (!patch || typeof patch !== "object" || Array.isArray(patch)) { fail(problem("node.bad_patch", "node.update needs a patch object.", { nodeId: op.nodeId })); break; }
        if ("id" in patch || "children" in patch) { fail(problem("node.bad_patch", "node.update cannot change a component's id or children.", { nodeId: op.nodeId })); break; }
        if ("hidden" in patch && patch.hidden !== null && typeof patch.hidden !== "boolean") { fail(problem("node.bad_patch", "hidden is true or false.", { nodeId: op.nodeId, field: "hidden" })); break; }
        if ("slot" in patch && patch.slot !== null && !isSlot(patch.slot)) { fail(problem("node.bad_slot", SLOT_RULE, { nodeId: op.nodeId, field: "slot" })); break; }
        // A8.5: the widget's own title and its "Show title bar" switch.
        if ("title" in patch && patch.title !== null && (typeof patch.title !== "string" || patch.title.length > 120)) { fail(problem("node.bad_patch", "A title is text of at most 120 characters.", { nodeId: op.nodeId, field: "title" })); break; }
        // A10.1: the component's own refresh, in whole seconds (null clears it back to the read's default).
        if ("refreshSec" in patch && patch.refreshSec !== null && (typeof patch.refreshSec !== "number" || !Number.isFinite(patch.refreshSec) || patch.refreshSec < 1 || patch.refreshSec > 86400)) { fail(problem("node.bad_refresh", "A component's refresh is a number of seconds from 1 to 86400.", { nodeId: op.nodeId, field: "refreshSec" })); break; }
        if ("showTitle" in patch && patch.showTitle !== null && typeof patch.showTitle !== "boolean") { fail(problem("node.bad_patch", "Show title bar is true or false.", { nodeId: op.nodeId, field: "showTitle" })); break; }
        if ("type" in patch && at.parent === null && !isContainer(String(patch.type), checks)) { fail(problem("page.bad_root", "A page's root must stay a container.", { pageId: at.page.id, nodeId: op.nodeId })); break; }
        const next = mergePatch(at.node, patch);
        // Bindings and arrays replace whole values (mergePatch); the id and children always stay.
        for (const k of Object.keys(at.node)) delete (at.node as Record<string, unknown>)[k];
        Object.assign(at.node, next, { id: op.nodeId });
        if (!at.node.props) at.node.props = {};
        touchedNodes.add(op.nodeId);
        changed.add(op.nodeId);
        break;
      }
      case "node.move": {
        const at = findNode(doc, op.nodeId);
        if (!at) { fail(problem("node.missing", "That component no longer exists.", { nodeId: op.nodeId })); break; }
        if (!at.parent) { fail(problem("node.root", "A page's root cannot be moved.", { pageId: at.page.id, nodeId: op.nodeId })); break; }
        const target = findNode(doc, op.parentId);
        if (!target) { fail(problem("parent.missing", "The container for this component no longer exists.", { nodeId: op.parentId })); break; }
        if (!isContainer(target.node.type, checks)) { fail(problem("node.not_container", `A ${target.node.type} cannot hold other components.`, { nodeId: target.node.id })); break; }
        if (subtreeIds(at.node).includes(target.node.id)) { fail(problem("node.cycle", "A component cannot move inside itself.", { nodeId: op.nodeId })); break; }
        at.parent.children = (at.parent.children ?? []).filter((c) => c.id !== at.node.id);
        target.node.children ??= [];
        insertAt(target.node.children, at.node, op.index);
        if (op.slot !== undefined) {
          const s = op.slot;
          if (!isSlot(s)) { fail(problem("node.bad_slot", SLOT_RULE, { nodeId: op.nodeId, field: "slot" })); break; }
          at.node.slot = { x: s.x, y: s.y, w: s.w, h: s.h };
        }
        touchedNodes.add(op.nodeId);
        changed.add(op.nodeId);
        break;
      }
      case "node.remove": {
        const at = findNode(doc, op.nodeId);
        if (!at) { fail(problem("node.missing", "That component no longer exists.", { nodeId: op.nodeId })); break; }
        if (!at.parent) { fail(problem("node.root", "A page's root cannot be removed.", { pageId: at.page.id, nodeId: op.nodeId })); break; }
        at.parent.children = (at.parent.children ?? []).filter((c) => c.id !== at.node.id);
        changed.add(op.nodeId);
        break;
      }
      case "source.set": {
        const s = op.source;
        if (!s || typeof s.name !== "string" || !SOURCE_NAME.test(s.name)) { fail(problem("source.bad_name", "A data source name starts with a letter and uses lowercase letters, digits and _ (at most 32).", { field: "name" })); break; }
        if (typeof s.integrationId !== "string" || !s.integrationId || typeof s.endpointId !== "string" || !s.endpointId) { fail(problem("source.bad", "Pick an integration and an endpoint.", { field: "endpointId" })); break; }
        if (typeof s.refreshSec !== "number" || !Number.isFinite(s.refreshSec) || s.refreshSec <= 0) { fail(problem("source.bad_refresh", "The refresh interval is a number of seconds.", { field: "refreshSec" })); break; }
        if (s.label !== undefined && s.label !== null && (typeof s.label !== "string" || s.label.length > 80)) { fail(problem("source.bad_label", "A data source's name in words is text of at most 80 characters.", { field: "label" })); break; }
        const label = typeof s.label === "string" ? s.label.trim() : "";
        const clean: DataSourceDef = { name: s.name, integrationId: s.integrationId, endpointId: s.endpointId, refreshSec: Math.round(s.refreshSec), ...(s.params !== undefined ? { params: clone(s.params) } : {}), ...(label ? { label } : {}), ...(s.managed === true ? { managed: true } : {}) };
        const i = doc.dataSources.findIndex((d) => d.name === s.name);
        if (i >= 0) doc.dataSources[i] = clean;
        else doc.dataSources.push(clean);
        touchedSources.add(s.name);
        changed.add(`source:${s.name}`);
        break;
      }
      case "source.remove": {
        if (!doc.dataSources.some((d) => d.name === op.name)) { fail(problem("source.missing", `There is no data source named ${op.name}.`, { field: "name" })); break; }
        doc.dataSources = doc.dataSources.filter((d) => d.name !== op.name);
        changed.add(`source:${op.name}`);
        break;
      }
      case "control.set": {
        const c = op.control;
        if (!c || typeof c.id !== "string" || !/^k_[a-z2-7]{10}$/.test(c.id)) { fail(problem("control.bad_id", "A control id is k_ followed by 10 letters or digits 2 to 7.", { field: "id" })); break; }
        if (typeof c.label !== "string" || !c.label.trim()) { fail(problem("control.bad_label", "Give the control a label.", { field: "label" })); break; }
        if (!c.run || (c.run.kind !== "command" && c.run.kind !== "workflow")) { fail(problem("control.bad_run", "A control runs a command or a workflow.", { field: "run" })); break; }
        if (c.cooldownMs !== undefined && (typeof c.cooldownMs !== "number" || !Number.isFinite(c.cooldownMs) || c.cooldownMs < 250)) { fail(problem("control.cooldown", "The cooldown is at least 250 ms.", { field: "cooldownMs" })); break; }
        const i = doc.controls.findIndex((x) => x.id === c.id);
        if (i >= 0) doc.controls[i] = clone(c);
        else doc.controls.push(clone(c));
        touchedControls.add(c.id);
        changed.add(c.id);
        break;
      }
      case "control.remove": {
        if (!doc.controls.some((c) => c.id === op.controlId)) { fail(problem("control.missing", "That control no longer exists.", { field: "controlId" })); break; }
        doc.controls = doc.controls.filter((c) => c.id !== op.controlId);
        changed.add(op.controlId);
        break;
      }
      case "app.update": {
        const patch = (op.patch ?? {}) as Partial<AppDocument["app"]>;
        if (patch.name !== undefined && (typeof patch.name !== "string" || !patch.name.trim() || patch.name.length > 80)) { fail(problem("app.bad_name", "The app name is 1 to 80 characters.", { field: "name" })); break; }
        if (patch.homePage !== undefined && !findPage(doc, patch.homePage)) { fail(problem("app.bad_home", "The home page must be one of the app's pages.", { field: "homePage" })); break; }
        if (patch.pageOrder !== undefined) {
          const ids = new Set(doc.pages.map((p) => p.id));
          if (!Array.isArray(patch.pageOrder) || patch.pageOrder.length !== ids.size || !patch.pageOrder.every((id) => ids.has(id)) || new Set(patch.pageOrder).size !== ids.size) { fail(problem("app.bad_order", "The page order must list every page once.", { field: "pageOrder" })); break; }
        }
        doc.app = mergePatch(doc.app, patch);
        changed.add("app");
        break;
      }
      case "theme.set": {
        const t = op.theme as unknown as Record<string, unknown>;
        if (!t || typeof t !== "object" || (typeof t.themeId !== "string" && (!t.inline || typeof t.inline !== "object"))) { fail(problem("theme.bad", "Pick a theme.", { field: "theme" })); break; }
        doc.theme = clone(op.theme);
        changed.add("theme");
        break;
      }
      case "chrome.update": {
        const patch = (op.patch ?? {}) as Record<string, unknown>;
        if (patch.layout !== undefined && !["sidebar", "topbar", "tabs", "none"].includes(String(patch.layout))) { fail(problem("chrome.bad_layout", "The app's navigation is a sidebar, a top bar, tabs or none.", { field: "layout" })); break; }
        if (typeof patch.css === "string" && patch.css.length > 64 * 1024) { fail(problem("chrome.css_too_large", "Chrome CSS is limited to 64 KB.", { field: "css" })); break; }
        doc.chrome = mergePatch(doc.chrome, patch);
        changed.add("chrome");
        break;
      }
      default:
        fail(problem("op.unknown", `Operation ${i + 1} ("${String((op as { op: unknown }).op)}") is not a draft operation.`));
    }
    if (problems.length) break;
  }
  if (problems.length) return { ok: false, problems };

  // Second pass: the checks that need the whole batch applied (schemas, integrations, targets).
  for (const id of touchedNodes) {
    const at = findNode(doc, id);
    if (at && checks.node) problems.push(...checks.node(at.node, doc).map((p) => ({ ...p, where: { pageId: at.page.id, nodeId: id, ...p.where } })));
  }
  if (checks.nodes && touchedNodes.size) {
    const live = [...touchedNodes].filter((id) => findNode(doc, id));
    if (live.length) problems.push(...checks.nodes(doc, live));
  }
  for (const name of touchedSources) {
    const s = doc.dataSources.find((d) => d.name === name);
    if (s && checks.source) problems.push(...checks.source(s, doc));
  }
  for (const id of touchedControls) {
    const c = doc.controls.find((x) => x.id === id);
    if (c && checks.control) problems.push(...checks.control(c, doc));
  }
  const errors = problems.filter((p) => p.severity === "error");
  if (errors.length) return { ok: false, problems: errors };
  return { ok: true, doc, changed: [...changed] };
}

// ---- Inverse operations (undo) ----

// Patches are deep merges (mergePatch), so the inverse recurses into plain objects: a key the patch added
// inside props comes back as null and is removed, not left behind (media layout SFR-1).
const plainObject = (x: unknown) => !!x && typeof x === "object" && !Array.isArray(x) && !isBinding(x);
function prevValues<T extends object>(obj: T, patch: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(patch)) {
    const v = (obj as Record<string, unknown>)[k];
    out[k] = v === undefined ? null : plainObject(p) && plainObject(v) ? prevValues(v as object, p as object) : clone(v);
  }
  return out;
}

/** The ops that undo `ops` when applied after them. Computed against the document before `ops`. */
export function inverseOps(before: AppDocument, ops: DraftOp[]): DraftOp[] | null {
  let doc = clone(before);
  const inv: DraftOp[] = [];
  for (const op of ops) {
    const step: DraftOp[] = [];
    switch (op.op) {
      case "page.add": step.push({ op: "page.remove", pageId: op.page.id }); break;
      case "page.update": { const p = findPage(doc, op.pageId); if (!p) return null; step.push({ op: "page.update", pageId: op.pageId, patch: prevValues(p, op.patch) as never }); break; }
      case "page.remove": {
        const p = findPage(doc, op.pageId); if (!p) return null;
        step.push({ op: "page.add", page: clone(p), index: doc.app.pageOrder.indexOf(p.id) });
        if (doc.app.homePage === p.id) step.push({ op: "app.update", patch: { homePage: p.id } });
        break;
      }
      case "page.move": step.push({ op: "page.move", pageId: op.pageId, index: doc.app.pageOrder.indexOf(op.pageId) }); break;
      case "node.add": step.push({ op: "node.remove", nodeId: op.node.id }); break;
      case "node.update": { const at = findNode(doc, op.nodeId); if (!at) return null; step.push({ op: "node.update", nodeId: op.nodeId, patch: prevValues(at.node, op.patch) as never }); break; }
      case "node.move": {
        const at = findNode(doc, op.nodeId); if (!at || !at.parent) return null;
        step.push({ op: "node.move", nodeId: op.nodeId, parentId: at.parent.id, index: at.index, ...(at.node.slot ? { slot: clone(at.node.slot) } : {}) });
        if (!at.node.slot && op.slot) step.push({ op: "node.update", nodeId: op.nodeId, patch: { slot: null } as never });
        break;
      }
      case "node.remove": { const at = findNode(doc, op.nodeId); if (!at || !at.parent) return null; step.push({ op: "node.add", parentId: at.parent.id, index: at.index, node: clone(at.node) }); break; }
      case "source.set": { const prev = doc.dataSources.find((d) => d.name === op.source.name); step.push(prev ? { op: "source.set", source: clone(prev) } : { op: "source.remove", name: op.source.name }); break; }
      case "source.remove": { const prev = doc.dataSources.find((d) => d.name === op.name); if (!prev) return null; step.push({ op: "source.set", source: clone(prev) }); break; }
      case "control.set": { const prev = doc.controls.find((c) => c.id === op.control.id); step.push(prev ? { op: "control.set", control: clone(prev) } : { op: "control.remove", controlId: op.control.id }); break; }
      case "control.remove": { const prev = doc.controls.find((c) => c.id === op.controlId); if (!prev) return null; step.push({ op: "control.set", control: clone(prev) }); break; }
      case "app.update": step.push({ op: "app.update", patch: prevValues(doc.app, op.patch) as never }); break;
      case "theme.set": step.push({ op: "theme.set", theme: clone(doc.theme) }); break;
      case "chrome.update": step.push({ op: "chrome.update", patch: prevValues(doc.chrome, op.patch) as never }); break;
    }
    const r = applyOpsToDoc(doc, [op]);
    if (!r.ok) return null;
    doc = r.doc;
    inv.unshift(...step);
  }
  return inv;
}

// ---- Summaries (DraftChange.summary and the publish review's change list) ----

export function summarize(before: AppDocument, ops: DraftOp[]): string {
  const lines: string[] = [];
  for (const op of ops) {
    switch (op.op) {
      case "node.add": lines.push(`Added ${nodeLabel(op.node)}`); break;
      case "node.update": { const at = findNode(before, op.nodeId); const keys = Object.keys(op.patch ?? {}); lines.push(`Changed ${keys.includes("style") || keys.includes("css") ? "the style of " : ""}${at ? nodeLabel(at.node) : "a component"}`); break; }
      case "node.move": { const at = findNode(before, op.nodeId); lines.push(`Moved ${at ? nodeLabel(at.node) : "a component"}`); break; }
      case "node.remove": { const at = findNode(before, op.nodeId); lines.push(`Removed ${at ? nodeLabel(at.node) : "a component"}`); break; }
      case "page.add": lines.push(`Added page ${op.page.title}`); break;
      case "page.update": lines.push(`Changed page ${findPage(before, op.pageId)?.title ?? ""}`.trim()); break;
      case "page.remove": lines.push(`Removed page ${findPage(before, op.pageId)?.title ?? ""}`.trim()); break;
      case "page.move": lines.push(`Moved page ${findPage(before, op.pageId)?.title ?? ""}`.trim()); break;
      // A10.1: managed sources follow components; their changes are not news of their own.
      // Round 3 (recheck item 16): a source reads by its label when it has one, not by its key.
      case "source.set": if (op.source.managed) break; lines.push(`${before.dataSources.some((d) => d.name === op.source.name) ? "Changed" : "Added"} data source ${op.source.label?.trim() || op.source.name}`); break;
      case "source.remove": { const d = before.dataSources.find((x) => x.name === op.name); if (d?.managed) break; lines.push(`Removed data source ${d?.label?.trim() || op.name}`); break; }
      case "control.set": lines.push(`${before.controls.some((c) => c.id === op.control.id) ? "Changed" : "Added"} control ${op.control.label}`); break;
      case "control.remove": lines.push(`Removed control ${before.controls.find((c) => c.id === op.controlId)?.label ?? op.controlId}`); break;
      case "app.update": lines.push("Changed app settings"); break;
      case "theme.set": lines.push("Changed the theme"); break;
      case "chrome.update": lines.push("Changed the app's navigation"); break;
    }
  }
  const unique = [...new Set(lines)];
  if (unique.length <= 2) return unique.join("; ");
  return `${unique.slice(0, 2).join("; ")} and ${unique.length - 2} more`;
}

/** Node ids an op batch targets (for the builder's rebase: drop edits whose target vanished). */
export function opTargets(op: DraftOp): string[] {
  switch (op.op) {
    case "node.update": case "node.remove": return [op.nodeId];
    case "node.move": return [op.nodeId, op.parentId];
    case "node.add": return [op.parentId];
    case "page.update": case "page.remove": case "page.move": return [op.pageId];
    default: return [];
  }
}

/** True when every op is a move that keeps its node's parent and page (layout auto-apply, 4.9). */
export function isLayoutOnly(doc: AppDocument, ops: DraftOp[]): boolean {
  if (ops.length === 0) return false;
  return ops.every((op) => {
    if (op.op !== "node.move") return false;
    const at = findNode(doc, op.nodeId);
    return !!at && !!at.parent && at.parent.id === op.parentId;
  });
}

export { isBinding };
