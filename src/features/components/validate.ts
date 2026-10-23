// The component-level part of `validate` (architecture v3 section 9b, spec 3.1 and 3.2): schemas,
// bindings, controls, containers, links, html blocks and style values. app-builder adds layout,
// pages, contrast and the rest. Pure and isomorphic.
import type { AppDocument, ComponentNode, LibraryComponent, PageDoc, Problem, PropValue, ShapedData } from "@/core/contracts";
import { evaluateTemplate, isBinding, templatesIn } from "./bindings";
import { parseTemplate, pathsOf, rootsOf } from "./bindings/parse";
import { metaFor, propsSchemas } from "./catalogue/meta";
import { packagePropsSchema, libraryPropsSchema } from "./catalogue/schemas";
import { ID_RE } from "./ids";
import { compileStyle, refusalText } from "./style/compile";
import { isLayoutType, LAYOUT_CSS_REFUSAL } from "./style/node-css-policy";
import { libKey } from "./render/resolve";

export type ValidateOptions = {
  /** Current data per source: when given, binding paths are checked against it. */
  data?: Record<string, ShapedData | undefined>;
  /** Library components by `id@version`, to check instances. */
  library?: Record<string, LibraryComponent>;
  /** Only this page. */
  pageId?: string;
};

const SAFE_HREF = /^https?:\/\//i;

function issuePath(path: PropertyKey[]): string {
  return path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("").replace(/^\./, "");
}

