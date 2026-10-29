// The Insert tab's catalogue (design v4 "The Builder", spec 3.1.1 and 3.3.1): every built-in type by
// category with a ready node, then saved library components. The code category is folded by default.
import type { ComponentCategory, ComponentNode, ComponentType, LibraryComponent, Principal } from "@/core/contracts";
import { META } from "./catalogue/meta";
import { newId } from "./ids";
import { instanceNodeFor } from "./library-instance";

export type InsertGroup = { category: ComponentCategory | "library"; title: string; folded: boolean; items: { type: ComponentType; title: string; summary: string; node: ComponentNode; containsCode?: boolean; /** Insert's own id when two items share a type (Card for each is a repeat). */ insertId?: string }[] };

/** The Insert id and node name of the Card for each starter. */
export const CARD_FOR_EACH = "card-for-each";
const ORDER: ComponentCategory[] = ["layout", "data", "content", "control", "code"];
const TITLES: Record<ComponentCategory | "library", string> = { layout: "Layout", data: "Data", content: "Content", control: "Controls", code: "Code", library: "Library" };

let libraryCatalogue: ((principal: Principal) => LibraryComponent[]) | undefined;
/** The library server module registers this, so the Insert tab lists saved components. */
export function registerLibraryCatalogue(fn: (principal: Principal) => LibraryComponent[]): void {
  libraryCatalogue = fn;
}

/** A fresh node of a type, with its defaults and a new id. */
export function newNode(type: keyof typeof META): ComponentNode {
  const meta = META[type];
  const node: ComponentNode = { id: newId("c"), type, props: structuredClone(meta.defaults), ...(meta.container ? { children: [] } : {}), ...(type === "html" ? { name: "HTML block" } : {}) };
  // A new chart lands landscape: 6 columns by 32 rows of 8px (about 240px of chart window, Fix 6).
  const size = NEW_SIZE[type];
  if (size) {
    node.slot = { x: 0, y: 0, ...size.slot };
    Object.assign(node.props, size.props ?? {});
  }
  return node;
}

/**
 * Default sizes for new nodes whose content needs room (the builder reads node.slot's w and h on insert).
 * Boxes are exact (operator, 2026-10-19), so each size is the type's measured content height at its
 * default width plus the cell's gap, rounded up with one row to spare. Types not listed fit 3 by 16.
 */
export const NEW_SIZE: Partial<Record<keyof typeof META, { slot: { w: number; h: number }; props?: Record<string, number | string | boolean> }>> = {
  chart: { slot: { w: 6, h: 35 }, props: { height: 150 } },
  stat: { slot: { w: 3, h: 24 } },
  status: { slot: { w: 3, h: 22 } },
  table: { slot: { w: 3, h: 38 } },
  list: { slot: { w: 3, h: 30 } },
  gauge: { slot: { w: 3, h: 32 } },
  progress: { slot: { w: 3, h: 21 } },
  image: { slot: { w: 3, h: 25 } },
  // 200px default height, same allowance as image; a new video shows whole, like pictures (media layout 3.1).
  video: { slot: { w: 3, h: 30 }, props: { fit: "contain" } },
  // Wave 2.9 (A10.7): a tile is about 100px tall with its numbers; a group is a full row holding a row of tiles.
  "service-tile": { slot: { w: 3, h: 17 } },
  group: { slot: { w: 12, h: 26 } },
  "resource-bar": { slot: { w: 12, h: 9 } },
  bookmarks: { slot: { w: 3, h: 20 } },
  // Wave 2.10a B8 (A11.2 scale): an icon fills its box, and its box hugs it: the 24px icon plus its
  // padding (ICON_HUG_PX square), at most 2 columns. Measured on the 1280px builder in the default
  // theme (columns 28.7px, gap 24px, 6px hard shadow): 1.375 columns by 10 rows is 48 by 50px. Other
  // canvas widths and gaps change a column's px; hugSlot gives the exact slot for a measured canvas.
  icon: { slot: { w: 1.375, h: 10 }, props: { fill: true } },
};

/** The square an inserted icon's box hugs (B8): the 24px icon at half the box, so 12px around it. */
export const ICON_HUG_PX = 48;
/** The share of its box a filling icon draws at (components.css .atr-icon[data-fill]). */
export const ICON_FILL_SHARE = 0.5;

/**
 * The slot that makes a box of `px` square on a measured grid (B8, A7.4 eighths of a column): the column
 * width and gap in px, and the cell's bottom padding (the theme gap plus a hard shadow's offset). The
 * width is at most `maxCols` columns. For the builder's insert, when it wants the exact hug on this canvas.
 */
export function hugSlot(px: number, grid: { colPx: number; gapPx: number; padBottomPx: number; rowPx?: number }, maxCols = 2): { w: number; h: number } {
  const step = grid.colPx + grid.gapPx;
  const w = Math.min(maxCols, Math.max(0.125, Math.round(((px + grid.gapPx) / step) * 8) / 8));
  const widthPx = w * step - grid.gapPx;
  const h = Math.max(1, Math.round((widthPx + grid.padBottomPx) / (grid.rowPx ?? 8)));
  return { w, h };
}

/** Insert lists these first in their category (direct data spec 3.5 and 3.6: easy to find). */
const FIRST: Partial<Record<ComponentCategory, string[]>> = { layout: ["grid", "group"], data: ["service-tile", "resource-bar"], content: ["heading", "text", "bookmarks"] };
const rank = (c: ComponentCategory, t: string) => {
  const i = FIRST[c]?.indexOf(t) ?? -1;
  return i < 0 ? 100 : i;
};

export function insertCatalogue(principal: Principal, opts: { library?: LibraryComponent[] } = {}): InsertGroup[] {
  if (principal.kind === "guest" || principal.role === "viewer") return [];
  const groups: InsertGroup[] = ORDER.map((category) => ({
    category,
    title: TITLES[category],
    folded: category === "code",
    items: Object.values(META)
      .filter((m) => m.category === category)
      .map((m, i) => ({ m, i }))
      .sort((a, b) => rank(category, a.m.type) - rank(category, b.m.type) || a.i - b.i)
      .map(({ m }) => m)
      .map((m) => ({ type: m.type, title: m.title, summary: m.docs.summary, node: newNode(m.type) })),
  }));
  // Card for each (data ease spec 3.2): a ready Repeat whose rows are picked next, one card per row.
  groups[0]!.items.unshift({ type: "repeat", insertId: CARD_FOR_EACH, title: "Card for each", summary: "One ready card per row of a list, such as one per machine.", node: { ...newNode("repeat"), name: "Card for each", props: { columns: 3, max: 50, empty: "Nothing to show" }, slot: { x: 0, y: 0, w: 12, h: 24 } } });
  const lib = opts.library ?? libraryCatalogue?.(principal) ?? [];
  if (lib.length) {
    groups.push({
      category: "library",
      title: TITLES.library,
      folded: false,
      items: lib.map((c) => ({ type: `lib:${c.id}` as ComponentType, title: c.name, summary: c.description ?? "", node: instanceNodeFor(c), containsCode: c.containsCode })),
    });
  }
  return groups;
}
