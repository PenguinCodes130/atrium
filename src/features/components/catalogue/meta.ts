// Catalogue metadata (architecture v3 section 4.4, spec 3.1): everything in a ComponentDef except
// the React component, so the server, validate and agent tools can read it without rendering.
import type { ComponentCategory, ComponentNode, ComponentState, ComponentType, DataShapeKind, PropValue } from "@/core/contracts";
import { propsSchemas, type BuiltInType } from "./schemas";

export type ComponentMeta = {
  type: BuiltInType;
  title: string;
  category: ComponentCategory;
  container: boolean;
  defaults: Record<string, PropValue>;
  accepts?: DataShapeKind[];
  styleSlots: string[];
  states?: ComponentState[];
  docs: { summary: string; whenToUse: string; examples: ComponentNode[] };
  /** Containers that take exactly one child (repeat). */
  maxChildren?: number;
};

const bind = (t: string) => ({ $bind: t });
const exId = (s: string) => `c_${(s.replace(/[^a-z]/g, "") + "aaaaaaaaaa").slice(0, 10)}`;
const node = (type: ComponentType, id: string, props: Record<string, PropValue>, extra: Partial<ComponentNode> = {}): ComponentNode => ({ id: exId(id), type, props, ...extra });

/** The example app's sources and controls, used to validate every example (criterion 2). */
export const EXAMPLE_SOURCES = {
  cpu: { kind: "stat", value: 41.27, unit: "%", label: "CPU", thresholds: { warn: 70, bad: 90 } },
  load: { kind: "series", unit: "%", series: [{ name: "pve1", points: [[1, 10], [2, 20], [3, 15]] }, { name: "pve2", points: [[1, 5], [2, null], [3, 9]] }] },
  hosts: { kind: "table", columns: [{ key: "name", label: "Name", type: "text" }, { key: "cpu", label: "CPU", type: "number" }, { key: "state", label: "State", type: "status" }], rows: [{ name: "web", cpu: 12, state: "up" }, { name: "db", cpu: 64, state: "warn" }] },
  services: { kind: "status", items: [{ label: "NPM", state: "up" }, { label: "Kuma", state: "down", detail: "timeout" }] },
  lamps: { kind: "table", columns: [{ key: "entity", label: "Entity", type: "text" }, { key: "state", label: "State", type: "text" }, { key: "brightness", label: "Brightness", type: "number" }], rows: [{ entity: "light.desk", state: "on", brightness: 128 }] },
} as const;
export const EXAMPLE_CONTROL = "k_examplelmp";

