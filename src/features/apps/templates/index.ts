// Built-in app templates (architecture v3 section 4.10, "Templates"; design v4 section 2 "Templates").
// Each is an app document whose data sources and controls name a placeholder integration
// ("$<key>"); creating an app maps each placeholder to one of the user's integrations, or skips it
// (bound components then show "No data"). Ids are rewritten on every use.
import "server-only";
import type { AppDocument, ComponentNode, Principal } from "@/core/contracts";
import { canBindCommands, canBindReads } from "@/features/integrations/commands";
import { getIntegrationRow } from "@/features/integrations/repo";
import { blankDocument, clone, rekeyDocument, unmappedIntegrationId, walk } from "../doc";

export type TemplateId = "blank" | "blank-canvas" | "html-page" | "homelab" | "machines-overview" | "family-wall" | "guest-room";
export type TemplateIntegration = { key: string; packageId: string; name: string; why: string };
export type TemplateInfo = { id: TemplateId; title: string; description: string; integrations: TemplateIntegration[] };

let seq = 0;
const C = () => `c_${(seq++).toString(32).padStart(10, "a").replace(/[^a-z2-7]/g, "a")}`;
const K = (s: string) => `k_${s.padEnd(10, "a").slice(0, 10)}`;

function grid(children: ComponentNode[]): ComponentNode {
  return { id: C(), type: "grid", props: { minRows: 40 }, children };
}
function at(node: Omit<ComponentNode, "id">, x: number, y: number, w: number, h: number, mobile?: { x: number; y: number; w: number; h: number }): ComponentNode {
  return { id: C(), ...node, slot: { x, y, w, h }, ...(mobile ? { responsive: { mobile: { slot: mobile } } } : {}) };
}

function homelab(): AppDocument {
  const d = blankDocument("Homelab");
  const home = d.pages[0]!;
  home.title = "Overview";
  home.slug = "overview";
  home.root = grid([
    // Exact boxes (operator, 2026-10-19): every slot fits its content, measured by tests/e2e/app-builder/i-widget-boxes.spec.ts.
    at({ type: "heading", props: { text: "Homelab", level: 1 } }, 0, 0, 12, 10, { x: 0, y: 0, w: 4, h: 10 }),
    at({ type: "stat", props: { data: { $bind: "{{ running }}" }, label: "Running containers" } }, 0, 10, 4, 19, { x: 0, y: 10, w: 4, h: 19 }),
    at({ type: "status", props: { data: { $bind: "{{ nodes }}" }, layout: "list" } }, 4, 10, 8, 19, { x: 0, y: 29, w: 4, h: 20 }),
    at({ type: "table", props: { data: { $bind: "{{ containers }}" }, maxRows: 12 } }, 0, 29, 12, 32, { x: 0, y: 49, w: 4, h: 40 }),
  ]);
  d.dataSources = [
    { name: "running", integrationId: "$docker", endpointId: "running", refreshSec: 15 },
    { name: "containers", integrationId: "$docker", endpointId: "containers", refreshSec: 15 },
    { name: "nodes", integrationId: "$proxmox", endpointId: "nodes", refreshSec: 30 },
  ];
  return d;
}

/**
 * Machines overview (Wave 2.7 spec 3.7, criterion 20): one card per node-exporter machine with CPU, memory,
 * disk, network in and out and uptime, then a CPU history chart with one line per machine. Everything comes
 * from the connected Prometheus with no mapping beyond picking the integration.
 */
function machinesOverview(): AppDocument {
  const d = blankDocument("Machines overview");
  const home = d.pages[0]!;
  home.title = "Machines";
  home.slug = "machines";
  const lines: [string, string][] = [["cpu", "CPU"], ["memory", "Memory"], ["disk", "Disk (/)"], ["netIn", "Network in"], ["netOut", "Network out"], ["uptime", "Uptime"]];
  const LINE = 14; // the same card as the picker's "A card for each" (builder/data-pick.ts)
  const card: ComponentNode = {
    id: C(), type: "card", name: "Card for each machine", props: { title: { $bind: "{{ $item.name }}" }, padded: true },
    children: [{ id: C(), type: "grid", props: { minRows: 1, gap: 8 }, children: lines.map(([key, label], i) => ({ id: C(), type: "stat", props: { value: { $bind: `{{ $item.${key} }}` }, label, decimals: 1 }, slot: { x: (i % 2) * 6, y: Math.floor(i / 2) * LINE, w: 6, h: LINE } })) }],
  };
  // 9 machines, 3 across: 3 rows of cards, each about 58 rows of 8px.
  home.root = grid([
    at({ type: "heading", props: { text: "Machines", level: 1 } }, 0, 0, 12, 10, { x: 0, y: 0, w: 4, h: 10 }),
    at({ type: "repeat", name: "Card for each machine", props: { items: { $bind: "{{ machines.rows }}" }, columns: 3, gap: 12, max: 50, empty: "Prometheus reports no machines with node-exporter yet" }, children: [card] }, 0, 10, 12, 180, { x: 0, y: 10, w: 4, h: 530 }),
    at({ type: "chart", title: "CPU in use, every machine", showTitle: true, props: { data: { $bind: "{{ cpu_history }}" }, kind: "line", height: 220 } }, 0, 190, 12, 40, { x: 0, y: 540, w: 4, h: 40 }),
  ]);
  d.dataSources = [
    { name: "machines", label: "Machines overview", integrationId: "$prometheus", endpointId: "machines-overview", refreshSec: 30 },
    { name: "cpu_history", label: "CPU in use, every machine, over time", integrationId: "$prometheus", endpointId: "machines-history", params: { measure: "cpu", hours: 6 }, refreshSec: 60 },
  ];
  return d;
}

