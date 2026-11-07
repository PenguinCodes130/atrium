// What a theme's Custom CSS box drops, in words (Wave 2.10c r2, gauntlet w210c-r1 Fix 15): the theme
// editor lists each removed rule or declaration with its reason, as the component CSS box does, instead
// of dropping it silently. The scoping is app-shell's sanitiser, the same call every canvas uses.
import "server-only";
import { scopeCustomCssWithReport } from "@/features/shell/server";
import { MAX_THEME_CSS } from "./revalidate";

export type CssRemoved = { text: string; reason: string };
export type CssReport = { removed: CssRemoved[]; tokenHint: boolean };

const OUTSIDE = /^(:root|html|body|:host)\b/i;

/** The removed parts of a theme's Custom CSS, each once, in the order they appear. */
export function themeCssReport(css: string): CssReport {
  if (!css.trim()) return { removed: [], tokenHint: false };
  const { dropped } = scopeCustomCssWithReport(css.slice(0, MAX_THEME_CSS), { root: { kind: "canvas" } });
  const selectors = new Set(dropped.filter((d) => d.kind === "selector").map((d) => d.text));
  const seen = new Set<string>();
  const removed: CssRemoved[] = [];
  for (const d of dropped) {
    // "No selector left" repeats a selector already named; keep the line that says why.
    if (d.kind === "rule" && selectors.has(d.text) && /no selector left/.test(d.reason)) continue;
    const key = `${d.text}\u0000${d.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // The sanitiser's sentence also lists :scope, which is refused only inside a longer selector; a bare
    // :scope is the canvas itself, which the hint below suggests, so name only the page-level selectors.
    const reason = d.kind === "selector" && OUTSIDE.test(d.text.trim()) && /reaches outside the canvas/.test(d.reason) ? "selector reaches outside the canvas (:root, html, body and :host are the whole page)" : d.reason;
    removed.push({ text: d.text, reason });
  }
  // A token set under :root (or html, body) is the usual slip: :scope is the canvas itself.
  const tokenHint = /--theme-/.test(css) && dropped.some((d) => d.kind === "selector" && OUTSIDE.test(d.text.trim()));
  return { removed: removed.slice(0, 50), tokenHint };
}
