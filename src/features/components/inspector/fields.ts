// Inspector field kinds derived from the props schemas (so the catalogue stays the single source).
import type { ZodType } from "zod";
import { propsSchemas, type BuiltInType } from "../catalogue/schemas";
import { isSimple, wordsFor } from "./labels";

export type FieldKind =
  | { kind: "text"; long?: boolean }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "enum"; options: (string | number)[] }
  | { kind: "strings" }
  | { kind: "options" }
  | { kind: "json" }
  | { kind: "data" };

export type FieldSpec = {
  key: string;
  /** The written label (labels.ts); the generated one only for a prop no table names. */
  label: string;
  /** The schema's full description (agents read it too); shown as the field's tooltip. */
  description: string;
  /** The one-line hint under the field (builder ease spec 3.2). */
  hint: string;
  /** In its group's simple set; anything else folds under "More settings". */
  simple: boolean;
  /** Words for enum values. */
  optionWords?: Record<string, string>;
  bindable: boolean;
  field: FieldKind;
  group: "content" | "data" | "control";
};

type Def = { type: string; innerType?: ZodType; options?: ZodType[]; entries?: Record<string, string>; values?: unknown[]; element?: ZodType; shape?: Record<string, ZodType> };
const def = (s: ZodType): Def => (s as unknown as { _zod: { def: Def } })._zod.def;

/** Props that hold data (the Data panel) rather than content. */
const DATA_KEYS = new Set(["data", "items", "value", "state", "delta"]);
const LONG_TEXT = new Set(["text", "description"]);
/** Wave 2.9: where the list props of the new components sit (a tile's numbers are data; bookmarks are content). */
const GROUP_OF: Record<string, FieldSpec["group"]> = { "service-tile.stats": "data", "service-tile.status": "data", "resource-bar.items": "data", "bookmarks.items": "content", "chart.lines": "data", "service-tile.description": "content" };

function kindOf(s: ZodType): { field: FieldKind; bindable: boolean } {
  let d = def(s);
  if (d.type === "optional") d = def(d.innerType!);
  let bindable = false;
  if (d.type === "union") {
    const opts = d.options!.filter((o) => {
      const od = def(o);
      const isBinding = od.type === "object" && !!od.shape && "$bind" in od.shape;
      if (isBinding) bindable = true;
      return !isBinding;
    });
    if (opts.length === 1) d = def(opts[0]!);
    else if (opts.every((o) => def(o).type === "literal")) return { field: { kind: "enum", options: opts.flatMap((o) => (def(o).values ?? []) as (string | number)[]) }, bindable };
    else return { field: { kind: "json" }, bindable };
  }
  switch (d.type) {
    case "string":
      return { field: { kind: "text" }, bindable };
    case "number":
      return { field: { kind: "number" }, bindable };
    case "boolean":
      return { field: { kind: "boolean" }, bindable };
    case "enum":
      return { field: { kind: "enum", options: Object.values(d.entries ?? {}) }, bindable };
    case "array":
      return def(d.element!).type === "string" ? { field: { kind: "strings" }, bindable } : def(d.element!).type === "object" ? { field: { kind: "options" }, bindable } : { field: { kind: "json" }, bindable };
    case "unknown":
      return { field: { kind: "data" }, bindable: true };
    default:
      return { field: { kind: "json" }, bindable };
  }
}

/** Sentence case ("showUpdated" reads "Show updated"): only a fallback now, every built-in prop has written words. */
export const labelOf = (k: string) => k.replace(/([A-Z])/g, " $1").toLowerCase().replace(/^./, (c) => c.toUpperCase());

export function fieldsFor(type: BuiltInType): FieldSpec[] {
  const schema = propsSchemas[type] as unknown as { shape: Record<string, ZodType & { description?: string }> };
  return Object.entries(schema.shape).map(([key, s]) => {
    const { field, bindable } = kindOf(s);
    const group: FieldSpec["group"] = GROUP_OF[`${type}.${key}`] ?? (key === "control" || (type === "html" && key === "controls") ? "control" : DATA_KEYS.has(key) || field.kind === "data" ? "data" : "content");
    const f: FieldKind = field.kind === "text" && LONG_TEXT.has(key) ? { kind: "text", long: true } : field;
    const w = wordsFor(type, key);
    return { key, label: w?.label ?? labelOf(key), description: s.description ?? "", hint: w?.hint ?? s.description ?? "", simple: isSimple(type, key), ...(w?.options ? { optionWords: w.options } : {}), bindable, field: f, group };
  });
}
