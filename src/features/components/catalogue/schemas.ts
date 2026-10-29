// Props schemas for every built-in component type (architecture v3 section 4.4). Every field has a
// plain description: agents, the inspector and the schema tool read them. Any field may also be a
// binding ({ $bind: "{{ ... }}" }), except where a literal is required (control ids, html code).
import { z } from "zod";
import { MAX_TEMPLATE_BYTES } from "../bindings/parse";

export const bindingSchema = z
  .strictObject({ $bind: z.string().max(MAX_TEMPLATE_BYTES).describe("A binding template, for example {{ cpu.value | round(1) }}%") })
  .describe("A binding: the value comes from data");

/** A field that takes a literal of `schema` or a binding. */
export function b<T extends z.ZodType>(schema: T, desc: string) {
  return z.union([schema, bindingSchema]).optional().describe(desc);
}
/** A literal-only field. */
export function lit<T extends z.ZodType>(schema: T, desc: string) {
  return schema.optional().describe(desc);
}

const text = z.string().max(4000);
const showUpdated = lit(z.boolean(), "Show a small \"Last updated\" badge with the source's own timestamp. Off by default.");
const controlId = z.string().regex(/^k_[a-z2-7]{10}$/, "a control id like k_abcdefghij");
const controlField = (desc: string) => lit(z.union([controlId, bindingSchema]), desc);
const paint = z.string().max(200);

export const ICON_NAMES = [
  "home", "server", "cpu", "memory", "disk", "network", "wifi", "light", "power", "thermometer", "droplet", "sun", "moon",
  "lock", "unlock", "bell", "play", "pause", "plug", "chart", "clock", "check", "warning", "info", "star", "heart", "door", "camera", "film", "music",
  // Wave 2.9 (A10.7): service icons, and the official packages' own glyphs by package id.
  "shield", "cloud", "database", "globe", "download", "upload", "search", "box", "terminal", "mail", "calendar", "book", "tv", "photo", "code", "folder",
  "link", "gauge", "activity", "router", "printer", "gamepad", "users", "bookmark", "rss", "key", "settings", "note", "phone", "speaker", "bolt", "battery",
  "fan", "cart", "git", "robot", "list", "grid", "container",
  "prometheus", "npm", "pfsense", "proxmox", "docker", "uptime-kuma", "home-assistant", "custom-api", "atrium",
] as const;
export type IconName = (typeof ICON_NAMES)[number];

