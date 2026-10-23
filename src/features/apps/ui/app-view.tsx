"use client";
// The app viewer (spec section 3 "App viewer", "Preview", "Guests"): the published version full screen,
// or the draft under app-shell's draft preview bar, or an agent render with controls disabled. Atrium
// draws only the shell's switcher (server slot), the draft bar, the control confirm and toasts.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AppDocument, ControlRunResponse, LibraryComponent, PageDoc, Principal, RenderContext, RenderMode, Theme } from "@/core/contracts";
import { AppToaster, ControlConfirm, DraftPreviewBar, OFFLINE_MESSAGE, useOnline } from "@/features/shell";
import { AppFrame } from "@/features/builder/app-frame";
import { createControlRunner } from "@/features/builder/components-client";
import { unmappedStates, usePageData, type UnmappedSource } from "@/features/builder/use-page-data";
import { forgetLastValues } from "@/features/pwa/offline";
import { viewerRunMessage } from "@/features/apps/run-message";

export type ViewProps = {
  app: { id: string; slug: string; name: string };
  doc: AppDocument;
  pageId: string | null;
  mode: RenderMode;
  principal: Principal;
  viewerName: string;
  theme: Theme;
  canvasCss: string;
  chromeCss: string;
  nodeCss: Record<string, string>;
  frameId: string;
  draftRev: number;
  draftOnly: string[];
  sources: { key: string; refreshSec: number }[];
  /** Sources whose integration was skipped: shown as "No data: connect <package>", never streamed. */
  unmapped?: UnmappedSource[];
  /** Pinned library versions (`id@version`) the page's instances render from. */
  library: Record<string, LibraryComponent>;
  /** A4.2: signed image paths for URLs in the published document (the stream adds its own). */
  signedUrls: Record<string, string>;
  /** Who the saved last values belong to ("user:<id>", "guest:<link id>"); null on an offline snapshot. */
  owner?: string | null;
  /** The copy the app's worker keeps for offline use (gauntlet w2-r2 item 1). */
  snapshot?: boolean;
  /** The viewer may edit this app: only editors see author-facing repair text from a failed run. */
  canEdit?: boolean;
  /** Guests: server-resolved statuses for components that read an unconnected source (w2-r2 item 5). */
  guestStatus?: Record<string, unknown>;
};

type Ask = { title: string; body?: string; resolve(ok: boolean): void } | null;

/** The host-drawn confirm (top layer) as a promise. */
export function useConfirm(): [(text: string) => Promise<boolean>, React.ReactNode] {
  const [ask, setAsk] = useState<Ask>(null);
  const confirm = useCallback((text: string) => new Promise<boolean>((resolve) => {
    const m = /^(Draft preview: run .+ for real\?)( Not published yet\.)?$/.exec(text);
    setAsk({ title: m ? m[1]! : text, ...(m?.[2] ? { body: "Not published yet" } : {}), resolve });
  }), []);
  const done = (ok: boolean) => {
    ask?.resolve(ok);
    setAsk(null);
  };
  const node = <ControlConfirm open={!!ask} title={ask?.title ?? ""} body={ask?.body} confirmLabel={ask?.title.startsWith("Draft preview") ? "Run it for real" : "Run it"} onConfirm={() => done(true)} onCancel={() => done(false)} />;
  return [confirm, node];
}

export function hrefForPage(slug: string, page: PageDoc, draft: boolean): string {
  return `/a/${slug}/${page.slug}${draft ? "?draft=1" : ""}`;
}

