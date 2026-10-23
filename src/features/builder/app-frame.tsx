"use client";
// One app page drawn the way its author made it (architecture v3 sections 4.3, 4.6 and 13; A4.3): the
// app's own chrome and the page tree, inside app-shell's clipping Canvas with the page's theme. Used by
// the viewer (/a/<slug>), the draft preview and the builder canvas, so all three render identically.
import Link from "next/link";
import type { ReactNode } from "react";
import type { AppDocument, PageDoc, RenderContext, Theme } from "@/core/contracts";
import { Canvas, EmptyRoom, ROOM_COPY } from "@/features/shell";
import type { ScopedCss } from "@/features/shell/custom-css";
import { orderedPages } from "@/features/apps/doc";
import { NodeCssProvider, RenderDeviceProvider, RenderNode } from "./components-client";

export type FrameProps = {
  doc: AppDocument;
  page: PageDoc | null;
  ctx: RenderContext;
  theme: Theme;
  canvasCss: string;
  chromeCss: string;
  frameId: string;
  nodeCss: Record<string, string>;
  hrefFor(page: PageDoc): string;
  device?: "desktop" | "mobile" | "auto";
  className?: string;
  /** Builder: interactive overlays drawn over the page (selection, drop cells), inside the clip. */
  overlay?: ReactNode;
  emptyAction?: ReactNode;
};

export function AppChrome({ doc, current, hrefFor }: { doc: AppDocument; current: string | null; hrefFor(page: PageDoc): string }) {
  const layout = doc.chrome.layout;
  const pages = orderedPages(doc).filter((p) => p.inNav);
  const title = doc.chrome.title ?? doc.app.name;
  if (layout === "none") return null;
  const items = pages.map((p) => (
    <Link key={p.id} href={hrefFor(p)} aria-current={p.id === current ? "page" : undefined} className="inline-flex min-h-9 items-center px-3 type-label touch:min-h-11" data-app-nav-item={p.slug}>
      {p.title}
    </Link>
  ));
  if (layout === "sidebar") {
    return (
      <nav data-canvas-nav data-app-chrome="sidebar" aria-label={`${title} pages`} className="flex flex-col gap-1 p-3 sm:w-56 sm:flex-none">
        <div className="mb-2 px-3 type-title-3" data-app-title>{doc.chrome.logo ? <img src={doc.chrome.logo} alt="" className="mb-2 h-8 w-auto" /> : null}{title}</div>
        {items}
      </nav>
    );
  }
  return (
    <nav data-canvas-nav data-app-chrome={layout} aria-label={`${title} pages`} className={`flex flex-wrap items-center gap-2 px-4 ${layout === "tabs" ? "py-2" : "py-3"}`}>
      {layout === "topbar" && (
        <span className="mr-4 flex items-center gap-2 type-title-3" data-app-title>
          {doc.chrome.logo ? <img src={doc.chrome.logo} alt="" className="h-7 w-auto" /> : null}
          {title}
        </span>
      )}
      {items}
    </nav>
  );
}

/** A7.5: the page's own padding (none, or 0 to 64 px) instead of the theme's. */
function pagePadding(page: PageDoc | null): React.CSSProperties | undefined {
  if (!page || page.padding === undefined) return undefined;
  return { padding: page.padding === "none" ? 0 : Math.max(0, Math.min(64, page.padding)) };
}

export function AppFrame({ doc, page, ctx, theme, canvasCss, chromeCss, frameId, nodeCss, hrefFor, device = "auto", className, overlay, emptyAction }: FrameProps) {
  const sidebar = doc.chrome.layout === "sidebar";
  const empty = page && (!page.root.children || page.root.children.length === 0);
  return (
    <Canvas theme={theme} customCss={(canvasCss || undefined) as ScopedCss | undefined} scope={undefined} className={className ?? "min-h-dvh"} data-app-canvas={doc.app.name}>
      <div data-atrium-app-frame={frameId} className={`relative flex min-h-[inherit] ${sidebar ? "flex-col sm:flex-row" : "flex-col"}`}>
        {chromeCss ? <style data-chrome-css>{chromeCss}</style> : null}
        <AppChrome doc={doc} current={page?.id ?? null} hrefFor={hrefFor} />
        <main className={`relative min-w-0 flex-1 ${page && page.padding !== undefined ? "" : "p-[var(--theme-pad)]"}`} style={pagePadding(page)} data-app-page={page?.slug ?? "missing"} data-page-padding={page?.padding ?? "theme"} data-page-width={page?.maxWidth ?? "fill"}>
          {!page ? (
            <EmptyRoom headingLevel={1} title={ROOM_COPY.missing.title} body={null} actions={<Link className="underline" href={hrefFor(orderedPages(doc)[0]!)}>Go to {doc.app.name}</Link>} />
          ) : empty && ctx.mode !== "edit" ? (
            <EmptyRoom headingLevel={2} title={ROOM_COPY.page.title} body={ctx.mode === "view" ? null : ROOM_COPY.page.body} actions={emptyAction} />
          ) : (
            <NodeCssProvider css={nodeCss}>
              <RenderDeviceProvider device={device}>
                {/* A7.5: a page width caps the content and centres it; without one the page fills the screen. */}
                {page.maxWidth ? (
                  <div className="mx-auto w-full" style={{ maxWidth: page.maxWidth }} data-page-max={page.maxWidth}>
                    <RenderNode node={page.root} ctx={ctx} />
                  </div>
                ) : (
                  <RenderNode node={page.root} ctx={ctx} />
                )}
              </RenderDeviceProvider>
            </NodeCssProvider>
          )}
          {overlay}
        </main>
      </div>
    </Canvas>
  );
}
