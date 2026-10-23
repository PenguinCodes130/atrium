// The Wave 1 hooks app-builder fills (architecture v3 section 2, amendments A1.2, A4.3): the app access
// resolver (src/core/hooks.ts) and the page data source resolver (src/features/data/stream.ts).
import "server-only";
import type { AppAccessResolver, AppDocument, ComponentNode, ControlDef, DataSourceDef, Principal, ShapedData } from "@/core/contracts";
import { registerAppAccess } from "@/core/hooks";
import { logger } from "@/core/log";
import { registerDataSources, type DataSourceResolver } from "@/features/data/stream";
import { canEdit, canOpen } from "./access";
import { resolveGuestValues, sourcesUsed } from "./deps";
import { controlsOfNode, findNode, findPage, unmappedPackage } from "./doc";
import * as repo from "./repo";
import { guestSourceStates } from "./guest-states";

const log = logger("apps.resolver");

/** The document a principal sees: the published version, or the draft for an editor in preview. */
export function documentFor(appId: string, p: Principal, draft: boolean): { doc: AppDocument; version: number } | null {
  const app = repo.getApp(appId);
  if (!app || !canOpen(app, p)) return null;
  if (draft && p.kind === "user" && canEdit(app, p)) {
    const d = repo.getDraft(app.id);
    return d ? { doc: d.doc, version: 0 } : null;
  }
  if (app.publishedVersion == null) return null;
  const v = repo.getVersion(app.id, app.publishedVersion);
  return v ? { doc: v.doc, version: v.version } : null;
}

export const accessResolver: AppAccessResolver = {
  async appBySlug(slug) {
    return repo.getAppBySlug(slug);
  },
  async appById(appId) {
    return repo.getApp(appId);
  },
  async appsFor(principal) {
    if (principal.kind === "guest") return [];
    return repo.listApps().filter((a) => canOpen(a, principal));
  },
  async guestValues(appId, pageId, sources: Record<string, ShapedData>) {
    const app = repo.getApp(appId);
    if (!app || app.publishedVersion == null || !app.access.guests) return {};
    const v = repo.getVersion(app.id, app.publishedVersion);
    if (!v || !findPage(v.doc, pageId)) return {};
    try {
      // Unconnected sources read "Not connected yet" and connected ones without data "No data yet", the
      // same calm states signed-in viewers see, never a "live" card with an empty body (w2-r2 item 5).
      return resolveGuestValues(v.doc, pageId, sources, { scope: { $sources: guestSourceStates(v.doc, sources, { connectedToo: true }) } as never });
    } catch (err) {
      log.warn("guest values failed", { appId, err: String(err) });
      return {};
    }
  },
  async canOpenApp(principal, appId) {
    return canOpen(repo.getApp(appId), principal);
  },
  async canEditApp(principal, appId) {
    return canEdit(repo.getApp(appId), principal);
  },
  async publishedControl(appId, controlId, nodeId, opts) {
    const found = documentFor(appId, opts.principal, opts.draft);
    if (!found) return null;
    if (opts.draft && found.version !== 0) return null; // a draft was asked for and refused
    return controlInDoc(found.doc, controlId, nodeId, found.version);
  },
};

/** The control and the node that runs it, only when both exist and the node uses that control. */
export function controlInDoc(doc: AppDocument, controlId: string, nodeId: string, version: number): { version: number; control: ControlDef; node: ComponentNode } | null {
  const control = doc.controls.find((c) => c.id === controlId);
  const at = findNode(doc, nodeId);
  if (!control || !at) return null;
  if (!controlsOfNode(at.node).includes(controlId)) return null;
  return { version, control, node: at.node };
}

export const pageSources: DataSourceResolver = {
  async page(appId, pageId, principal, draft): Promise<DataSourceDef[] | null> {
    if (principal.kind === "guest" && principal.appId !== appId) return null;
    const found = documentFor(appId, principal, draft && principal.kind === "user");
    if (!found || !findPage(found.doc, pageId)) return null;
    try {
      // Unmapped placeholders (a skipped integration) are never read; components show "No data" for them.
      // A6.2: an editor's draft streams every data source, bound or not, so the data picker can show a live
      // sample of a source before anything uses it. Published versions and guests still get only used ones.
      const list = found.version === 0 ? found.doc.dataSources : sourcesUsed(found.doc, pageId);
      return list.filter((s) => !unmappedPackage(s.integrationId));
    } catch (err) {
      log.warn("sources failed", { appId, err: String(err) });
      return [];
    }
  },
};

/** Registers both hooks (idempotent). Called from instrumentation and from app-builder's own routes. */
export function registerAppBuilderHooks(): void {
  registerAppAccess(accessResolver);
  registerDataSources(pageSources);
}
