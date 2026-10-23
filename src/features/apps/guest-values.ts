// Bindings a guest can be given at page load (gauntlet w2-r3 item 4): a template that reads no data
// source, no clock and no per-item value (`{{ 41.27 | round(1) }}`, `{{ $page.title | upper }}`). Its
// result depends only on the published document the guest already receives, so resolving it on the
// server leaks nothing; without this, nothing streams for it and the guest saw an empty stat. Pure.
import type { ComponentNode, PageDoc, PropValue } from "@/core/contracts";
import { rootsOf } from "@/features/components/bindings";
import { valueKey } from "@/features/components/render/resolve";

/** The only `$` roots a source-free template may read: fixed facts about the page, the app and the viewer kind. */
const SAFE_ROOTS = new Set(["$page", "$app", "$user"]);

/**
 * True when a template's value is fixed by the published document alone: every root it reads is one of
 * SAFE_ROOTS (a data source name, `$data`, `$now`, `$item`, `$sources` and the rest all say no).
 */
export function sourceFree(template: string): boolean {
  return rootsOf(template).every((r) => SAFE_ROOTS.has(r));
}

function bindingsIn(v: unknown, out: string[] = []): string[] {
  if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as { $bind?: unknown }).$bind === "string") out.push((v as { $bind: string }).$bind);
  else if (Array.isArray(v)) for (const x of v) bindingsIn(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) bindingsIn(x, out);
  return out;
}

/**
 * The guest value keys ("nodeId:prop", "nodeId:prop@mobile", "nodeId:$visible") of a page whose
 * bindings are all source-free. Repeat items and library instances are left to the stream (their
 * values depend on items or on the library version), as are html blocks' data maps.
 */
export function sourceFreeKeys(page: Pick<PageDoc, "root">): Set<string> {
  const keys = new Set<string>();
  const props = (id: string, p: Record<string, PropValue> | undefined, suffix: string, type: string) => {
    for (const [k, v] of Object.entries(p ?? {})) {
      if (type === "html" && k === "data") continue;
      const found = bindingsIn(v);
      if (found.length > 0 && found.every(sourceFree)) keys.add(valueKey(id, `${k}${suffix}`));
    }
  };
  const visit = (n: ComponentNode) => {
    if (n.type.startsWith("lib:")) return;
    props(n.id, n.props, "", n.type);
    const mobile = n.responsive?.mobile?.props as Record<string, PropValue> | undefined;
    if (mobile) props(n.id, mobile, "@mobile", n.type);
    const vis = n.visibleWhen as unknown;
    if (vis) {
      const found = bindingsIn(vis);
      if (found.length > 0 && found.every(sourceFree)) keys.add(valueKey(n.id, "$visible"));
    }
    if (n.type === "repeat") return;
    for (const c of n.children ?? []) visit(c);
  };
  visit(page.root);
  return keys;
}