export function validateNodes(doc: AppDocument, opts: ValidateOptions = {}): Problem[] {
  const problems: Problem[] = [];
  const sources = new Set(doc.dataSources.map((d) => d.name));
  const controls = new Set(doc.controls.map((c) => c.id));
  const seen = new Map<string, string>();
  const pageSlugs = new Set(doc.pages.flatMap((p) => [p.id, p.slug]));

  const checkTemplate = (template: string, where: Problem["where"], ctx: { inRepeat: boolean; inLibrary: boolean }) => {
    try {
      parseTemplate(template);
    } catch (e) {
      problems.push({ severity: "error", code: "binding.syntax", where, message: (e as Error).message, fix: "Fix the expression inside {{ }}." });
      return;
    }
    for (const r of rootsOf(template)) {
      if (r.startsWith("$")) {
        if ((r === "$item" || r === "$index") && !ctx.inRepeat) problems.push({ severity: "error", code: "binding.repeat_only", where, message: `${r} works only inside a repeat.`, fix: "Move this component into a repeat, or bind a data source instead." });
        if (r === "$param" && !ctx.inLibrary) problems.push({ severity: "warning", code: "binding.param_outside", where, message: "$param works only inside a library component; here it shows nothing." });
        if (!["$item", "$index", "$input", "$page", "$app", "$viewer", "$user", "$now", "$param", "$data"].includes(r)) problems.push({ severity: "error", code: "binding.unknown_root", where, message: `"${r}" is not a binding root.` });
        continue;
      }
      if (!sources.has(r)) problems.push({ severity: "error", code: "binding.unknown_source", where, message: `No data source named "${r}" yet.`, fix: `Add a data source named "${r}", or bind one of: ${[...sources].join(", ") || "(none yet)"}.` });
    }
    if (opts.data && !rootsOf(template).some((r) => r.startsWith("$") && r !== "$now" && r !== "$page" && r !== "$app" && r !== "$viewer")) {
      const scope = { $data: opts.data, $page: { id: "", slug: "", title: "" }, $app: { id: "", slug: "", name: doc.app.name }, $user: { kind: "user" as const }, $now: 0 };
      const r = evaluateTemplate(template, scope);
      if (!r.ok && r.error.code !== "binding.unknown_source") problems.push({ severity: "error", code: r.error.code, where, message: r.error.message });
      else if (r.ok) {
        for (const p of pathsOf(template)) {
          const [root, ...rest] = p.split(".");
          if (!root || root.startsWith("$") || !rest.length || !opts.data[root]) continue;
          let cur: unknown = opts.data[root];
          for (const seg of rest) {
            if (seg === "$state" || seg === "$updatedAt" || seg === "first") { cur = undefined; break; }
            cur = cur && typeof cur === "object" && Object.prototype.hasOwnProperty.call(cur, seg) ? (cur as Record<string, unknown>)[seg] : Symbol.for("missing");
            if (cur === Symbol.for("missing")) {
              problems.push({ severity: "warning", code: "binding.unknown_path", where, message: `${p} does not exist in the current data of "${root}".`, fix: "Check the field name against the source's current data." });
              break;
            }
          }
        }
      }
    }
  };

  const visit = (n: ComponentNode, page: PageDoc, parent: ComponentNode | null, ctx: { inRepeat: boolean; inLibrary: boolean }) => {
    const where = (field?: string): Problem["where"] => ({ pageId: page.id, nodeId: n.id, ...(field ? { field } : {}) });
    if (!ID_RE.node.test(n.id) && !ctx.inLibrary) problems.push({ severity: "error", code: "node.bad_id", where: where(), message: `"${n.id}" is not a valid node id (c_ and 10 letters or digits 2 to 7).` });
    if (seen.has(n.id)) problems.push({ severity: "error", code: "node.duplicate_id", where: where(), message: `The id ${n.id} is used twice.` });
    seen.set(n.id, page.id);

    const meta = metaFor(n.type);
    if (!meta && !n.type.startsWith("pkg:") && !n.type.startsWith("lib:")) {
      problems.push({ severity: "error", code: "node.unknown_type", where: where(), message: `"${n.type}" is not a component type.`, fix: "Use components.catalog to see the types." });
      return;
    }
    // props
    const schema = meta ? propsSchemas[meta.type] : n.type.startsWith("pkg:") ? packagePropsSchema : libraryPropsSchema;
    const parsed = schema.safeParse(n.props ?? {});
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issuePath(issue.path) || "props";
        problems.push({ severity: "error", code: "props.invalid", where: where(field), message: `${field}: ${issue.message}`, fix: meta ? `See components.schema for "${meta.type}".` : undefined });
      }
    }
    if (n.responsive?.mobile?.props) {
      const m = (meta ? propsSchemas[meta.type] : libraryPropsSchema).safeParse({ ...n.props, ...n.responsive.mobile.props });
      if (!m.success) for (const issue of m.error.issues) problems.push({ severity: "error", code: "props.invalid", where: where(`mobile.${issuePath(issue.path)}`), message: `On phones, ${issuePath(issue.path)}: ${issue.message}` });
    }
    // bindings
    const allProps = { ...n.props, ...(n.responsive?.mobile?.props ?? {}) };
    for (const { path, template } of templatesIn(allProps as PropValue, "")) checkTemplate(template, where(path.replace(/^\./, "")), ctx);
    if (n.visibleWhen) {
      if (isBinding(n.visibleWhen)) checkTemplate(n.visibleWhen.$bind, where("visibleWhen"), ctx);
      else problems.push({ severity: "error", code: "binding.invalid", where: where("visibleWhen"), message: "The visibility rule must be a binding." });
    }
    // controls
    if (meta?.category === "control") {
      const c = n.props.control;
      if (c === undefined || c === null || c === "") problems.push({ severity: "warning", code: "control.missing", where: where("control"), message: `This ${meta.title.toLowerCase()} runs nothing yet.`, fix: "Pick one of the app's controls." });
      else if (typeof c === "string" && !controls.has(c)) problems.push({ severity: "error", code: "control.unknown", where: where("control"), message: `The control ${c} is not one of this app's controls.` });
    }
    if (n.type === "html") {
      for (const c of (Array.isArray(n.props.controls) ? n.props.controls : []) as unknown[]) {
        if (typeof c === "string" && !controls.has(c)) problems.push({ severity: "error", code: "html.unknown_control", where: where("controls"), message: `The block lists ${c}, which is not one of this app's controls.` });
      }
      if (!n.name?.trim()) problems.push({ severity: "warning", code: "html.unnamed", where: where("name"), message: "This HTML block has no name. Its frame's accessible title comes from the name.", fix: "Give the block a short name, like \"CPU chart\"." });
    }
    if (n.type === "link") {
      const href = n.props.href;
      if (typeof href === "string" && href && !SAFE_HREF.test(href)) problems.push({ severity: "error", code: "link.scheme", where: where("href"), message: "Links open only http and https addresses; this one is drawn inert.", fix: "Use an address starting with https://." });
      const pg = n.props.page;
      if (typeof pg === "string" && pg && !pageSlugs.has(pg)) problems.push({ severity: "error", code: "link.unknown_page", where: where("page"), message: `There is no page "${pg}" in this app.` });
    }
    // containers
    if (n.children?.length) {
      if (meta && !meta.container) problems.push({ severity: "error", code: "node.not_container", where: where(), message: `A ${meta.title.toLowerCase()} cannot hold other components.` });
      if (meta?.maxChildren !== undefined && n.children.length > meta.maxChildren) problems.push({ severity: "error", code: "repeat.children", where: where(), message: "A repeat draws exactly one child; wrap several in a stack or card." });
    }
    if (n.type === "repeat" && !n.children?.length) problems.push({ severity: "warning", code: "repeat.empty", where: where(), message: "This repeat has nothing to repeat yet.", fix: "Drop one component into it." });
    // library instances
    if (n.type.startsWith("lib:")) {
      if (!n.libraryRef) problems.push({ severity: "error", code: "library.no_ref", where: where(), message: "A library instance needs its library reference." });
      else if (opts.library && !opts.library[libKey(n.libraryRef.componentId, n.libraryRef.version)]) problems.push({ severity: "error", code: "library.missing", where: where(), message: `Library component ${n.libraryRef.componentId} version ${n.libraryRef.version} is missing.` });
      for (const v of Object.values(n.props)) if (typeof v === "string" && /^k_/.test(v) && !controls.has(v)) problems.push({ severity: "error", code: "control.unknown", where: where(), message: `The control ${v} is not one of this app's controls.` });
    }
    // style
    if (n.overrideTheme && (n.style || n.responsive?.mobile?.style)) {
      const { refused } = compileStyle(n.style, { slots: meta?.styleSlots ?? ["root"], states: meta?.states, mobile: n.responsive?.mobile?.style, layout: isLayoutType(n.type) });
      for (const r of refused) problems.push({ severity: "warning", code: "style.refused", where: where(`style.${r.slot}.${r.prop}`), message: refusalText(r) });
    }
    if (n.css && n.css.length > 65536) problems.push({ severity: "error", code: "css.too_long", where: where("css"), message: "Node CSS is limited to 64 KB." });
    if (n.css && n.css.trim() && isLayoutType(n.type)) problems.push({ severity: "warning", code: "css.layout_ignored", where: where("css"), message: `This ${meta?.title ?? n.type}'s CSS is ignored: ${LAYOUT_CSS_REFUSAL}`, fix: "Open Advanced and remove the ignored CSS." });
    for (const c of n.children ?? []) visit(c, page, n, { inRepeat: ctx.inRepeat || n.type === "repeat", inLibrary: ctx.inLibrary });
    void parent;
  };

  for (const page of doc.pages) {
    if (opts.pageId && page.id !== opts.pageId && page.slug !== opts.pageId) continue;
    const meta = metaFor(page.root.type);
    if (!meta?.container) problems.push({ severity: "error", code: "page.root_not_container", where: { pageId: page.id, nodeId: page.root.id }, message: "A page's root must be a container (grid, stack, card, section or tabs)." });
    visit(page.root, page, null, { inRepeat: false, inLibrary: false });
  }
  return problems;
}

/** Validates a lone subtree (library components, examples) inside a document that has the example sources. */
export function validateSubtree(node: ComponentNode, doc: Pick<AppDocument, "dataSources" | "controls">, opts: { inLibrary?: boolean } = {}): Problem[] {
  const page: PageDoc = { id: "p_validatexx", slug: "check", title: "Check", inNav: true, root: { id: "c_validroota", type: "stack", props: {}, children: [node] } };
  const full: AppDocument = { format: "atrium-app", formatVersion: 1, app: { name: "check", homePage: page.id, pageOrder: [page.id] }, theme: { themeId: "control-room" }, chrome: { layout: "none" }, dataSources: doc.dataSources, controls: doc.controls, pages: [page] };
  const problems = validateNodes(full);
  return opts.inLibrary ? problems.filter((p) => p.code !== "binding.param_outside" && p.code !== "node.bad_id") : problems;
}
