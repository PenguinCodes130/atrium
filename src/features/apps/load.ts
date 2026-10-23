// Server loading for the viewer, the draft preview and the builder canvas: which document, which page,
// the resolved theme and the scoped CSS. Every path goes through settings' canvasThemeCss and
// components' node and chrome CSS compilers (app-shell's sanitiser underneath).
import "server-only";
import type { App, AppDocument, LibraryComponent, PageDoc, Principal, RenderMode, Theme } from "@/core/contracts";
import { signedUrlsFor } from "@/features/data/signed-urls";
import { canEdit, canOpen } from "./access";
import { canEdit as canAddIntegrations } from "@/features/integrations/service";
import { canvasThemeCss, compileChromeCss, compileDocumentCss, libraryForDoc, resolveGuestValues, resolveTheme, signImageUrl, sourcesUsed } from "./deps";
import { pageBySlug, unmappedPackage } from "./doc";
import { unmappedMessage } from "./checks";
import * as repo from "./repo";
import { viewerDocument } from "./view";
import { guestSourceStates, NOT_CONNECTED_MESSAGE } from "./guest-states";
import { sourceFreeKeys } from "./guest-values";

export { NOT_CONNECTED_MESSAGE };
import { registerAppBuilder } from "./register";

export type Rendered = {
  doc: AppDocument;
  page: PageDoc | null;
  theme: Theme;
  themeNotice?: string;
  canvasCss: string;
  chromeCss: string;
  /** What the sanitiser removed from the chrome's style and CSS, as readable lines (gauntlet w2-r1 item 9). */
  chromeRemoved: string[];
  nodeCss: Record<string, string>;
  frameId: string;
  sources: { key: string; refreshSec: number }[];
  /**
   * Sources on this page whose integration was skipped: never streamed. People who can add integrations
   * see "No data: connect <package>" with a link to connect it; everyone else sees "Not connected yet"
   * and no link (gauntlet w2-r2 item 5).
   */
  unmapped: UnmappedSource[];
  /**
   * Guests only, resolved on the server at page load: the status of every component that reads an
   * unconnected source, and the value of every binding that reads no data source (w2-r3 item 4).
   */
  guestStatus?: Record<string, unknown>;
  /** The library versions the document's instances pin (`id@version`), so they render from that version. */
  library: Record<string, LibraryComponent>;
  /**
   * A4.2 and A5.1: signed `/api/img` paths for the literal absolute image URLs in a published document,
   * or in a draft shown to someone who may edit the app (empty for a draft shown to anyone else).
   */
  signedUrls: Record<string, string>;
};

export type UnmappedSource = { key: string; packageId: string; message: string; href: string };


export type ViewState =
  | { kind: "not-found" }
  | { kind: "not-published"; app: App }
  | { kind: "ok"; app: App; mode: RenderMode; rev: number; version: number | "draft"; draftOnly: string[]; editor: boolean; rendered: Rendered };

export function frameIdOf(app: Pick<App, "id">): string {
  return `app-${app.id.replace(/[^A-Za-z0-9_-]/g, "")}`.slice(0, 60);
}

/**
 * Theme, CSS and data sources for one page of a document, for one kind of viewer. The document's own
 * literal absolute image URLs (and those of the library versions it pins) are signed when `published`
 * marks a published version (A4.2), or when the viewer is `"editor"` (A5.1: callers pass "editor" only
 * after canEdit), so an editor's draft preview shows external images before publish. A draft is never
 * signed for a viewer or a guest. Template strings are skipped and signImageUrl's address rules apply.
 */