/** A10.7: a built-in icon name, a package id written "pkg:<id>", or an uploaded picture (/uploads/...). */
export const UPLOAD_PATH = /^\/uploads\/[A-Za-z0-9_][A-Za-z0-9._/-]*$/;
export const iconRef = z.string().max(2000).regex(/^(pkg:[a-z0-9][a-z0-9-]{0,62}|[a-z][a-z0-9-]{0,40}|\/uploads\/[A-Za-z0-9_][A-Za-z0-9._/-]*)$/, "a built-in icon name, pkg:<package id>, or an /uploads/ path");
const valueFormat = z.enum(["percent", "bytes", "bytesPerSec", "seconds", "celsius", "number"]);
/** A value that may be a literal or a binding (the stats and items of A10.7 hold their bindings inside). */
const valueOrBinding = (desc: string) => z.union([z.number(), z.string().max(400), z.boolean(), z.null(), bindingSchema]).optional().describe(desc);
/** A10.2: "series1" to "series8" (the theme's series colours) or a hex colour. */
export const SERIES_COLORS = ["series1", "series2", "series3", "series4", "series5", "series6", "series7", "series8"] as const;
export const lineColor = z.union([z.enum(SERIES_COLORS), z.string().regex(/^#[0-9a-fA-F]{6}$/, "a hex colour like #2f6fb0")]);
export const MAX_CHART_LINES = 12;
export const chartLineSchema = z.strictObject({
  data: bindingSchema.describe("The line's data: a series read, or the history read of a value, for example {{ d_abcdefgh }}. A read with several series (every machine) draws one line per series."),
  label: z.string().max(80).optional().describe("The line's name in the legend. With several series it is written before each one's own name."),
  color: lineColor.optional().describe("series1 to series8 (the theme's series colours) or a hex colour like #2f6fb0. Empty takes the next theme colour."),
  hidden: z.boolean().optional().describe("Keep the line but do not draw it."),
});
export const tileStatSchema = z.strictObject({
  label: z.string().max(40).describe("The small word under the number, like Running or CPU."),
  value: valueOrBinding("The number or text, usually a binding like {{ d_abcdefgh.value }} or {{ d_abcdefgh.rows | filter(\"state\", \"running\") | count }}."),
  format: valueFormat.optional().describe("How a number is written: percent, bytes, bytesPerSec, seconds, celsius or number. Empty uses the data's own format."),
});
export const MAX_TILE_STATS = 4;
export const barItemSchema = z.strictObject({
  icon: iconRef.describe("A built-in icon name (cpu, memory, disk, thermometer, clock, network, upload, download), pkg:<package id>, or an /uploads/ picture."),
  label: z.string().max(40).describe("The small word after the value, like CPU or Free."),
  value: valueOrBinding("The value shown, usually a binding like {{ d_abcdefgh }} or {{ d_abcdefgh.value }}."),
  percent: valueOrBinding("Optional, 0 to 100: draws the small bar under the value, usually the same read as the value."),
  format: valueFormat.optional().describe("How a number is written. Empty uses the data's own format."),
});
export const MAX_BAR_ITEMS = 8;
export const bookmarkSchema = z.strictObject({
  name: z.string().max(80).describe("The bookmark's name."),
  href: z.string().max(2000).describe("An http or https address, opened in a new tab."),
  icon: iconRef.optional().describe("A built-in icon name, pkg:<package id>, or an /uploads/ picture. Empty shows two letters from the name."),
});
export const MAX_BOOKMARKS = 50;
export const DEFAULT_SEARCH_URL = "https://duckduckgo.com/?q={q}";

const mediaLook = {
  shape: lit(z.enum(["original", "16:9", "4:3", "1:1", "3:4", "9:16", "fill"]), "The box's shape: the file's own (original), a fixed ratio, or fill the box as sized."),
  rotate: lit(z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]), "Turn the picture inside its box, in degrees clockwise."),
  flipX: lit(z.boolean(), "Mirror the picture left to right."),
  flipY: lit(z.boolean(), "Mirror the picture top to bottom."),
  straighten: lit(z.number().min(-45).max(45), "Tilt the picture by a small angle, in degrees."),
  zoom: lit(z.number().min(1).max(4), "Zoom into the picture around its focal point (1 is no zoom)."),
  focusX: lit(z.number().min(0).max(100), "Which part stays in view across, in percent from the left."),
  focusY: lit(z.number().min(0).max(100), "Which part stays in view down, in percent from the top."),
  filters: lit(z.strictObject({
    brightness: z.number().min(0).max(200).optional(),
    contrast: z.number().min(0).max(200).optional(),
    saturate: z.number().min(0).max(200).optional(),
    grayscale: z.number().min(0).max(100).optional(),
    sepia: z.number().min(0).max(100).optional(),
    blur: z.number().min(0).max(20).optional(),
  }), "Filters in percent (brightness, contrast and saturation 100 is unchanged; grey and sepia 0 is unchanged) and blur in px."),
  caption: lit(z.string().max(300), "Text shown with the picture."),
  captionAt: lit(z.enum(["below", "over"]), "Show the caption below the picture or over its bottom edge."),
  link: lit(z.strictObject({
    kind: z.enum(["none", "page", "url", "enlarge"]),
    pageId: z.string().regex(/^p_[a-z2-7]{10}$/).optional(),
    url: z.string().max(2000).regex(/^https?:\/\//i).optional(),
  }), "What a click does: nothing, open a page of this app, open an address in a new tab, or enlarge to full screen."),
};

export const propsSchemas = {
  // ---- layout ----
  grid: z.strictObject({
    gap: lit(z.number().min(0).max(64), "Space between cells in px. Empty uses the theme's gap."),
    minRows: lit(z.number().int().min(1).max(500), "Minimum height in 8px rows, so an empty grid still has room to drop into."),
    columns: lit(z.union([z.literal(6), z.literal(12), z.literal(24)]), "How many columns the grid snaps to on desktop (default 12; phones always use 4). Changing it keeps every child where it is."),
  }),
  stack: z.strictObject({
    direction: lit(z.enum(["vertical", "horizontal"]), "Stack children top to bottom (vertical) or side by side (horizontal)."),
    gap: lit(z.number().min(0).max(64), "Space between children in px. Empty uses the theme's gap."),
    align: lit(z.enum(["start", "center", "end", "stretch"]), "How children line up across the stack."),
    wrap: lit(z.boolean(), "Let a horizontal stack wrap onto more lines when it runs out of room."),
  }),
  card: z.strictObject({
    title: b(text, "Title shown at the top of the card (in a title bar when the theme uses them). Leave empty for none."),
    subtitle: b(text, "A short line under the title."),
    padded: lit(z.boolean(), "Pad the card's content with the theme's padding. On by default."),
  }),
  tabs: z.strictObject({
    labels: lit(z.array(z.string().max(60)).max(12), "One label per tab, in order. Each child of the tabs is one tab's content."),
    initial: lit(z.number().int().min(0).max(11), "The tab shown first, counting from 0."),
  }),
  section: z.strictObject({
    title: b(text, "Section heading. Leave empty for none."),
    description: b(text, "A sentence under the heading."),
  }),
  repeat: z.strictObject({
    items: b(z.array(z.unknown()), "What to repeat over: bind a table or status source (its rows or items), or any list. The child is drawn once per item, with $item and $index."),
    columns: lit(z.number().int().min(1).max(6), "How many items per row on desktop (always 1 on phones)."),
    gap: lit(z.number().min(0).max(64), "Space between items in px."),
    max: lit(z.number().int().min(1).max(200), "Draw at most this many items."),
    empty: b(text, "Text shown when there are no items."),
  }),
  // ---- data ----
  stat: z.strictObject({
    data: b(z.unknown(), "A stat source, for example {{ cpu }}. The value, unit, label, change and thresholds come from it unless set below."),
    value: b(z.union([z.number(), z.string()]), "The number or text to show. Overrides the source's value."),
    label: b(text, "The label under the value. Overrides the source's label."),
    unit: b(z.string().max(20), "The unit after the value, like % or GB."),
    delta: b(z.unknown(), "A change to show, as { value, period }, for example { value: -2, period: \"1h\" }."),
    warn: b(z.number(), "Show the warning colour at or above this value."),
    bad: b(z.number(), "Show the bad colour at or above this value."),
    decimals: lit(z.number().int().min(0).max(6), "Round the value to this many decimals."),
    showUpdated,
  }),
  chart: z.strictObject({
    data: b(z.unknown(), "A series source, for example {{ load }}. Every series it holds is drawn. Ignored when lines has entries."),
    lines: lit(z.array(chartLineSchema).max(MAX_CHART_LINES), "At most 12 lines, each its own read with a name, a colour and a hidden flag (A10.2). Lines sharing a format and unit share an axis; a second unit gets the right axis; a third is refused. At most 20 series are drawn, the highest latest value first."),
    kind: lit(z.enum(["line", "area", "bars"]), "Draw the series as lines, filled areas or bars."),
    height: lit(z.number().int().min(80).max(800), "Chart height in px."),
    legend: lit(z.boolean(), "Show the legend naming each series. On by default."),
    showUpdated,
  }),
  table: z.strictObject({
    data: b(z.unknown(), "A table source, for example {{ hosts }}."),
    columns: lit(z.array(z.string().max(64)).max(24), "Which columns to show, by key, in order. Empty shows every column."),
    maxRows: lit(z.number().int().min(1).max(500), "Show at most this many rows."),
    showUpdated,
  }),
  list: z.strictObject({
    items: b(z.unknown(), "A list to show: bind a table or status source, or any list, for example {{ hosts.rows }}."),
    labelKey: lit(z.string().max(64), "The column used as each line's text. Empty uses the first text column or the item's label."),
    detailKey: lit(z.string().max(64), "A column shown at the right of each line."),
    maxItems: lit(z.number().int().min(1).max(200), "Show at most this many lines."),
    showUpdated,
  }),
  status: z.strictObject({
    data: b(z.unknown(), "A status source, for example {{ services }}. Each item shows its state by shape and word as well as colour."),
    layout: lit(z.enum(["list", "grid"]), "One item per line, or a grid of tiles."),
    showUpdated,
  }),
  gauge: z.strictObject({
    value: b(z.number(), "The number to show, for example {{ cpu.value }}."),
    min: lit(z.number(), "The lowest value on the dial. Default 0."),
    max: lit(z.number(), "The highest value on the dial. Default 100."),
    unit: b(z.string().max(20), "The unit after the value."),
    label: b(text, "The label under the dial."),
    warn: b(z.number(), "Show the warning colour at or above this value."),
    bad: b(z.number(), "Show the bad colour at or above this value."),
    showUpdated,
  }),
  progress: z.strictObject({
    value: b(z.number(), "The number to show, for example {{ disk.value }}."),
    min: lit(z.number(), "The value at an empty bar. Default 0."),
    max: lit(z.number(), "The value at a full bar. Default 100."),
    label: b(text, "The label above the bar."),
    unit: b(z.string().max(20), "The unit after the value."),
    showValue: lit(z.boolean(), "Show the value as text next to the label. On by default."),
    warn: b(z.number(), "Show the warning colour at or above this value."),
    bad: b(z.number(), "Show the bad colour at or above this value."),
    showUpdated,
  }),
  // ---- Wave 2.9 (A10.7) ----
  "service-tile": z.strictObject({
    icon: lit(iconRef, "The service's icon: a built-in icon name (server, docker, proxmox, film), pkg:<package id>, or an uploaded picture (/uploads/...)."),
    name: b(z.string().max(80), "The service's name, shown in bold."),
    description: b(z.string().max(160), "One short line under the name, like Media server."),
    href: b(z.string().max(2000), "The address a click opens: http or https only. Empty makes the tile not clickable."),
    newTab: lit(z.boolean(), "Open the address in a new tab. On by default."),
    status: b(z.unknown(), "Status data for the badge, for example {{ d_abcdefgh }} from atrium/health or atrium/reach: the first item's state and detail draw Running, Healthy, Stopped, Down or \"12 ms\"."),
    stats: lit(z.array(tileStatSchema).max(MAX_TILE_STATS), "Up to 4 small labelled numbers under the name, each a literal or a binding, with an optional format."),
    integrationId: lit(z.string().max(64), "The integration this tile is for (a builder reference only, never shown)."),
  }),
  group: z.strictObject({
    title: b(z.string().max(80), "The group's heading, like Media or Monitoring. Empty shows no heading."),
    columns: lit(z.number().int().min(1).max(6), "How many equal columns the children flow into, in order (1 to 6, default 4). Always one column on phones."),
    collapsible: lit(z.boolean(), "Let viewers fold the group away with a button by its heading."),
    fixedHeight: lit(z.boolean(), "Keep the height the group was drawn at (A11.2 reflow): children move into more columns first, then a +N more line, never a scrollbar. Off (default): the group grows to fit its children."),
  }),
  "resource-bar": z.strictObject({
    items: lit(z.array(barItemSchema).max(MAX_BAR_ITEMS), "Up to 8 items, each an icon, a value, a label and an optional small bar from percent."),
    clock: lit(z.boolean(), "Show the time at the right of the strip."),
    clockFormat: lit(z.enum(["time", "time-seconds", "date-time", "time-12h", "date-time-12h"]), "How the clock reads: time, time with seconds, date and time, or the same on a 12-hour clock."),
    search: lit(z.boolean(), "Show a search box that opens the search address in a new tab."),
    searchUrl: lit(z.string().max(500).regex(/^https:\/\/[^\s]*\{q\}[^\s]*$/, "an https address with {q} where the words go"), "The search address, https only, with {q} where the typed words go. Default DuckDuckGo."),
  }),
  bookmarks: z.strictObject({
    items: lit(z.array(bookmarkSchema).max(MAX_BOOKMARKS), "Up to 50 bookmarks, each a name, an http or https address and an optional icon."),
    columns: lit(z.number().int().min(1).max(6), "How many columns of rows (1 to 6, default 1). One column on phones."),
  }),
  // ---- content ----
  heading: z.strictObject({
    text: b(text, "The heading text. Markup is shown as plain characters."),
    level: lit(z.union([z.literal(1), z.literal(2), z.literal(3)]), "1 is the largest heading, 3 the smallest."),
  }),
  text: z.strictObject({
    text: b(text, "Plain text. Line breaks are kept; markup is shown as plain characters."),
    size: lit(z.enum(["sm", "md", "lg"]), "Text size."),
    muted: lit(z.boolean(), "Use the theme's muted text colour."),
  }),
  image: z.strictObject({
    src: b(z.string().max(2000), "An uploaded file (/uploads/...) or a bound address. Other hosts go through Atrium's image proxy."),
    alt: b(z.string().max(300), "What the image shows, read aloud by screen readers."),
    fit: lit(z.enum(["cover", "contain"]), "Show the whole image (contain, the default), or fill the box and crop it (cover)."),
    height: lit(z.number().int().min(16).max(1200), "Image height in px."),
    ...mediaLook,
  }),
  video: z.strictObject({
    src: lit(z.string().regex(/^\/uploads\/[A-Za-z0-9_][A-Za-z0-9._/-]*$/).max(2000), "An uploaded MP4 or WebM video (/uploads/...)."),
    alt: lit(z.string().max(300), "What the video shows, read aloud by screen readers."),
    fit: lit(z.enum(["cover", "contain"]), "Show the whole video (contain, the default), or fill the box and crop it (cover)."),
    height: lit(z.number().int().min(16).max(1200), "Video height in px."),
    loop: lit(z.boolean(), "Start again from the beginning when it ends. On by default."),
    autoplay: lit(z.boolean(), "Play on its own, muted, as soon as it shows. On by default. Stays paused for people with reduced motion on."),
    controls: lit(z.boolean(), "Show play, pause and volume controls. Off by default."),
    sound: lit(z.boolean(), "Allow sound. Only takes effect when controls are shown, because browsers block sound that plays on its own."),
    ...mediaLook,
    poster: lit(z.string().regex(/^\/uploads\/[A-Za-z0-9_][A-Za-z0-9._/-]*$/).max(2000), "An uploaded picture shown before the video plays (and while it stays paused)."),
    startAt: lit(z.number().min(0).max(36000), "Start playing this many seconds in."),
  }),
  icon: z.strictObject({
    name: b(z.enum(ICON_NAMES), `A built-in icon: ${ICON_NAMES.join(", ")}.`),
    size: lit(z.number().int().min(12).max(128), "Icon size in px, used when fill is off."),
    fill: lit(z.boolean(), "Fill the box (A11.2 scale): the icon grows and shrinks with its box, keeping its shape. New icons fill; off uses size in px."),
    label: b(z.string().max(120), "What the icon means, read aloud by screen readers. Empty marks it decorative."),
  }),
  link: z.strictObject({
    label: b(text, "The link text."),
    page: lit(z.string().max(80), "A page of this app to open, by id or slug."),
    href: b(z.string().max(2000), "An http or https address, opened in a new tab. Any other kind of address is refused."),
  }),
  divider: z.strictObject({
    spacing: lit(z.number().int().min(0).max(64), "Space above and below the line in px."),
  }),
  spacer: z.strictObject({
    height: lit(z.number().int().min(4).max(400), "Empty space in px."),
  }),
  clock: z.strictObject({
    show: lit(z.enum(["time", "date", "both"]), "Show the time, the date or both, in the viewer's time zone."),
    seconds: lit(z.boolean(), "Show seconds."),
    hour12: lit(z.boolean(), "Use a 12-hour clock with AM and PM."),
  }),
  // ---- controls ----
  button: z.strictObject({
    label: b(text, "The button text, also its accessible name."),
    control: controlField("The app control this button runs (a k_ id from the app's controls)."),
    variant: lit(z.enum(["primary", "secondary"]), "Primary uses the theme's accent fill."),
  }),
  toggle: z.strictObject({
    label: b(text, "The switch label, also its accessible name."),
    control: controlField("The app control this switch runs. It receives $input true or false."),
    state: b(z.boolean(), "Whether the switch is on, usually bound to the device, for example {{ lamp.find(\"entity\", \"light.desk\").state == \"on\" }}."),
  }),
  slider: z.strictObject({
    label: b(text, "The slider label, also its accessible name."),
    control: controlField("The app control this slider runs on release. It receives $input as the number."),
    value: b(z.number(), "The current value, usually bound to the device."),
    min: lit(z.number(), "Lowest value. Default 0."),
    max: lit(z.number(), "Highest value. Default 100."),
    step: lit(z.number().positive(), "Step between values. Default 1."),
    unit: lit(z.string().max(20), "Unit shown after the value."),
  }),
  select: z.strictObject({
    label: b(text, "The menu label, also its accessible name."),
    control: controlField("The app control this menu runs. It receives $input as the chosen option's value."),
    value: b(z.string().max(200), "The current option's value, usually bound to the device."),
    options: lit(z.array(z.strictObject({ label: z.string().max(120).describe("What the option says"), value: z.string().max(200).describe("What the control receives") })).max(50), "The options to choose from."),
  }),
  // ---- code ----
  html: z.strictObject({
    html: lit(z.string().max(65536), "The block's HTML (at most 64 KB). It runs in a sandbox with no network access."),
    css: lit(z.string().max(65536), "The block's CSS (at most 64 KB)."),
    js: lit(z.string().max(65536), "The block's JavaScript (at most 64 KB). It reads atrium.data and can call atrium.control and atrium.navigate."),
    data: lit(z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,31}$/), bindingSchema).refine((r) => Object.keys(r).length <= 32, "at most 32 data entries"), "Names the block can read in atrium.data, each bound to data. Data you give this block is visible to whoever wrote its code."),
    controls: lit(z.array(controlId).max(16), "The app controls the block may ask to run."),
    height: lit(z.union([z.literal("auto"), z.literal("fill"), z.number().int().min(20).max(4000)]), "auto lets the block report its height (at most 4000px); fill makes it as tall as the window below the app's navigation; a number fixes it in px."),
    libs: lit(z.array(z.enum(["uplot", "d3", "motion"])).max(3), "Bundled libraries to load into the block."),
    images: lit(z.array(z.string().regex(/^\/uploads\/[A-Za-z0-9_][A-Za-z0-9._/-]*$/)).max(20), "Uploaded images (/uploads/...) sent into the block as inline data, 2 MB in total."),
  }),
} as const;

export type BuiltInType = keyof typeof propsSchemas;
export const BUILT_IN_TYPES = Object.keys(propsSchemas) as BuiltInType[];
export { paint as paintSchema };

/** Package components (pkg:) get resolved props only; their schema is open (amendment A4.2). */
export const packagePropsSchema = z.record(z.string(), z.unknown()).describe("Props for a package component, already resolved");
/** Library instances (lib:) fill the library component's params. */
export const libraryPropsSchema = z.record(z.string(), z.unknown()).describe("Values for the library component's parameters");