function familyWall(): AppDocument {
  const d = blankDocument("Family wall");
  d.theme = { themeId: "solid" };
  d.chrome = { layout: "none", title: "Family wall" };
  const home = d.pages[0]!;
  home.title = "Wall";
  home.slug = "wall";
  // A composed wall screen (gauntlet w2-r1 item 2): a large clock and today's plan across the top, then
  // three cards for the week, notes and a photo, filling the 12-column canvas at 1440px.
  home.root = grid([
    // Gauntlet w2-r2 item 18: the clock is the hero, display size across the eight columns beside Today.
    at({ type: "clock", props: { show: "both", seconds: false }, overrideTheme: true, style: { root: { display: "flex", flexDirection: "column", justifyContent: "center", padding: "24px" }, time: { fontSize: "8vw", fontWeight: 600, lineHeight: 1, letterSpacing: "-0.03em" }, date: { fontSize: "2vw" } }, responsive: { mobile: { slot: { x: 0, y: 0, w: 4, h: 24 }, style: { time: { fontSize: "72px" }, date: { fontSize: "20px" } } } } }, 0, 0, 8, 28),
    at({ type: "card", props: { title: "Today", padded: true }, children: [
      { id: C(), type: "heading", props: { text: "Nothing planned yet", level: 3 } },
      { id: C(), type: "text", props: { text: "Bind the family calendar here to list today's plans.", size: "md" } },
    ] }, 8, 0, 4, 28, { x: 0, y: 24, w: 4, h: 21 }),
    at({ type: "card", props: { title: "This week", padded: true }, children: [
      { id: C(), type: "text", props: { text: "School runs, bins, birthdays: one line each.", size: "md" } },
    ] }, 0, 28, 4, 29, { x: 0, y: 45, w: 4, h: 20 }),
    at({ type: "card", props: { title: "Notes", padded: true }, children: [
      { id: C(), type: "text", props: { text: "Leave a note for everyone here.", size: "md" } },
    ] }, 4, 28, 4, 29, { x: 0, y: 65, w: 4, h: 20 }),
    at({ type: "card", props: { title: "Photo", padded: true }, children: [
      { id: C(), type: "image", props: { alt: "Family photo", fit: "cover", height: 140 } },
    ] }, 8, 28, 4, 29, { x: 0, y: 85, w: 4, h: 28 }),
  ]);
  return d;
}

// A7.8: two starting points for people who want the whole window. No navigation, no page padding.
function blankCanvas(): AppDocument {
  const d = blankDocument("Blank canvas");
  d.chrome = { layout: "none", title: "Blank canvas" };
  const home = d.pages[0]!;
  home.padding = "none";
  home.root = grid([]);
  return d;
}

const STARTER_HTML = '<main class="hello">\n  <h1>Hello</h1>\n  <p id="time"></p>\n</main>';
const STARTER_CSS = "html, body { height: 100%; margin: 0; }\n.hello { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; font-family: system-ui, sans-serif; }\n.hello h1 { font-size: 64px; margin: 0; }\n.hello p { font-size: 24px; }";
const STARTER_JS = "const el = document.getElementById(\"time\");\nconst tick = () => { el.textContent = new Date().toLocaleTimeString(); };\ntick();\nsetInterval(tick, 1000);";

function htmlPage(): AppDocument {
  const d = blankDocument("Full-page HTML");
  d.chrome = { layout: "none", title: "Full-page HTML" };
  const home = d.pages[0]!;
  home.padding = "none";
  home.root = grid([at({ type: "html", name: "Page", props: { html: STARTER_HTML, css: STARTER_CSS, js: STARTER_JS, height: "fill" } }, 0, 0, 12, 40)]);
  return d;
}

