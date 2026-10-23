// What a viewer's browser receives of an app document (architecture v3 sections 5.1, 10 and 13).
// Editors get the whole document. Other signed-in viewers get it without control run details. Guests
// get one page's tree, page titles for navigation, and control labels only: no data source
// definitions, no other page's components, no integration ids, command params or target ids.
import type { App, AppDocument, ControlDef, PageDoc, Principal } from "@/core/contracts";
import { canEdit } from "./access";
import { clone } from "./doc";

export type ViewerKind = "editor" | "viewer" | "guest";

function bareControl(c: ControlDef): ControlDef {
  // The run kind stays so components can tell a workflow from a command; nothing else of the run.
  const run = c.run.kind === "command" ? { kind: "command" as const, integrationId: "", commandId: "" } : { kind: "workflow" as const, actionId: "" };
  return { id: c.id, label: c.label, run, ...(c.confirm ? { confirm: c.confirm } : {}), ...(c.cooldownMs ? { cooldownMs: c.cooldownMs } : {}) };
}

export function viewerDocument(doc: AppDocument, kind: ViewerKind, pageId: string): AppDocument {
  if (kind === "editor") return doc;
  const d = clone(doc);
  d.controls = d.controls.map(bareControl);
  if (kind === "viewer") {
    d.dataSources = d.dataSources.map((s) => ({ name: s.name, integrationId: "", endpointId: s.endpointId, refreshSec: s.refreshSec, ...(s.label ? { label: s.label } : {}) }));
    delete d.chrome.css;
    return d;
  }
  // Guest: only this page's tree; other pages keep their title and slug for the app's own navigation.
  d.pages = d.pages.map((p): PageDoc => (p.id === pageId ? p : { id: p.id, slug: p.slug, title: p.title, inNav: p.inNav, ...(p.icon ? { icon: p.icon } : {}), root: { id: p.root.id, type: p.root.type, props: {}, children: [] } }));
  const page = d.pages.find((p) => p.id === pageId);
  const used = new Set<string>();
  if (page) {
    const visit = (n: PageDoc["root"]) => {
      if (typeof n.props.control === "string") used.add(n.props.control);
      if (Array.isArray(n.props.controls)) for (const x of n.props.controls) if (typeof x === "string") used.add(x);
      for (const c of n.children ?? []) visit(c);
    };
    visit(page.root);
  }
  d.controls = d.controls.filter((c) => used.has(c.id));
  // A source's name in words (A8.6) is the author's text, shown as a stat's label when it has none.
  d.dataSources = d.dataSources.map((s) => ({ name: s.name, integrationId: "", endpointId: "", refreshSec: s.refreshSec, ...(s.label ? { label: s.label } : {}) }));
  delete d.chrome.css; // chrome CSS is scoped and sent separately
  return d;
}

/**
 * The document a principal may read outside a rendered page (version reads, app file export, agent
 * reads): editors get it whole; every other principal gets exactly what the viewer page sends them, so
 * control run details (command params, workflow input, target ids), data source definitions and chrome
 * CSS never leave the server for a non-editor (gauntlet w2-r1 security finding).
 */
export function readableDocument(app: App, p: Principal, doc: AppDocument): AppDocument {
  if (canEdit(app, p)) return doc;
  return viewerDocument(doc, p.kind === "guest" ? "guest" : "viewer", doc.app.homePage);
}
