// Shape-based suggestion (architecture v3 section 4.4, spec 3.4): stat gives stat; series gives chart;
// table gives table, or list with 2 columns or fewer; status gives status, or stat with one item.
import type { ComponentNode, ComponentType, DataShapeKind, ShapedData } from "@/core/contracts";
import { newId } from "./ids";

const bind = (t: string) => ({ $bind: t });

/** The component type the rules pick for a shape (and, when known, the data's size). */
export function suggestedType(shape: DataShapeKind, data?: ShapedData): ComponentType {
  if (shape === "stat") return "stat";
  if (shape === "series") return "chart";
  if (shape === "table") return data?.kind === "table" && data.columns.length <= 2 ? "list" : "table";
  return data?.kind === "status" && data.items.length === 1 ? "stat" : "status";
}

/** A ready-to-insert component with its props bound to the source. */
export function suggestComponent(shape: DataShapeKind, source: string, data?: ShapedData): ComponentNode {
  const type = suggestedType(shape, data);
  const id = newId("c");
  const name = source.replace(/_/g, " ");
  switch (type) {
    case "stat":
      if (shape === "status") return { id, type, name, props: { value: bind(`{{ ${source}.first.state | upper }}`), label: bind(`{{ ${source}.first.label }}`) } };
      return { id, type, name, props: { data: bind(`{{ ${source} }}`) } };
    case "chart":
      return { id, type, name, props: { data: bind(`{{ ${source} }}`), kind: "line" } };
    case "list": {
      const cols = data?.kind === "table" ? data.columns : [];
      return { id, type, name, props: { items: bind(`{{ ${source}.rows }}`), ...(cols[0] ? { labelKey: cols[0].key } : {}), ...(cols[1] ? { detailKey: cols[1].key } : {}) } };
    }
    case "table":
      return { id, type, name, props: { data: bind(`{{ ${source} }}`) } };
    default:
      return { id, type: "status", name, props: { data: bind(`{{ ${source} }}`) } };
  }
}