export async function renderPage(app: App, doc: AppDocument, page: PageDoc | null, viewer: "editor" | "viewer" | "guest", opts: { published?: boolean; connectLinks?: boolean } = {}): Promise<Rendered> {
  const frameId = frameIdOf(app);
  const resolved = await resolveTheme(doc, page?.id);
  const compiledChrome = doc.chrome.css || doc.chrome.style ? compileChromeCss(doc.chrome, frameId) : { css: "" as const, removed: [] as string[] };
  const chrome = compiledChrome.css;
  const shown = page ? viewerDocument(doc, viewer, page.id) : viewerDocument(doc, viewer, "");
  const library = libraryForDoc(shown);
  const nodeCss = page ? compileDocumentCss(doc, page.id, library) : {};
  // A6.2: an editor's draft names every data source (the data picker samples unbound ones); the rest only used ones.
  const used = page ? (viewer === "editor" && !opts.published ? doc.dataSources : sourcesUsed(doc, page.id)) : [];
  const sources = used.filter((s) => !unmappedPackage(s.integrationId)).map((s) => ({ key: s.name, refreshSec: s.refreshSec }));
  const unmapped = used.flatMap((s): UnmappedSource[] => {
    const pkg = unmappedPackage(s.integrationId);
    if (!pkg) return [];
    // "Connect it" only for people who can add integrations (gauntlet w2-r2 item 5).
    return [opts.connectLinks ? { key: s.name, packageId: pkg, message: unmappedMessage(pkg), href: `/integrations/new/${encodeURIComponent(pkg)}` } : { key: s.name, packageId: pkg, message: NOT_CONNECTED_MESSAGE, href: "" }];
  });
  // A guest's components read server-resolved statuses, not source states: give every component that
  // reads an unconnected source the same calm "Not connected yet" the signed-in views show, at once,
  // even when nothing on the page streams.
  // Gauntlet w2-r3 item 4: bindings that read no data source (a constant or formatted expression) are
  // resolved here too, for the guest view and the offline snapshot alike: nothing streams for them.
  let guestStatus: Record<string, unknown> | undefined;
  const free = viewer === "guest" && page ? sourceFreeKeys(page) : new Set<string>();
  if (viewer === "guest" && page && (unmapped.length || free.size)) {
    try {
      const all = resolveGuestValues(doc, page.id, {}, { scope: { $sources: guestSourceStates(doc) } as never });
      const calm = (k: string, v: unknown) => unmapped.length > 0 && k.endsWith(":$status") && (v as { kind?: string; message?: string })?.kind === "empty" && (v as { message?: string }).message === NOT_CONNECTED_MESSAGE;
      guestStatus = Object.fromEntries(Object.entries(all).filter(([k, v]) => calm(k, v) || free.has(k)));
    } catch {
      guestStatus = undefined;
    }
  }
  // Settings r2 (gauntlet w2-r1 item 3): signatures name this app, expire, and say who may use them: a
  // published version's are guest-safe; a draft's (A5.1) work only for the app's editors.
  const access = opts.published ? "guest" : "editor";
  const signedUrls = opts.published || viewer === "editor" ? signedUrlsFor([shown, Object.values(library)], (u) => signImageUrl(u, { appId: app.id, access }), { skipTemplates: true }) : {};
  return {
    doc: shown,
    page: page ? (shown.pages.find((p) => p.id === page.id) ?? null) : null,
    theme: resolved.theme,
    ...(resolved.notice ? { themeNotice: resolved.notice } : {}),
    canvasCss: canvasThemeCss(resolved.theme),
    chromeCss: chrome,
    chromeRemoved: viewer === "editor" ? compiledChrome.removed : [],
    nodeCss,
    frameId,
    sources,
    unmapped,
    ...(guestStatus ? { guestStatus } : {}),
    library,
    signedUrls,
  };
}

/**
 * The viewer route's decision (spec "App viewer", criteria 17, 38, 41): an unknown app, an app the
 * principal cannot open and a never-published app for a non-editor all answer not-found; an editor sees
 * "Not published yet". `?draft=1` is honoured for editors only (guests and others get the published version).
 */
export async function loadView(slug: string, pageSlug: string | undefined, p: Principal, opts: { draft: boolean; render: boolean; snapshot?: boolean }): Promise<ViewState> {
  registerAppBuilder();
  const app = repo.getAppBySlug(slug);
  if (!app || !canOpen(app, p)) return { kind: "not-found" };
  // The offline snapshot (gauntlet w2-r2 item 1): the published version in the guest projection,
  // whoever asks, so the copy a browser keeps offline never holds more than a guest of this app sees.
  if (opts.snapshot) {
    if (app.publishedVersion == null) return { kind: "not-found" };
    const live = repo.getVersion(app.id, app.publishedVersion)?.doc;
    if (!live) return { kind: "not-found" };
    const page = pageBySlug(live, pageSlug) ?? null;
    const rendered = await renderPage(app, live, page, "guest", { published: true });
    return { kind: "ok", app, mode: "view", rev: 0, version: app.publishedVersion, draftOnly: [], editor: false, rendered };
  }
  const editor = p.kind === "user" && canEdit(app, p);
  const useDraft = (opts.draft || opts.render) && editor;
  let doc: AppDocument | null = null;
  let version: number | "draft" = "draft";
  let rev = app.draftRev;
  if (useDraft) {
    const d = repo.getDraft(app.id);
    doc = d?.doc ?? null;
    rev = d?.rev ?? rev;
  } else if (app.publishedVersion != null) {
    doc = repo.getVersion(app.id, app.publishedVersion)?.doc ?? null;
    version = app.publishedVersion;
  }
  if (!doc) return editor ? { kind: "not-published", app } : { kind: "not-found" };
  const page = pageBySlug(doc, pageSlug) ?? null;
  const live = app.publishedVersion != null ? repo.getVersion(app.id, app.publishedVersion)?.doc : null;
  const liveIds = new Set((live?.controls ?? []).map((c) => c.id));
  const draftOnly = useDraft ? doc.controls.filter((c) => !liveIds.has(c.id)).map((c) => c.id) : [];
  const mode: RenderMode = useDraft ? (opts.render ? "agent-render" : "draft-preview") : "view";
  const rendered = await renderPage(app, doc, page, editor ? "editor" : p.kind === "guest" ? "guest" : "viewer", { published: !useDraft, connectLinks: p.kind !== "guest" && canAddIntegrations(p) });
  return { kind: "ok", app, mode, rev, version, draftOnly, editor, rendered };
}