export function AppView(p: ViewProps) {
  const router = useRouter();
  const draft = p.mode === "draft-preview" || p.mode === "agent-render";
  const page = p.pageId ? p.doc.pages.find((x) => x.id === p.pageId) ?? null : null;
  const guest = p.principal.kind === "guest";
  const live = usePageData(page ? { appId: p.app.id, pageId: page.id, draft } : null, p.sources, !!page && p.sources.length > 0, { remember: p.mode === "view", owner: p.snapshot ? null : (p.owner ?? null) });
  const [confirm, confirmNode] = useConfirm();
  const draftOnly = useMemo(() => new Set(p.draftOnly), [p.draftOnly]);
  const controls = useMemo(() => Object.fromEntries(p.doc.controls.map((c) => [c.id, { label: c.label, ...(c.confirm ? { confirm: c.confirm } : {}), ...(draftOnly.has(c.id) ? { draftOnly: true } : {}) }])), [p.doc.controls, draftOnly]);
  const runner = useRef<((nodeId: string, controlId: string, input?: unknown) => Promise<ControlRunResponse>) | null>(null);
  const run = createControlRunner({ appId: p.app.id, mode: p.mode, controls, confirm });
  const canEditApp = !!p.canEdit;
  runner.current = async (nodeId, controlId, input) => {
    const r = await run(nodeId, controlId, input);
    return r.ok ? r : { ...r, message: viewerRunMessage(r.message, canEditApp, guest) };
  };
  const ctx: RenderContext = useMemo(
    () => ({
      mode: p.mode,
      principal: p.principal,
      appId: p.app.id,
      pageId: page?.id ?? "",
      version: draft ? "draft" : 0,
      values: {
        $data: guest ? {} : live.data,
        $sources: guest ? undefined : { ...unmappedStates(p.unmapped), ...live.states },
        $guest: guest ? { ...(p.guestStatus ?? {}), ...(live.guest ?? {}) } : undefined,
        $controls: controls,
        $library: p.library,
        $signedUrls: { ...p.signedUrls, ...live.signedUrls },
        $available: true,
        $pages: p.doc.pages.map((x) => ({ id: x.id, slug: x.slug, title: x.title })),
        $sourceLabels: Object.fromEntries(p.doc.dataSources.flatMap((s) => (s.label ? [[s.name, s.label]] : []))),
        $page: { id: page?.id ?? "", slug: page?.slug ?? "", title: page?.title ?? "" },
        $app: { id: p.app.id, slug: p.app.slug, name: p.doc.app.name },
        $user: { kind: guest ? "guest" : "user", name: p.viewerName },
        $viewer: { kind: guest ? "guest" : "user", name: p.viewerName },
      } as RenderContext["values"],
      runControl: (nodeId, controlId, input) => runner.current!(nodeId, controlId, input),
      confirm,
      navigate: (target) => {
        if ("pageId" in target) {
          const to = p.doc.pages.find((x) => x.id === target.pageId || x.slug === target.pageId);
          if (to) router.push(hrefForPage(p.app.slug, to, p.mode === "draft-preview"));
        } else if (target.href.startsWith("/") && !target.href.startsWith("//")) router.push(target.href);
      },
    }),
    [p.mode, p.principal, p.app.id, p.app.slug, p.doc, page, draft, guest, live, controls, confirm, router, p.viewerName, p.library, p.signedUrls, p.unmapped, p.guestStatus],
  );
  const online = useOnline();
  // Gauntlet w2-r2 item 11: while offline the app starts below the strip, so the strip covers nothing.
  const stripRef = useRef<HTMLDivElement>(null);
  const [stripH, setStripH] = useState(0);
  useEffect(() => {
    if (online) return setStripH(0);
    const el = stripRef.current;
    if (!el) return;
    const measure = () => setStripH(Math.ceil(el.getBoundingClientRect().height));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [online]);
  const draftOffset = p.mode === "draft-preview" ? "36px + env(safe-area-inset-top, 0px)" : "";
  const topOffset = [draftOffset, stripH ? `${stripH}px` : ""].filter(Boolean).join(" + ");
  useEffect(() => {
    // A worker that lost access to this app (sign-out, revoked link) tells its pages to forget.
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => { if ((e.data as { type?: string })?.type === "atrium-offline-cleared") forgetLastValues(); };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);
  useEffect(() => {
    // The app's own worker (criterion 47): scoped to this app, published views only. The offline
    // snapshot itself never registers or feeds the worker.
    if (p.mode !== "view" || p.snapshot || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    // Scope and canonical address agree (gauntlet w2-r1 item 4). Once the worker is active, the page hands
    // it the document and the files it loaded, so an offline reload can draw the app after one visit.
    const base = `/a/${p.app.slug}`;
    navigator.serviceWorker
      .register(`${base}/sw.js`, { scope: base })
      .then(() => navigator.serviceWorker.ready)
      .then((reg) => {
        const urls = [window.location.pathname + window.location.search, ...performance.getEntriesByType("resource").map((e) => e.name).filter((u) => u.startsWith(window.location.origin))];
        reg.active?.postMessage({ type: "atrium-cache", urls });
      })
      .catch(() => {});
  }, [p.mode, p.app.slug, p.snapshot]);
  return (
    <>
      {!online && (
        <div ref={stripRef} role="status" className="fixed inset-x-0 top-0 z-[60] bg-[#15130F] px-4 pt-[calc(0.5rem+env(safe-area-inset-top,0px))] pb-2 text-center type-label text-[#F3EFE4]" data-app-offline>
          {OFFLINE_MESSAGE}
        </div>
      )}
      {/* The draft preview bar is 36px of fixed glass at the top: the app starts below it, so its title and
          navigation stay fully visible (gauntlet w2-r1 item 10). */}
      <div style={topOffset ? { paddingTop: `calc(${topOffset})` } : undefined} data-draft-offset={p.mode === "draft-preview" ? "36" : undefined} data-offline-offset={stripH || undefined}>
        <AppFrame doc={p.doc} page={page} ctx={ctx} theme={p.theme} canvasCss={p.canvasCss} chromeCss={p.chromeCss} frameId={p.frameId} nodeCss={p.nodeCss} hrefFor={(x) => hrefForPage(p.app.slug, x, p.mode === "draft-preview")} />
      </div>
      {p.mode === "draft-preview" && <DraftPreviewBar rev={p.draftRev} builderHref={`/build/${p.app.slug}${page ? `/${page.slug}` : ""}`} />}
      {confirmNode}
      <AppToaster />
    </>
  );
}
