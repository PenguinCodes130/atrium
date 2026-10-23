// TEMPORARY app-shell preview route (/__shell-preview). It exercises the shell frame and primitives
// for screenshots, recordings and e2e tests until page-composer and settings ship real pages.
// Remove once they do (listed in the app-shell build reports).
//
// Every query value is clamped (gauntlet r1 security finding: `n` was unbounded). Custom CSS is
// chosen by name from a fixed list, never taken from the URL, and is scoped on the server here.
import { ShellPreview, type PreviewParams } from "./preview";
import { scopeCustomCss } from "@/features/shell/server";
import { PREVIEW_CSS, type PreviewCssName } from "./preview-css";
import { THEME_FONTS } from "@/features/shell/theme";

export const metadata = { title: "Shell preview" };

/** Upper bounds for the preview's query values. */
const PREVIEW_LIMITS = { widgets: 24, approvals: 999, drafts: 12, toasts: 5 } as const;

function bounded(raw: string | undefined, fallback: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(0, n));
}

const THEMES = new Set(["controlRoom", "daylight", "dusk", "solid"]);
const SCENES = new Set(["empty", "widgets", "lift", "loading", "buttons", "toasts", "error", "form", "app", "signin", "canvas", "glow"]);

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : sp[k]) as string | undefined;
  const cssName = one("css");
  const css = cssName && cssName in PREVIEW_CSS ? scopeCustomCss(PREVIEW_CSS[cssName as PreviewCssName]) : undefined;
  const scene = one("scene") ?? "empty";
  const theme = one("theme") ?? "controlRoom";
  const font = one("font");
  const params: PreviewParams = {
    scene: SCENES.has(scene) ? scene : "empty",
    theme: (THEMES.has(theme) ? theme : "controlRoom") as PreviewParams["theme"],
    count: bounded(one("n"), 6, PREVIEW_LIMITS.widgets),
    approvals: bounded(one("approvals"), 0, PREVIEW_LIMITS.approvals),
    drafts: bounded(one("drafts"), 0, PREVIEW_LIMITS.drafts),
    forceSweep: one("sweep") === "force",
    drift: /^\d{1,2}:\d{2}$/.test(one("drift") ?? "") ? one("drift")! : null,
    toasts: bounded(one("toasts"), 0, PREVIEW_LIMITS.toasts),
    customCss: css,
    font: (THEME_FONTS as readonly string[]).includes(font ?? "") ? (font as PreviewParams["font"]) : undefined,
    viewer: one("viewer") === "guest" ? "guest" : "user",
    canEdit: one("edit") !== "0",
    draft: one("draft") === "1",
  };
  if (params.scene === "error") throw new Error("Preview: deliberate failure to show the error screen");
  return <ShellPreview {...params} />;
}
