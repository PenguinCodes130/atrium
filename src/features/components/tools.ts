// components' agent tools (architecture v3 section 9b.1, spec 3.7). Every edit goes to the app's draft
// through app-builder's draft operations, takes an optional expected revision and returns the new
// revision and changed ids, or fails with conflict (current rev) or invalid (problems). No tool
// publishes, runs a control or returns integration config or a secret: data comes back as shaped data
// or evaluated binding values only.
import "server-only";
import { z } from "zod";
import type { AppDocument, ComponentNode, DataSourceDef, DraftOp, Principal, Problem, PropValue, ShapedData, StyleOverride, ToolDef } from "@/core/contracts";
import { AtriumError, NotFound } from "@/core/errors";
import { BUILT_IN_THEMES, tokensToCssVars } from "@/features/shell";
import { readThrough } from "@/features/data/runtime";
import { evaluateTemplate } from "./bindings";
import { sourcesInTemplate } from "./bindings";
import { META, metaFor, EXAMPLE_CONTROL, EXAMPLE_SOURCES } from "./catalogue/meta";
import { propsSchemas, type BuiltInType } from "./catalogue/schemas";
import { newId } from "./ids";
import { eachNode } from "./page";
import { suggestComponent } from "./suggest";
import { validateNodes } from "./validate";
import { compileNodeCss } from "./style/server";
import { isLayoutType, LAYOUT_CSS_REFUSAL } from "./style/node-css-policy";
import { codeFieldProblem } from "./sandbox/bridge";
import { instanceNodeFor } from "./library-instance";
import { getLibrary, listLibrary, saveLibrary } from "@/features/library/server";

// ---------- the draft backend (app-builder registers it) ----------

export type ToolBackend = {
  /** The app's draft for a principal who may edit it (throws when they may not). */
  getDraft(principal: Principal, appId: string): { rev: number; doc: AppDocument } | Promise<{ rev: number; doc: AppDocument }>;
  /** Applies ops at an expected revision; throws app-builder's conflict (currentRev) or invalid (problems) errors. */
  applyOps(principal: Principal, appId: string, ops: DraftOp[], expectRev?: number): { rev: number; changed: string[] } | Promise<{ rev: number; changed: string[] }>;
  /** Optional: the resolved theme's tokens for an app or page. */
  themeTokens?(doc: AppDocument, pageId?: string): Promise<Record<string, string>>;
  /** Optional: reads a data source's current shaped data (defaults to the shared cache). */
  readSource?(def: DataSourceDef): Promise<{ state: string; data?: ShapedData }>;
};

const g = globalThis as unknown as { __atriumComponentTools?: ToolBackend };
/** app-builder (or the lead) registers the draft backend once: getDraftFor + applyDraftOps. */
export function registerComponentToolsBackend(b: ToolBackend): void {
  g.__atriumComponentTools = b;
}
function backend(): ToolBackend {
  const b = g.__atriumComponentTools;
  if (!b) throw new AtriumError("Apps are not available yet, so components cannot be edited.", 403, "not_available");
  return b;
}

/** Refused before anything is sent to the draft: a problem list naming the field. */
export class ToolInvalid extends AtriumError {
  constructor(readonly problems: Problem[]) {
    super(problems[0]?.message ?? "That change is not valid.", 422, "invalid");
  }
}

async function readSource(def: DataSourceDef): Promise<{ state: string; data?: ShapedData }> {
  const b = g.__atriumComponentTools;
  if (b?.readSource) return b.readSource(def);
  const d = await readThrough({ integrationId: def.integrationId, endpointId: def.endpointId, params: def.params }, def.refreshSec);
  return { state: d.state, ...(d.data ? { data: d.data } : {}) };
}

