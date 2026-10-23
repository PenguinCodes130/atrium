// Theme resolution (settings spec 3.4; architecture 4.3 and 4.9) and the canvas CSS (spec 3.5, 3.7).
//
//   const { theme, notice } = await resolveTheme(doc, pageId);   // page theme over the app theme
//   <Canvas theme={theme} customCss={canvasThemeCss(theme)}>...  // the ONLY way to style a canvas
//
// - A page's own theme wins over the app theme.
// - `{ themeId }` resolves from the built-ins or the saved themes (drafts); `{ inline }` (what a
//   published or restored version holds, and imported app files) uses the copy it holds, so later
//   edits or deletes never change a live app.
// - A reference to a theme that no longer exists resolves to Control Room with MISSING_NOTICE.
// - Every theme returned has been through revalidateTheme(), whatever its source.
import "server-only";
import type { AppDocument, Theme, ThemeRef } from "@/core/contracts";
import { controlRoom, themeCanvasCss, themeToCssVars, resolveTokens, tokensToCssVars, type CanvasTone } from "@/features/shell";
import { scopeCustomCssWithReport, type ScopedCss } from "@/features/shell/server";
import { revalidateTheme } from "./revalidate";
import { MISSING_NOTICE, themeById } from "./store";

export type ResolvedTheme = { theme: Theme; notice?: string; /** values replaced on this read (spec 3.5) */ invalid?: number };

function fromRef(ref: ThemeRef | undefined): ResolvedTheme {
  if (!ref || typeof ref !== "object") return { theme: controlRoom };
  if ("inline" in ref) {
    const { theme, replaced } = revalidateTheme(ref.inline);
    return replaced ? { theme, invalid: replaced } : { theme };
  }
  if ("themeId" in ref && typeof ref.themeId === "string") {
    const found = themeById(ref.themeId);
    if (!found) return { theme: controlRoom, notice: MISSING_NOTICE };
    return found.invalid ? { theme: found.theme, invalid: found.invalid } : { theme: found.theme };
  }
  return { theme: controlRoom, notice: MISSING_NOTICE };
}

/** The theme a page renders in: its own theme if set, else the app theme. */
export async function resolveTheme(doc: AppDocument, pageId?: string): Promise<{ theme: Theme; notice?: string; invalid?: number }> {
  const page = pageId ? doc.pages?.find((p) => p.id === pageId) : undefined;
  return fromRef(page?.theme ?? doc.theme);
}

/** The copy a published version holds (architecture 4.9: publish snapshots every `{ themeId }`). */
export async function snapshotTheme(ref: ThemeRef): Promise<Theme> {
  return fromRef(ref).theme;
}

/** A document with every theme reference snapshotted inline (a convenience for publish). */
export async function snapshotDocument(doc: AppDocument): Promise<AppDocument> {
  return {
    ...doc,
    theme: { inline: await snapshotTheme(doc.theme) },
    pages: await Promise.all(doc.pages.map(async (p) => (p.theme ? { ...p, theme: { inline: await snapshotTheme(p.theme) } } : p))),
  };
}

/**
 * The theme's custom CSS, revalidated and scoped to the app canvas through app-shell's sanitiser
 * (architecture 13, A4.2). Pass it as the Canvas `customCss`; every canvas render path uses this and
 * never scopes or writes theme CSS itself. Returns an empty ScopedCss when the theme has none.
 */
export function canvasThemeCss(theme: Theme, opts: { scope?: string } = {}): ScopedCss {
  return canvasThemeCssWithReport(theme, opts).css;
}

export function canvasThemeCssWithReport(theme: Theme, opts: { scope?: string } = {}) {
  const { theme: t } = revalidateTheme(theme);
  return scopeCustomCssWithReport(t.customCss ?? "", { root: { kind: "canvas" }, ...(opts.scope ? { scope: opts.scope } : {}) });
}

/** The canvas's whole theme stylesheet for one canvas key: the token rule (revalidated) plus the scoped custom CSS. */
export function canvasStylesheet(theme: Theme, key: string): string {
  const { theme: t } = revalidateTheme(theme);
  return `${themeCanvasCss(t, key)}\n${canvasThemeCss(t)}`;
}

/**
 * The theme values sent into an HTML block (architecture 4.7 `theme`): the revalidated `--theme-*`
 * custom properties for the viewer's scheme. Every value is built from checked pieces.
 */
export function blockThemeValues(theme: Theme, scheme: CanvasTone = "light"): Record<string, string> {
  const { theme: t } = revalidateTheme(theme);
  if (t.mode !== "auto") return themeToCssVars(t).base;
  const uploaded = (t.fonts ?? []).map((f) => f.family);
  return tokensToCssVars(resolveTokens(t, scheme), scheme, uploaded);
}
