// Wave 2.10b F4 (spec 4 F4, criterion 12): a setting whose effect cannot show right now says why, in
// place of its hint ("Needs Show a clock on"). Pure: the inspector passes the node's props and what it
// knows about the page; null means the setting shows now and the hint stays.
import { SAFE_HREF as HREF_RE } from "../render/tiles-logic";

export type ReasonEnv = {
  /** The widget's main value as it is now, when it is a number (typed, or from its data). */
  valueNow: number | null;
  /** Whether the widget's value comes from data (a binding), so a source time can exist. */
  bound: boolean;
  /** This app's pages, to tell whether a page reference finds one. */
  pages: readonly { id: string; slug: string }[];
  /** How many children the node holds (layouts and groups). */
  children: number;
  /** The kind of the widget's data now ("table", "list", "stat"...), or null when it has none. */
  dataKind?: string | null;
  /** The type of the node's parent ("grid", "stack", "card"...). */
  parentType?: string | null;
};

const SCREEN_READER = "Read aloud by screen readers; nothing changes on screen";
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const rows = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""));

/** Why `type.key` cannot show its effect right now, or null when it can. */
export function fieldReason(type: string, key: string, props: Record<string, unknown>, env: ReasonEnv): string | null {
  const k = `${type}.${key}`;
  // Thresholds: the colour only changes once the value reaches the number.
  if ((key === "warn" || key === "bad") && (type === "stat" || type === "gauge" || type === "progress")) {
    const t = num(props[key]);
    if (t === null) return null;
    if (env.valueNow === null) return "Shows once the value is a number that reaches it";
    if (env.valueNow < t) return `Shows once the value reaches ${fmt(t)} (it is ${fmt(env.valueNow)} now)`;
    if (key === "warn") {
      const bad = num(props.bad);
      if (bad !== null && env.valueNow >= bad) return "Problem from wins while the value is past it";
    }
    return null;
  }
  // A bar or dial that is already full (or empty) cannot move further.
  if (key === "value" && (type === "progress" || type === "gauge") && env.valueNow !== null) {
    const lo = num(props.min) ?? 0;
    const hi = num(props.max) ?? 100;
    const full = type === "progress" ? "Full at" : "Highest";
    const empty = type === "progress" ? "Empty at" : "Lowest";
    if (hi <= lo) return `Needs ${full} above ${empty} (now ${fmt(lo)} to ${fmt(hi)})`;
    if (env.valueNow >= hi) return `At or past ${full} (${fmt(hi)}), so it is drawn full`;
    if (env.valueNow <= lo) return `At or below ${empty} (${fmt(lo)}), so it is drawn empty`;
    return null;
  }
  if (key === "showUpdated") return props.showUpdated === true && !env.bound ? "Needs live data: a typed value has no update time" : null;
  if (key === "decimals" && type === "stat") return env.valueNow === null && props.decimals !== undefined && props.decimals !== null ? "Only for numbers; this value is text" : null;
  switch (k) {
    case "resource-bar.clockFormat":
      return props.clock !== true ? "Needs Show a clock on" : null;
    case "resource-bar.searchUrl":
      return props.search !== true ? "Needs Show a search box on" : "Used when someone searches; nothing changes on screen";
    case "clock.seconds":
    case "clock.hour12":
      return props.show === "date" ? "Needs Show set to Time, or Time and date" : null;
    case "video.sound":
      return props.controls !== true ? "Needs Show controls on" : null;
    case "icon.label":
    case "image.alt":
    case "video.alt":
      return SCREEN_READER;
    case "service-tile.newTab":
      return typeof props.href === "string" && HREF_RE.test(props.href.trim()) ? "Takes effect when a viewer clicks the tile; nothing changes here" : "Needs an Opens address (http or https)";
    case "service-tile.href":
    case "link.href": {
      const what = type === "link" ? "link" : "tile";
      const href = typeof props.href === "string" ? props.href.trim() : "";
      if (!href) return null;
      return HREF_RE.test(href) ? `Opens when a viewer clicks the ${what}; nothing changes here` : `Not an http or https address, so the ${what} opens nothing`;
    }
    case "link.page": {
      const ref = typeof props.page === "string" ? props.page.trim() : "";
      if (!ref) return null;
      return env.pages.some((p) => p.id === ref || p.slug === ref) ? "Opens that page when a viewer clicks the link; nothing changes here" : "No page of this app has that id or address";
    }
    case "table.columns":
    case "table.maxRows":
      return env.dataKind !== undefined && env.dataKind !== "table" ? "Needs table data in Rows from" : null;
    case "list.labelKey":
    case "list.detailKey":
      return env.dataKind !== undefined && env.dataKind !== "table" && env.dataKind !== "list" && env.dataKind !== "status" ? "Needs a list in Lines from" : null;
    case "divider.spacing":
      return env.parentType === "grid" ? "In a grid the box sets the space around the line; this shows in a stack or card" : null;
    case "card.subtitle":
      return typeof props.subtitle === "string" && props.subtitle.trim() && !(typeof props.title === "string" && props.title.trim()) ? "Needs a Title" : null;
    case "card.padded":
    case "group.columns":
    case "group.fixedHeight":
    case "stack.direction":
    case "stack.gap":
    case "stack.align":
    case "stack.wrap":
    case "grid.gap":
    case "grid.columns":
    case "repeat.columns":
    case "repeat.gap":
      return env.children === 0 ? (type === "group" ? "Needs tiles inside the group" : "Needs something inside it") : key === "wrap" && props.direction !== "horizontal" ? "Needs Direction set to Side by side" : null;
    case "bookmarks.columns":
      return rows(props.items) < 2 ? "Shows with two or more bookmarks" : null;
    case "list.maxItems": {
      const max = num(props.maxItems);
      const n = rows(props.items);
      return max !== null && n > 0 && n <= max ? `Shows when there are more than ${fmt(max)} lines (there are ${n})` : null;
    }
    case "repeat.max": {
      const max = num(props.max);
      const n = rows(props.items);
      return max !== null && n > 0 && n <= max ? `Shows when there are more than ${fmt(max)} rows (there are ${n})` : null;
    }
    case "repeat.empty":
      return rows(props.items) > 0 || props.items === undefined ? "Shows only while the list is empty" : null;
    case "tabs.initial":
      return "Takes effect when the app opens; here you can click any tab";
    default:
      return null;
  }
}