type Ctx = { principal: Principal; signal: AbortSignal };
const read = { scope: "atrium:read" as const, effect: "none" as const, surfaces: ["palette", "builtin-agent", "mcp"] as ("palette" | "builtin-agent" | "mcp")[], minRole: "viewer" as const };
const edit = { scope: "atrium:edit" as const, effect: "draft" as const, surfaces: ["builtin-agent", "mcp"] as ("palette" | "builtin-agent" | "mcp")[], minRole: "member" as const };
const libRead = { ...read, minRole: "member" as const };
const editOut = z.object({ rev: z.number(), changed: z.array(z.string()) });
const appId = z.string().min(1).max(100).describe("The app's id (from apps.list).");
const expectRev = z.number().int().optional().describe("The draft revision you last read; a stale one fails with conflict and the current revision.");
const bindingValue = z.strictObject({ $bind: z.string() });
const propsIn = z.record(z.string(), z.unknown()).describe("Props for the component; any field can be a binding { $bind: \"{{ source.value }}\" }. See components.schema.");
const slotIn = z.strictObject({ x: z.number().int().min(0).max(11), y: z.number().int().min(0), w: z.number().int().min(1).max(12), h: z.number().int().min(1) });

function findNode(doc: AppDocument, nodeId: string): { node: ComponentNode; pageId: string; parent: ComponentNode | null } | null {
  for (const p of doc.pages) {
    let hit: { node: ComponentNode; pageId: string; parent: ComponentNode | null } | null = null;
    eachNode(p.root, (n, parent) => {
      if (!hit && n.id === nodeId) hit = { node: n, pageId: p.id, parent };
    });
    if (hit) return hit;
  }
  return null;
}

/** Validates a node against its schema and the draft, before the op is sent. */
function checkNode(doc: AppDocument, node: ComponentNode, pageId: string): void {
  const page = doc.pages.find((p) => p.id === pageId);
  if (!page) return;
  const probe: AppDocument = { ...doc, pages: [{ ...page, root: { id: "c_toolprobea", type: "stack", props: {}, children: [node] } }] };
  const problems = validateNodes(probe).filter((x) => x.severity === "error" && x.where.nodeId !== "c_toolprobea" && x.code !== "node.duplicate_id");
  if (problems.length) throw new ToolInvalid(problems);
}

async function apply(p: Principal, app: string, ops: DraftOp[], rev?: number) {
  const r = await backend().applyOps(p, app, ops, rev);
  return { rev: r.rev, changed: r.changed };
}

function noSecrets<T>(v: T): T {
  return v;
}

