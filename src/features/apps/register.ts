// Start-up registration for app-builder (architecture v3 section 2): the app access resolver, the page
// data source resolver, settings' app port and the version retention setting. Idempotent. Imported by
// instrumentation (shared file request) and, as a side effect, by every app-builder route and page.
import "server-only";
import type { PortApp } from "@/features/settings/app-port";
import { tokensToCssVars } from "@/features/shell/theme";
import { getInstanceSettings, registerAppPort, registerComponentToolsBackend, registerLibraryDeleteHandler, resolveTheme } from "./deps";
import { registerVersionRetention } from "./hooks";
import * as repo from "./repo";
import { registerAppBuilderHooks } from "./resolver";
import { applyDraftOps, applyOps, detachLibraryInstances, getDraftFor } from "./service";

const g = globalThis as unknown as { __atriumAppsLibraryDelete?: boolean };

function portApp(appId: string): PortApp | null {
  const app = repo.getApp(appId);
  const draft = app ? repo.getDraft(app.id) : null;
  if (!app || !draft) return null;
  const live = app.publishedVersion != null ? repo.getVersion(app.id, app.publishedVersion) : null;
  return { appId: app.id, slug: app.slug, name: app.name, draftRev: draft.rev, draft: draft.doc, ...(live ? { published: { version: live.version, doc: live.doc } } : {}) };
}

export function registerAppBuilder(): void {
  registerAppBuilderHooks();
  registerAppPort({
    async listApps() {
      return repo.listApps().map((a) => portApp(a.id)).filter((x): x is PortApp => !!x);
    },
    async getApp(appId) {
      return portApp(appId);
    },
    applyOps,
  });
  registerVersionRetention(() => {
    const r = getInstanceSettings().versionRetention as unknown;
    return typeof r === "number" ? r : null;
  });
  // components SFR-6 (a): components' agent tools edit drafts through app-builder's draft operations.
  registerComponentToolsBackend({
    getDraft(p, appId) {
      const { draft } = getDraftFor(p, appId);
      return { rev: draft.rev, doc: draft.doc };
    },
    applyOps(p, appId, ops, expectRev) {
      const r = applyDraftOps({ appId, ops, by: p, ...(expectRev !== undefined ? { expectRev } : {}) });
      return { rev: r.rev, changed: r.changed };
    },
    async themeTokens(doc, pageId) {
      const { theme } = await resolveTheme(doc, pageId);
      return tokensToCssVars(theme.tokens, theme.mode === "dark" ? "dark" : "light");
    },
  });
  // components SFR-6 (b): deleting a library component detaches its instances in every draft. The
  // library keeps a list of handlers, so this registers once per process.
  if (!g.__atriumAppsLibraryDelete) {
    g.__atriumAppsLibraryDelete = true;
    registerLibraryDeleteHandler((componentId, versions, by) => detachLibraryInstances(componentId, versions, by));
  }
}

registerAppBuilder();