function guestRoom(): AppDocument {
  const d = blankDocument("Guest room");
  d.chrome = { layout: "none", title: "Guest room" };
  const lamp = K("tmpllamp");
  const scene = K("tmplscene");
  const home = d.pages[0]!;
  home.title = "Room";
  home.slug = "room";
  home.root = grid([
    at({ type: "heading", props: { text: "Welcome", level: 1 } }, 0, 0, 12, 10, { x: 0, y: 0, w: 4, h: 10 }),
    at({ type: "text", props: { text: "The lights in your room are yours to use.", size: "lg" } }, 0, 10, 12, 8, { x: 0, y: 10, w: 4, h: 8 }),
    // Guest controls are at least 56px tall (design v4 guest view; gauntlet w2-r1 item 13).
    at({ type: "toggle", name: "Lamp", props: { label: "Lamp", control: lamp }, overrideTheme: true, style: { root: { minHeight: 56 } } }, 0, 18, 6, 11, { x: 0, y: 18, w: 4, h: 11 }),
    at({ type: "button", name: "Evening scene", props: { label: "Evening scene", control: scene, variant: "primary" }, overrideTheme: true, style: { root: { minHeight: 56 } } }, 6, 18, 6, 11, { x: 0, y: 29, w: 4, h: 11 }),
  ]);
  d.dataSources = [{ name: "ha", integrationId: "$ha", endpointId: "states", params: { domain: "light" }, refreshSec: 10 }];
  d.controls = [
    { id: lamp, label: "Lamp", run: { kind: "command", integrationId: "$ha", commandId: "light.toggle", params: { entityId: "" } }, cooldownMs: 500 },
    { id: scene, label: "Evening scene", run: { kind: "command", integrationId: "$ha", commandId: "scene.turn_on", params: { entityId: "" } }, cooldownMs: 1000 },
  ];
  return d;
}

export const TEMPLATES: TemplateInfo[] = [
  { id: "blank", title: "Blank", description: "One empty page in the Control Room theme.", integrations: [] },
  { id: "blank-canvas", title: "Blank canvas", description: "No navigation and no page padding: one empty grid that is all yours.", integrations: [] },
  { id: "html-page", title: "Full-page HTML", description: "No navigation: one HTML block that fills the whole window, starting with Hello and the time.", integrations: [] },
  {
    id: "homelab",
    title: "Homelab",
    description: "Containers, nodes and a running count on one board.",
    integrations: [
      { key: "docker", packageId: "docker", name: "Docker", why: "Containers and the running count" },
      { key: "proxmox", packageId: "proxmox", name: "Proxmox VE", why: "Node status" },
    ],
  },
  {
    id: "machines-overview",
    title: "Machines overview",
    description: "A card for each of your machines with CPU, memory, disk, network and uptime, and a CPU chart with one line per machine.",
    integrations: [{ key: "prometheus", packageId: "prometheus", name: "Prometheus", why: "Your machines, read from node-exporter" }],
  },
  { id: "family-wall", title: "Family wall", description: "A large clock and notes for a wall screen, in the readable Solid theme.", integrations: [] },
  {
    id: "guest-room",
    title: "Guest room",
    description: "A welcome page with the room's lamp and a scene, for a guest link.",
    integrations: [{ key: "ha", packageId: "home-assistant", name: "Home Assistant", why: "The room's lamp and scene" }],
  },
];

const BUILDERS: Record<Exclude<TemplateId, "blank">, () => AppDocument> = { "blank-canvas": blankCanvas, "html-page": htmlPage, homelab, "machines-overview": machinesOverview, "family-wall": familyWall, "guest-room": guestRoom };

export function isTemplateId(x: unknown): x is TemplateId {
  return typeof x === "string" && TEMPLATES.some((t) => t.id === x);
}

/**
 * A template as a fresh document: ids rewritten, each placeholder integration mapped to one of the
 * user's (when they may bind it) or skipped. A skipped integration's controls are left out; its data
 * sources stay as unmapped placeholders (components show "No data: connect <package>").
 */
export function templateDocument(id: TemplateId, name: string, mappings: Record<string, string | null>, p: Principal): AppDocument {
  if (id === "blank") return blankDocument(name);
  const raw = BUILDERS[id]();
  const doc = rekeyDocument(raw);
  doc.app.name = name;
  doc.chrome.title = name;
  const mapped = new Map<string, { id: string; commands: boolean } | null>();
  const packages = new Map<string, string>();
  for (const t of TEMPLATES.find((x) => x.id === id)!.integrations) {
    const chosen = mappings[t.key];
    const row = typeof chosen === "string" ? getIntegrationRow(chosen) : undefined;
    mapped.set(`$${t.key}`, row && row.packageId === t.packageId && canBindReads(p, row) ? { id: row.id, commands: canBindCommands(p, row) } : null);
    packages.set(`$${t.key}`, t.packageId);
  }
  // A skipped integration's sources stay, unmapped, so their components show "No data: connect ..."
  // (gauntlet w2-r1 item 2) instead of a binding error; mapping one later is a normal source edit.
  doc.dataSources = doc.dataSources.map((s) => {
    const m = mapped.get(s.integrationId);
    return m ? { ...s, integrationId: m.id } : { ...s, integrationId: unmappedIntegrationId(packages.get(s.integrationId) ?? "unknown") };
  });
  const dropped = new Set<string>();
  doc.controls = doc.controls.flatMap((c) => {
    if (c.run.kind !== "command") return [c];
    const m = mapped.get(c.run.integrationId);
    if (!m || !m.commands) {
      dropped.add(c.id);
      return [];
    }
    return [{ ...c, run: { ...c.run, integrationId: m.id } }];
  });
  if (dropped.size) for (const page of doc.pages) for (const l of walk(page)) if (typeof l.node.props.control === "string" && dropped.has(l.node.props.control)) delete l.node.props.control;
  return clone(doc);
}
