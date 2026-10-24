// Publish review warnings (Wave 2.7 data ease spec 3.6, criterion 19): sources nothing uses (with a
// Remove), a widget whose data is the wrong kind, a widget fully covered by another, a bound field
// that shows no data, and (Wave 2.8, recipes spec 3.2) a widget whose read failed its live check. Pure: the caller passes what each source returns (its cached data and its kind).
// Each warning names the component (pageId, nodeId) so the review's "Show the component" selects it.
import type { AppDocument, ComponentNode, DataShapeKind, GridSlot, Problem, ShapedData } from "@/core/contracts";
import { evaluateTemplate, isBinding, sourcesInTemplate, templatesIn } from "@/features/components/bindings";
import { metaFor } from "@/features/components/catalogue/meta";
import { nodeLabel, orderedPages, walk } from "./doc";

/** The `where.field` of an unused-source warning: the review's Remove reads the name from it. */
export const UNUSED_FIELD = "dataSources.";
export const unusedSourceName = (p: Problem) => (p.code === "source.unused" && p.where.field?.startsWith(UNUSED_FIELD) ? p.where.field.slice(UNUSED_FIELD.length) : null);

const KIND_WORDS: Record<DataShapeKind, string> = { stat: "one number", series: "values over time", table: "a list of rows", status: "things that are up or down" };

function warn(code: string, message: string, where: Problem["where"], fix?: string): Problem {
  return { severity: "warning", code, where, message, ...(fix ? { fix } : {}) };
}

function readsSource(n: ComponentNode, name: string): boolean {
  const temps = [...templatesIn(n.props as never, "props"), ...(n.responsive?.mobile?.props ? templatesIn(n.responsive.mobile.props as never, "props") : []), ...(isBinding(n.visibleWhen) ? [{ path: "visibleWhen", template: n.visibleWhen.$bind }] : [])];
  if (n.type.startsWith("lib:") && Object.values(n.props).some((v) => v === name)) return true;
  return temps.some((t) => sourcesInTemplate(t.template).includes(name));
}

const covers = (a: GridSlot, b: GridSlot) => a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h;

/** `failed`: why the source's read failed its last live check on its server (A9.2), when it did. */
export type SourceFacts = { data?: ShapedData; kind?: DataShapeKind; failed?: string };

/** The app sources a node reads (props, phone props, visibleWhen; a library instance's source props). */
function sourcesOfNode(n: ComponentNode, names: readonly string[]): string[] {
  return names.filter((name) => readsSource(n, name));
}

export function reviewWarnings(doc: AppDocument, facts: (name: string) => SourceFacts): Problem[] {
  const out: Problem[] = [];
  const pages = orderedPages(doc);
  const failed = new Map(doc.dataSources.flatMap((s) => { const why = facts(s.name).failed; return why ? [[s.name, why] as const] : []; }));
  const failedNames = [...failed.keys()];
  // Sources nothing uses.
  for (const s of doc.dataSources) {
    // A10.1: a managed source nothing uses is removed with the change that left it unused, never warned about.
    if (s.managed) continue;
    let used = false;
    for (const p of doc.pages) for (const l of walk(p)) if (!used && readsSource(l.node, s.name)) used = true;
    if (!used) out.push(warn("source.unused", `${s.label?.trim() || s.name} is not shown by any widget.`, { field: `${UNUSED_FIELD}${s.name}` }, "Remove it, or show it on a widget."));
  }
  for (const page of pages) {
    for (const l of walk(page)) {
      const n = l.node;
      const meta = metaFor(n.type);
      // A read that failed its last live check on its server (recipes spec 3.2, criterion 5).
      for (const name of sourcesOfNode(n, failedNames)) {
        const s = doc.dataSources.find((d) => d.name === name)!;
        const why = failed.get(name)!;
        out.push(warn("data.read_failed", `${nodeLabel(n)} on ${page.title} reads ${s.label?.trim() || s.name}, which stopped working on its server: ${/[.!?]$/.test(why) ? why : `${why}.`}`, { pageId: page.id, nodeId: n.id }, "Open its Data group and pick another read, or check the integration."));
      }
      // The wrong kind of data on a widget's whole-source prop.
      const wholeKey = n.type === "repeat" || n.type === "list" ? "items" : meta?.accepts ? "data" : null;
      const whole = wholeKey ? n.props[wholeKey] : undefined;
      if (meta?.accepts && wholeKey && isBinding(whole)) {
        const m = /^\{\{\s*([a-z][a-z0-9_]*)(?:\.(rows|items))?\s*\}\}$/.exec(whole.$bind.trim());
        const f = m ? facts(m[1]!) : undefined;
        const kind = f?.data?.kind ?? f?.kind;
        if (m && kind && !meta.accepts.includes(kind)) {
          out.push(warn("data.wrong_kind", `${nodeLabel(n)} on ${page.title} shows ${KIND_WORDS[kind]}, which a ${meta.title.toLowerCase()} cannot show.`, { pageId: page.id, nodeId: n.id, field: wholeKey }, `Open its Data group and pick a ${meta.accepts.map((a) => KIND_WORDS[a]).join(" or ")}, or show it as another kind of widget.`));
          continue;
        }
      }
      // A bound field that shows nothing (only when the source has data to judge by).
      for (const t of templatesIn(n.props as never, "props")) {
        const roots = sourcesInTemplate(t.template);
        if (!roots.length || /\$item|\$index|\$param|\$input/.test(t.template)) continue;
        const data: Record<string, ShapedData | undefined> = {};
        let known = true;
        for (const r of roots) { const d = facts(r).data; if (!d) known = false; data[r] = d; }
        if (!known) continue;
        const r = evaluateTemplate(t.template, { $data: data, $page: { id: page.id, slug: page.slug, title: page.title }, $app: { id: "", slug: "", name: doc.app.name }, $user: { kind: "user" } } as never);
        const empty = !r.ok || r.value === undefined || r.value === null || r.value === "" || (Array.isArray(r.value) && r.value.length === 0);
        if (empty) {
          const prop = t.path.replace(/^props\./, "");
          out.push(warn("data.no_value", `${nodeLabel(n)} on ${page.title} shows no data in ${prop}.`, { pageId: page.id, nodeId: n.id, field: prop }, r.ok ? "The value it picks is not in the data right now: pick it again in its Data group." : `${r.error.message}`));
          break;
        }
      }
    }
    // A widget fully covered by a later one in the same grid (drawn on top of it) on desktop.
    for (const l of walk(page)) {
      if (l.node.type !== "grid") continue;
      const kids = (l.node.children ?? []).filter((k) => k.slot && !k.hidden);
      kids.forEach((a, i) => {
        const over = kids.slice(i + 1).find((b) => covers(b.slot!, a.slot!));
        if (over) out.push(warn("layout.covered", `${nodeLabel(a)} on ${page.title} is hidden under ${nodeLabel(over)}.`, { pageId: page.id, nodeId: a.id }, "Move it beside the other widget, or remove it."));
      });
    }
  }
  return out;
}