type AnyTool = ToolDef<any, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const componentTools: AnyTool[] = [
  {
    name: "components.catalog", title: "List component types", ...read,
    description: "Every component type you can add, with its category (layout, data, content, control, code), a summary, whether it holds children, and the data shapes it renders.",
    input: z.object({}),
    output: z.object({ types: z.array(z.object({ type: z.string(), title: z.string(), category: z.string(), container: z.boolean(), summary: z.string(), accepts: z.array(z.string()).optional() })) }),
    async handler() {
      return { types: Object.values(META).map((m) => ({ type: m.type, title: m.title, category: m.category, container: m.container, summary: m.docs.summary, ...(m.accepts ? { accepts: m.accepts } : {}) })) };
    },
  },
  {
    name: "components.schema", title: "Describe one component type", ...read,
    description: "One component type in full: its props as JSON Schema (every field described), defaults, style parts (slots), states, when to use it and worked examples that pass validate.",
    input: z.object({ type: z.string().describe("A type from components.catalog, for example stat") }),
    output: z.object({ type: z.string(), props: z.record(z.string(), z.unknown()), defaults: z.record(z.string(), z.unknown()), styleSlots: z.array(z.string()), states: z.array(z.string()), whenToUse: z.string(), examples: z.array(z.unknown()), exampleSources: z.record(z.string(), z.unknown()) }),
    async handler(_c: Ctx, i: { type: string }) {
      const m = metaFor(i.type as BuiltInType);
      if (!m) throw new NotFound(`"${i.type}" is not a component type. Call components.catalog for the list.`);
      return { type: m.type, props: z.toJSONSchema(propsSchemas[m.type]) as Record<string, unknown>, defaults: m.defaults, styleSlots: m.styleSlots, states: m.states ?? [], whenToUse: m.docs.whenToUse, examples: m.docs.examples, exampleSources: { ...EXAMPLE_SOURCES, $controls: [EXAMPLE_CONTROL] } };
    },
  },
  {
    name: "components.add", title: "Add a component", ...edit,
    description: "Adds a component to a container in the app's draft (never the published app). Returns the new revision and the new node's id among changed.",
    input: z.object({ appId, parentId: z.string().describe("The container node to add into (a page's root, a grid, stack, card, section, tabs or repeat)."), type: z.string(), name: z.string().max(120).optional(), props: propsIn.optional(), index: z.number().int().min(0).optional(), slot: slotIn.optional(), expectRev }),
    output: editOut.extend({ nodeId: z.string() }),
    async handler({ principal }: Ctx, i: { appId: string; parentId: string; type: string; name?: string; props?: Record<string, PropValue>; index?: number; slot?: z.infer<typeof slotIn>; expectRev?: number }) {
      const { doc } = await backend().getDraft(principal, i.appId);
      const parent = findNode(doc, i.parentId);
      if (!parent) throw new NotFound("That parent node is not in the draft.");
      const meta = metaFor(i.type as BuiltInType);
      if (!meta) throw new ToolInvalid([{ severity: "error", code: "node.unknown_type", where: { field: "type" }, message: `"${i.type}" is not a component type.` }]);
      const node: ComponentNode = { id: newId("c"), type: meta.type, ...(i.name ? { name: i.name } : {}), props: { ...structuredClone(meta.defaults), ...(i.props ?? {}) }, ...(meta.container ? { children: [] } : {}), ...(i.slot ? { slot: i.slot } : {}) };
      checkNode(doc, node, parent.pageId);
      const r = await apply(principal, i.appId, [{ op: "node.add", parentId: i.parentId, ...(i.index !== undefined ? { index: i.index } : {}), node }], i.expectRev);
      return { ...r, nodeId: node.id };
    },
  },
  {
    name: "components.update", title: "Change a component", ...edit,
    description: "Changes a component's props, name, slot, visibility rule or phone settings in the draft (JSON Merge Patch: a null prop removes it).",
    input: z.object({ appId, nodeId: z.string(), patch: z.object({ name: z.string().max(120).optional(), props: propsIn.optional(), slot: slotIn.optional(), visibleWhen: bindingValue.nullable().optional(), responsive: z.record(z.string(), z.unknown()).optional() }), expectRev }),
    output: editOut,
    async handler({ principal }: Ctx, i: { appId: string; nodeId: string; patch: { name?: string; props?: Record<string, PropValue | null>; slot?: z.infer<typeof slotIn>; visibleWhen?: { $bind: string } | null; responsive?: ComponentNode["responsive"] }; expectRev?: number }) {
      const { doc } = await backend().getDraft(principal, i.appId);
      const hit = findNode(doc, i.nodeId);
      if (!hit) throw new NotFound("That node is not in the draft.");
      const props = { ...hit.node.props };
      for (const [k, v] of Object.entries(i.patch.props ?? {})) if (v === null) delete props[k]; else props[k] = v;
      const next: ComponentNode = { ...hit.node, ...(i.patch.name !== undefined ? { name: i.patch.name } : {}), props, ...(i.patch.slot ? { slot: i.patch.slot } : {}), ...(i.patch.visibleWhen ? { visibleWhen: i.patch.visibleWhen } : {}), ...(i.patch.responsive ? { responsive: i.patch.responsive } : {}) };
      if (i.patch.visibleWhen === null) delete next.visibleWhen;
      checkNode(doc, { ...next, children: [] }, hit.pageId);
      // JSON Merge Patch: null removes a prop or the visibility rule.
      const patch = { ...i.patch } as Record<string, unknown>;
      return apply(principal, i.appId, [{ op: "node.update", nodeId: i.nodeId, patch: patch as never }], i.expectRev);
    },
  },
  {
    name: "components.move", title: "Move a component", ...edit,
    description: "Moves a component to another container or position (and grid slot) in the draft.",
    input: z.object({ appId, nodeId: z.string(), parentId: z.string(), index: z.number().int().min(0).optional(), slot: slotIn.optional(), expectRev }),
    output: editOut,
    async handler({ principal }: Ctx, i: { appId: string; nodeId: string; parentId: string; index?: number; slot?: z.infer<typeof slotIn>; expectRev?: number }) {
      return apply(principal, i.appId, [{ op: "node.move", nodeId: i.nodeId, parentId: i.parentId, ...(i.index !== undefined ? { index: i.index } : {}), ...(i.slot ? { slot: i.slot } : {}) }], i.expectRev);
    },
  },
  {
    name: "components.remove", title: "Remove a component", ...edit,
    description: "Removes a component (and anything inside it) from the draft.",
    input: z.object({ appId, nodeId: z.string(), expectRev }),
    output: editOut,
    async handler({ principal }: Ctx, i: { appId: string; nodeId: string; expectRev?: number }) {
      return apply(principal, i.appId, [{ op: "node.remove", nodeId: i.nodeId }], i.expectRev);
    },
  },
  {
    name: "components.find", title: "Find components", ...read,
    description: "Lists the draft's components, optionally filtered by type or by text in the name, with their page and parent ids.",
    input: z.object({ appId, type: z.string().optional(), name: z.string().max(120).optional(), pageId: z.string().optional() }),
    output: z.object({ rev: z.number(), nodes: z.array(z.object({ id: z.string(), type: z.string(), name: z.string().optional(), pageId: z.string(), parentId: z.string().nullable() })) }),
    async handler({ principal }: Ctx, i: { appId: string; type?: string; name?: string; pageId?: string }) {
      const { rev, doc } = await backend().getDraft(principal, i.appId);
      const nodes: { id: string; type: string; name?: string; pageId: string; parentId: string | null }[] = [];
      for (const p of doc.pages) {
        if (i.pageId && p.id !== i.pageId && p.slug !== i.pageId) continue;
        eachNode(p.root, (n, parent) => {
          if (i.type && n.type !== i.type) return;
          if (i.name && !(n.name ?? "").toLowerCase().includes(i.name.toLowerCase())) return;
          nodes.push({ id: n.id, type: n.type, ...(n.name ? { name: n.name } : {}), pageId: p.id, parentId: parent?.id ?? null });
        });
      }
      return { rev, nodes: nodes.slice(0, 500) };
    },
  },
  {
    name: "components.suggest", title: "Suggest components for a data source", ...read,
    description: "Turns one of the app's data sources into suggested components with their props already bound to it (stat for stat data, chart for series, table or list for tables, status or stat for status).",
    input: z.object({ appId, source: z.string().describe("A data source name in the app") }),
    output: z.object({ shape: z.string().optional(), components: z.array(z.unknown()) }),
    async handler({ principal }: Ctx, i: { appId: string; source: string }) {
      const { doc } = await backend().getDraft(principal, i.appId);
      const def = doc.dataSources.find((d) => d.name === i.source);
      if (!def) throw new NotFound(`There is no data source named "${i.source}" in this app.`);
      const d = await readSource(def);
      if (!d.data) return { components: [] };
      return { shape: d.data.kind, components: [suggestComponent(d.data.kind, def.name, d.data)] };
    },
  },
  {
    name: "bindings.test", title: "Test a binding", ...read,
    description: "Evaluates a binding template against the app's live data (the same engine the page uses) and returns the value, or the error in plain English with its position.",
    input: z.object({ appId, template: z.string().max(4096), pageId: z.string().optional() }),
    output: z.object({ ok: z.boolean(), value: z.unknown().optional(), error: z.object({ code: z.string(), message: z.string(), position: z.number().optional() }).optional(), explanation: z.string() }),
    async handler({ principal }: Ctx, i: { appId: string; template: string; pageId?: string }) {
      const { doc } = await backend().getDraft(principal, i.appId);
      const names = new Set(sourcesInTemplate(i.template));
      const $data: Record<string, ShapedData | undefined> = {};
      const $sources: Record<string, { state: string }> = {};
      for (const def of doc.dataSources) {
        if (!names.has(def.name)) {
          $data[def.name] = undefined;
          continue;
        }
        const d = await readSource(def);
        $data[def.name] = d.data;
        $sources[def.name] = { state: d.state };
      }
      const page = doc.pages.find((p) => p.id === i.pageId || p.slug === i.pageId) ?? doc.pages[0];
      const r = evaluateTemplate(i.template, { $data, $sources, $page: { id: page?.id ?? "", slug: page?.slug ?? "", title: page?.title ?? "" }, $app: { id: i.appId, slug: "", name: doc.app.name }, $user: { kind: "user" }, $now: Date.now() } as never);
      if (!r.ok) return { ok: false, error: r.error, explanation: r.error.message };
      const v = r.value;
      return { ok: true, value: noSecrets(v), explanation: v === undefined ? "The template is valid but gives nothing with the current data (a missing field renders empty)." : `The template gives ${Array.isArray(v) ? `a list of ${v.length}` : typeof v === "object" && v ? "an object" : JSON.stringify(v)}.` };
    },
  },
  {
    name: "styles.set", title: "Style a component or the app chrome", ...edit,
    description: "Sets a component's style override (per part and state, colours may be token:accent) and its CSS box, or the app chrome's. Turns \"Override theme\" on when a style is given. Returns what the sanitiser removed.",
    input: z.object({ appId, nodeId: z.string().optional().describe("The component; omit with chrome: true for the app chrome"), chrome: z.boolean().optional(), style: z.record(z.string(), z.record(z.string(), z.unknown())).optional(), css: z.string().max(65536).optional(), overrideTheme: z.boolean().optional(), expectRev }),
    output: editOut.extend({ removed: z.array(z.string()) }),
    async handler({ principal }: Ctx, i: { appId: string; nodeId?: string; chrome?: boolean; style?: StyleOverride; css?: string; overrideTheme?: boolean; expectRev?: number }) {
      if (i.chrome) {
        const r = await apply(principal, i.appId, [{ op: "chrome.update", patch: { ...(i.style ? { style: i.style } : {}), ...(i.css !== undefined ? { css: i.css } : {}) } }], i.expectRev);
        return { ...r, removed: [] };
      }
      if (!i.nodeId) throw new ToolInvalid([{ severity: "error", code: "styles.target", where: { field: "nodeId" }, message: "Give a nodeId, or chrome: true." }]);
      const { doc } = await backend().getDraft(principal, i.appId);
      const hit = findNode(doc, i.nodeId);
      if (!hit) throw new NotFound("That node is not in the draft.");
      // Layouts take the Style panel only (final pass after gauntlet w2-r3 item 3).
      if (i.css && i.css.trim() && isLayoutType(hit.node.type)) throw new ToolInvalid([{ severity: "error", code: "styles.layout_css", where: { nodeId: i.nodeId, field: "css" }, message: LAYOUT_CSS_REFUSAL }]);
      const overrideTheme = i.overrideTheme ?? (i.style ? true : hit.node.overrideTheme);
      const { removed } = compileNodeCss({ ...hit.node, ...(i.style ? { style: i.style } : {}), ...(i.css !== undefined ? { css: i.css } : {}), overrideTheme });
      const r = await apply(principal, i.appId, [{ op: "node.update", nodeId: i.nodeId, patch: { ...(i.style ? { style: i.style } : {}), ...(i.css !== undefined ? { css: i.css } : {}), ...(overrideTheme !== undefined ? { overrideTheme } : {}) } }], i.expectRev);
      return { ...r, removed };
    },
  },
  {
    name: "styles.tokens", title: "Theme tokens in use", ...read,
    description: "The theme tokens an app (or one page) uses, as CSS custom properties, plus the token names a style colour can reference as token:<name>.",
    input: z.object({ appId, pageId: z.string().optional() }),
    output: z.object({ tokens: z.record(z.string(), z.string()), names: z.array(z.string()) }),
    async handler({ principal }: Ctx, i: { appId: string; pageId?: string }) {
      const { doc } = await backend().getDraft(principal, i.appId);
      const b = backend();
      let tokens: Record<string, string> = {};
      if (b.themeTokens) tokens = await b.themeTokens(doc, i.pageId);
      else {
        const ref = doc.pages.find((p) => p.id === i.pageId)?.theme ?? doc.theme;
        const theme = "inline" in ref ? ref.inline : Object.values(BUILT_IN_THEMES).find((t) => t.id === ref.themeId);
        if (theme) tokens = tokensToCssVars(theme.tokens, theme.mode === "dark" ? "dark" : "light");
      }
      return { tokens, names: ["surface", "surfaceText", "surfaceMuted", "canvasText", "accent", "accentText", "ok", "warn", "bad", "info", "line"] };
    },
  },
  {
    name: "html.set", title: "Set an HTML block's code and data", ...edit,
    description: "Sets an html block's html, css and js (64 KB each), the data it may read (names to bindings), the controls it may ask to run, its height, libraries and images. The code runs in the sandbox; data given to a block is visible to whoever wrote its code.",
    input: z.object({ appId, nodeId: z.string(), html: z.string().optional(), css: z.string().optional(), js: z.string().optional(), data: z.record(z.string(), bindingValue).optional(), controls: z.array(z.string()).optional(), height: z.union([z.literal("auto"), z.number().int().min(20).max(4000)]).optional(), libs: z.array(z.enum(["uplot", "d3", "motion"])).optional(), images: z.array(z.string()).optional(), expectRev }),
    output: editOut,
    async handler({ principal }: Ctx, i: { appId: string; nodeId: string; expectRev?: number } & Record<string, unknown>) {
      const { doc } = await backend().getDraft(principal, i.appId);
      const hit = findNode(doc, i.nodeId);
      if (!hit || hit.node.type !== "html") throw new NotFound("That html block is not in the draft.");
      const problems: Problem[] = [];
      for (const f of ["html", "css", "js"] as const) {
        const v = i[f];
        if (typeof v === "string") {
          const p = codeFieldProblem(f, v);
          if (p) problems.push({ severity: "error", code: "html.too_long", where: { nodeId: i.nodeId, field: f }, message: p });
        }
      }
      if (problems.length) throw new ToolInvalid(problems);
      const props: Record<string, PropValue> = { ...hit.node.props };
      for (const k of ["html", "css", "js", "data", "controls", "height", "libs", "images"]) if (i[k] !== undefined) props[k] = i[k] as PropValue;
      checkNode(doc, { ...hit.node, props }, hit.pageId);
      return apply(principal, i.appId, [{ op: "node.update", nodeId: i.nodeId, patch: { props } }], i.expectRev);
    },
  },
  {
    name: "library.list", title: "List library components", ...libRead,
    description: "Every saved library component: name, description, tags, version, parameters and whether it contains code.",
    input: z.object({}),
    output: z.object({ components: z.array(z.object({ id: z.string(), name: z.string(), description: z.string().optional(), tags: z.array(z.string()), version: z.number(), params: z.array(z.unknown()), containsCode: z.boolean(), source: z.string() })) }),
    async handler({ principal }: Ctx) {
      return { components: listLibrary(principal).map((c) => ({ id: c.id, name: c.name, ...(c.description ? { description: c.description } : {}), tags: c.tags, version: c.version, params: c.params, containsCode: c.containsCode, source: c.source })) };
    },
  },
  {
    name: "library.get", title: "Read a library component", ...libRead,
    description: "One library component (at a version, default the latest): its saved subtree, parameters and latest version number.",
    input: z.object({ componentId: z.string(), version: z.number().int().min(1).optional() }),
    output: z.object({ component: z.unknown(), latestVersion: z.number() }),
    async handler({ principal }: Ctx, i: { componentId: string; version?: number }) {
      const r = getLibrary(principal, i.componentId, i.version);
      const { createdBy: _c, ...component } = r.component;
      void _c;
      return { component, latestVersion: r.latest.version };
    },
  },
  {
    name: "library.save", title: "Save a component to the library", scope: "atrium:edit", effect: "none", surfaces: ["builtin-agent", "mcp"], minRole: "member",
    description: "Saves a component from an app's draft (with everything inside it) to the shared library; data sources and controls become parameters. Give componentId to save a new version of one you may update.",
    input: z.object({ appId, nodeId: z.string(), name: z.string().min(1).max(80), description: z.string().max(300).optional(), tags: z.array(z.string().max(40)).max(20).optional(), componentId: z.string().optional() }),
    output: z.object({ componentId: z.string(), version: z.number(), params: z.array(z.unknown()) }),
    async handler({ principal }: Ctx, i: { appId: string; nodeId: string; name: string; description?: string; tags?: string[]; componentId?: string }) {
      const { doc } = await backend().getDraft(principal, i.appId);
      const hit = findNode(doc, i.nodeId);
      if (!hit) throw new NotFound("That node is not in the draft.");
      const c = saveLibrary(principal, { ...(i.componentId ? { componentId: i.componentId } : {}), name: i.name, description: i.description, tags: i.tags, node: hit.node, sources: doc.dataSources.map((d) => d.name), controls: doc.controls.map((k) => ({ id: k.id, label: k.label })) });
      return { componentId: c.id, version: c.version, params: c.params };
    },
  },
  {
    name: "library.insert", title: "Insert a library component", ...edit,
    description: "Adds an instance of a library component to the draft, pinned to its current version; props fill its parameters (data parameters take a data source name, control parameters a control id).",
    input: z.object({ appId, componentId: z.string(), parentId: z.string(), index: z.number().int().min(0).optional(), slot: slotIn.optional(), props: z.record(z.string(), z.unknown()).optional(), expectRev }),
    output: editOut.extend({ nodeId: z.string() }),
    async handler({ principal }: Ctx, i: { appId: string; componentId: string; parentId: string; index?: number; slot?: z.infer<typeof slotIn>; props?: Record<string, PropValue>; expectRev?: number }) {
      const { component } = getLibrary(principal, i.componentId);
      const node = { ...instanceNodeFor(component), ...(i.slot ? { slot: i.slot } : {}) };
      node.props = { ...node.props, ...(i.props ?? {}) };
      const r = await apply(principal, i.appId, [{ op: "node.add", parentId: i.parentId, ...(i.index !== undefined ? { index: i.index } : {}), node }], i.expectRev);
      return { ...r, nodeId: node.id };
    },
  },
  {
    name: "library.update_instance", title: "Update a library instance", ...edit,
    description: "Moves an instance to another version of its library component (default the latest) and optionally changes its parameter values. Only that instance changes.",
    input: z.object({ appId, nodeId: z.string(), version: z.number().int().min(1).optional(), props: z.record(z.string(), z.unknown()).optional(), expectRev }),
    output: editOut.extend({ version: z.number() }),
    async handler({ principal }: Ctx, i: { appId: string; nodeId: string; version?: number; props?: Record<string, PropValue>; expectRev?: number }) {
      const { doc } = await backend().getDraft(principal, i.appId);
      const hit = findNode(doc, i.nodeId);
      if (!hit?.node.libraryRef) throw new NotFound("That library instance is not in the draft.");
      const r0 = getLibrary(principal, hit.node.libraryRef.componentId, i.version);
      const version = r0.component.version;
      const r = await apply(principal, i.appId, [{ op: "node.update", nodeId: i.nodeId, patch: { libraryRef: { componentId: r0.component.id, version }, ...(i.props ? { props: { ...hit.node.props, ...i.props } } : {}) } }], i.expectRev);
      return { ...r, version };
    },
  },
];

export const tools = componentTools;