export const META: Record<BuiltInType, ComponentMeta> = {
  grid: {
    type: "grid", title: "Grid", category: "layout", container: true, defaults: { minRows: 12 }, styleSlots: ["root"],
    docs: {
      summary: "Places children on a 12-column grid (4 columns on phones) in rows of 8px.",
      whenToUse: "The main layout of a dashboard page: drag components into cells and size them.",
      examples: [node("grid", "grid", { minRows: 12 }, { children: [node("stat", "gridstat", { data: bind("{{ cpu }}") }, { slot: { x: 0, y: 0, w: 3, h: 12 }, responsive: { mobile: { slot: { x: 0, y: 0, w: 4, h: 12 } } } })] })],
    },
  },
  stack: {
    type: "stack", title: "Stack", category: "layout", container: true, defaults: { direction: "vertical", align: "stretch" }, styleSlots: ["root"],
    docs: { summary: "Lines children up in a column or a row.", whenToUse: "Simple lists of components that should flow, such as a sidebar of stats.", examples: [node("stack", "stack", { direction: "vertical" }, { children: [node("heading", "stackhead", { text: "Servers", level: 2 })] })] },
  },
  card: {
    type: "card", title: "Card", category: "layout", container: true, defaults: { title: "Card", padded: true }, styleSlots: ["root", "title", "body"], states: ["hover"],
    docs: { summary: "A surface with an optional title that groups other components.", whenToUse: "Group related values, like everything about one server.", examples: [node("card", "card", { title: "pve1" }, { children: [node("stat", "cardstat", { data: bind("{{ cpu }}") })] })] },
  },
  tabs: {
    type: "tabs", title: "Tabs", category: "layout", container: true, defaults: { labels: ["One", "Two"], initial: 0 }, styleSlots: ["root", "tab", "panel"], states: ["hover", "active", "focus"],
    docs: { summary: "Shows one child at a time behind a row of tabs.", whenToUse: "Several views that do not need to be seen together.", examples: [node("tabs", "tabs", { labels: ["Hosts", "Services"] }, { children: [node("section", "tabsone", {}, { children: [] }), node("section", "tabstwo", {}, { children: [] })] })] },
  },
  section: {
    type: "section", title: "Section", category: "layout", container: true, defaults: { title: "Section" }, styleSlots: ["root", "title", "description"],
    docs: { summary: "A titled area of a page.", whenToUse: "Split a long page into named parts.", examples: [node("section", "section", { title: "Network", description: "Traffic and devices" }, { children: [] })] },
  },
  repeat: {
    type: "repeat", title: "Repeat for each row", category: "layout", container: true, maxChildren: 1, defaults: { columns: 1, max: 50, empty: "Nothing to show" }, styleSlots: ["root", "item"], accepts: ["table", "status"],
    docs: {
      summary: "Shows its child once for every row of a list (a bound table or status source); $item is the row and $index its number.",
      whenToUse: "A card per container, a tile per service, a row per host.",
      examples: [node("repeat", "repeat", { items: bind("{{ hosts.rows }}"), columns: 3 }, { children: [node("stat", "repeatstat", { value: bind("{{ $item.cpu }}"), label: bind("{{ $item.name }}"), unit: "%" })] })],
    },
  },
  stat: {
    type: "stat", title: "Stat", category: "data", container: false, accepts: ["stat"], defaults: { label: "", decimals: 1 }, styleSlots: ["root", "value", "label", "unit", "delta"], states: ["hover"],
    docs: { summary: "One big number with its unit, label, change and threshold colour.", whenToUse: "A single live value: CPU, temperature, free disk.", examples: [node("stat", "stat", { data: bind("{{ cpu }}"), warn: 70, bad: 90 })] },
  },
  chart: {
    type: "chart", title: "Chart", category: "data", container: false, accepts: ["series"], defaults: { kind: "line", height: 200, legend: true }, styleSlots: ["root", "legend", "axis"], states: ["hover"],
    docs: { summary: "Draws every series of a series source as lines, areas or bars over time.", whenToUse: "Trends: load over the last hour, traffic per interface.", examples: [node("chart", "chart", { data: bind("{{ load }}"), kind: "line" })] },
  },
  table: {
    type: "table", title: "Table", category: "data", container: false, accepts: ["table"], defaults: { maxRows: 20 }, styleSlots: ["root", "header", "row", "cell"], states: ["hover"],
    docs: { summary: "Rows and typed columns, with link and status cells and a row count.", whenToUse: "Lists with several columns: containers, proxy hosts, VMs.", examples: [node("table", "table", { data: bind("{{ hosts }}") })] },
  },
  list: {
    type: "list", title: "List", category: "data", container: false, accepts: ["table", "status"], defaults: { maxItems: 10 }, styleSlots: ["root", "item", "detail"], states: ["hover"],
    docs: { summary: "A simple list of lines with an optional detail on the right.", whenToUse: "Two columns or fewer: feed items, names and counts.", examples: [node("list", "list", { items: bind("{{ hosts.rows }}"), labelKey: "name", detailKey: "cpu" })] },
  },
  status: {
    type: "status", title: "Status", category: "data", container: false, accepts: ["status"], defaults: { layout: "list" }, styleSlots: ["root", "item", "label"], states: ["hover"],
    docs: { summary: "Up, warning and down for each item, by shape and word as well as colour.", whenToUse: "Service health and uptime checks.", examples: [node("status", "status", { data: bind("{{ services }}") })] },
  },
  gauge: {
    type: "gauge", title: "Gauge", category: "data", container: false, accepts: ["stat"], defaults: { min: 0, max: 100 }, styleSlots: ["root", "track", "fill", "value", "label"],
    docs: { summary: "A dial showing a number between a minimum and a maximum.", whenToUse: "Bounded values such as CPU percent or battery.", examples: [node("gauge", "gauge", { value: bind("{{ cpu.value }}"), unit: "%", label: "CPU", warn: 70, bad: 90 })] },
  },
  progress: {
    type: "progress", title: "Progress", category: "data", container: false, accepts: ["stat"], defaults: { min: 0, max: 100, showValue: true }, styleSlots: ["root", "track", "fill", "label", "value"],
    docs: { summary: "A bar showing a number between a minimum and a maximum.", whenToUse: "Disk use, download progress, a goal.", examples: [node("progress", "progress", { value: bind("{{ cpu.value }}"), label: "CPU", unit: "%" })] },
  },
  heading: {
    type: "heading", title: "Heading", category: "content", container: false, defaults: { text: "Heading", level: 2 }, styleSlots: ["root"],
    docs: { summary: "A title for a page or a part of one.", whenToUse: "Name sections so a page reads at a glance.", examples: [node("heading", "heading", { text: "Homelab", level: 1 })] },
  },
  text: {
    type: "text", title: "Text", category: "content", container: false, defaults: { text: "Text", size: "md" }, styleSlots: ["root"],
    docs: { summary: "Plain text with line breaks; markup is shown as plain characters.", whenToUse: "Notes, instructions, a bound sentence like \"{{ hosts.rows | count }} hosts\".", examples: [node("text", "text", { text: bind("{{ hosts.rows | count }} hosts online") })] },
  },
  image: {
    type: "image", title: "Image", category: "content", container: false, defaults: { fit: "contain", height: 160, alt: "" }, styleSlots: ["root"],
    docs: { summary: "An uploaded picture or a bound image address (other hosts go through the image proxy).", whenToUse: "A floor plan, a camera snapshot, a logo.", examples: [node("image", "image", { src: "/uploads/floorplan.png", alt: "Floor plan" })] },
  },
  video: {
    type: "video", title: "Video", category: "content", container: false, defaults: { fit: "contain", height: 200, alt: "", loop: true, autoplay: true, controls: false, sound: false }, styleSlots: ["root"],
    docs: { summary: "An uploaded MP4 or WebM video, muted and looping by default.", whenToUse: "A short loop that makes a dashboard feel alive: weather, a fireplace, a logo animation.", examples: [node("video", "video", { src: "/uploads/loop.mp4", alt: "Rain on the window" })] },
  },
  icon: {
    type: "icon", title: "Icon", category: "content", container: false, defaults: { name: "server", size: 24 }, styleSlots: ["root"],
    docs: { summary: "One icon from the built-in set.", whenToUse: "Mark a section or a value with a symbol.", examples: [node("icon", "icon", { name: "light", size: 32, label: "Lights" })] },
  },
  link: {
    type: "link", title: "Link", category: "content", container: false, defaults: { label: "Open" }, styleSlots: ["root"], states: ["hover", "focus", "active"],
    docs: { summary: "Opens a page of this app, or an http or https address in a new tab.", whenToUse: "Jump to a detail page or a service's own UI.", examples: [node("link", "link", { label: "Proxmox", href: "https://10.0.0.4:8006" })] },
  },
  divider: {
    type: "divider", title: "Divider", category: "content", container: false, defaults: { spacing: 8 }, styleSlots: ["root"],
    docs: { summary: "A thin line between parts of a page.", whenToUse: "Separate groups without a heading.", examples: [node("divider", "divider", {})] },
  },
  spacer: {
    type: "spacer", title: "Spacer", category: "content", container: false, defaults: { height: 24 }, styleSlots: ["root"],
    docs: { summary: "Empty space of a fixed height.", whenToUse: "Breathing room in a stack.", examples: [node("spacer", "spacer", { height: 32 })] },
  },
  clock: {
    type: "clock", title: "Clock", category: "content", container: false, defaults: { show: "both", seconds: false, hour12: false }, styleSlots: ["root", "time", "date"],
    docs: { summary: "The time and date in the viewer's time zone, ticking every second.", whenToUse: "Wall screens and kitchen dashboards.", examples: [node("clock", "clock", { show: "both" })] },
  },
  button: {
    type: "button", title: "Button", category: "control", container: false, defaults: { label: "Run", variant: "primary" }, styleSlots: ["root", "label"], states: ["hover", "active", "focus", "disabled"],
    docs: { summary: "Runs one of the app's controls when clicked. Sends no input.", whenToUse: "Scenes, scripts, restarts: one press, one action.", examples: [node("button", "button", { label: "Movie scene", control: EXAMPLE_CONTROL })] },
  },
  toggle: {
    type: "toggle", title: "Toggle", category: "control", container: false, defaults: { label: "Switch" }, styleSlots: ["root", "track", "thumb", "label"], states: ["hover", "focus", "on", "off", "disabled"],
    docs: { summary: "A switch that runs a control with $input true or false and settles when the device confirms.", whenToUse: "Lights, plugs, anything on or off.", examples: [node("toggle", "toggle", { label: "Desk lamp", control: EXAMPLE_CONTROL, state: bind('{{ lamps.find("entity", "light.desk").state == "on" }}') })] },
  },
  slider: {
    type: "slider", title: "Slider", category: "control", container: false, defaults: { label: "Level", min: 0, max: 100, step: 1 }, styleSlots: ["root", "track", "fill", "thumb", "label", "value"], states: ["hover", "focus", "active", "disabled"],
    docs: { summary: "Picks a number and runs a control with it on release.", whenToUse: "Brightness, volume, a thermostat.", examples: [node("slider", "slider", { label: "Brightness", control: EXAMPLE_CONTROL, value: bind('{{ lamps.find("entity", "light.desk").brightness }}'), min: 0, max: 255 })] },
  },
  select: {
    type: "select", title: "Select", category: "control", container: false, defaults: { label: "Choose", options: [] }, styleSlots: ["root", "label", "field"], states: ["hover", "focus", "disabled"],
    docs: { summary: "A menu that runs a control with the chosen option.", whenToUse: "Modes and presets: heat or cool, a scene list.", examples: [node("select", "select", { label: "Mode", control: EXAMPLE_CONTROL, options: [{ label: "Heat", value: "heat" }, { label: "Cool", value: "cool" }] })] },
  },
  html: {
    type: "html", title: "HTML block", category: "code", container: false, defaults: { html: "<div id=\"out\"></div>", css: "", js: "", data: {}, controls: [], height: "auto", libs: [], images: [] }, styleSlots: ["root"],
    docs: {
      summary: "Your own HTML, CSS and JavaScript, run in a sandbox with no network access. It sees only the data you give it.",
      whenToUse: "Something the catalogue does not have, like a custom chart. Data you give a block is visible to whoever wrote its code.",
      examples: [node("html", "html", { html: "<div id=\"out\"></div>", js: "atrium.on('data', d => { document.getElementById('out').textContent = d.cpu + '%'; });", data: { cpu: bind("{{ cpu.value }}") }, controls: [], height: "auto" }, { name: "CPU readout" })],
    },
  },
};

export function metaFor(type: ComponentType): ComponentMeta | undefined {
  return Object.prototype.hasOwnProperty.call(META, type) ? META[type as BuiltInType] : undefined;
}

export { propsSchemas };
