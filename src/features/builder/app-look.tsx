"use client";
// App look (spec "Builder"; gauntlet w2-r1 items 7 and 9): opened from the builder bar's "Look" entry and
// from the Pages menu. The app theme with "Customise" (accent and wallpaper inline, saved as this app's
// own copy) and "Save as a theme" for an inline copy; the page theme; the app's chrome (navigation, title,
// logo), a style panel for the bar, an item and the active item, and the navigation CSS with every rule
// the sanitiser removed listed under it. Theme options come from settings.
import { useState } from "react";
import type { AppDocument, ChromeDef, DraftOp, PageDoc, StyleOverride, StyleProps, Theme, ThemeRef } from "@/core/contracts";
import { Button, Sheet, toast } from "@/features/shell";
import { ThemePicker, UploadField } from "./components-client";
import { revalidateTheme } from "@/features/themes/client";
import { contrastReport, type ContrastWarning } from "@/features/shell";
import { colorToRgba, contrastRatio } from "@/features/shell/theme";
import { ChoiceGroup } from "@/features/settings/ui/controls";

const field = "h-9 w-full border border-line-strong bg-bg-hi px-2 type-body text-fg outline-none focus-visible:outline-2 focus-visible:outline-accent-ink touch:h-11";
const HEX = /^#[0-9a-fA-F]{6}$/;

type Wallpaper = { kind: "keep" | "color" | "gradient" | "image"; a: string; b: string; image: string };

const INK = "#15130F";
const PAPER = "#F3EFE4";

function hexOr(v: string | undefined, fallback: string): string {
  return v && HEX.test(v) ? v : fallback;
}

/** Any theme colour (hex or oklch) as #rrggbb, for the colour inputs; null when it is not one. */
export function toHex(c: string | undefined): string | null {
  const rgba = c ? colorToRgba(c) : null;
  if (!rgba) return null;
  const h = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
  return `#${h(rgba.r)}${h(rgba.g)}${h(rgba.b)}`.toUpperCase();
}

function sameColour(a: string | undefined, b: string | undefined): boolean {
  const x = toHex(a);
  return !!x && x === toHex(b);
}

function ratio(fg: string, bg: string): number {
  const f = colorToRgba(fg);
  const g = colorToRgba(bg);
  return f && g ? contrastRatio({ ...f, a: 1 }, { ...g, a: 1 }) : 0;
}

/** Ink or paper, whichever reads better on every colour given (worst case). */
export function readableOn(backs: string[]): { color: string; ratio: number } {
  const worst = (fg: string) => Math.min(...backs.map((b) => ratio(fg, b)));
  const ink = worst(INK);
  const paper = worst(PAPER);
  return ink >= paper ? { color: INK, ratio: +ink.toFixed(2) } : { color: PAPER, ratio: +paper.toFixed(2) };
}

/**
 * The colours the wallpaper swatches start from (gauntlet w2-r2 item 3): the base theme's own wallpaper
 * colours, so a dark theme stays dark; when the wallpaper has none (an image), dark or light defaults by
 * the theme's mode.
 */
export function wallpaperDefaults(base: Theme): { a: string; b: string } {
  const w = base.tokens.wallpaper;
  const named = w.kind === "color" ? [w.value, w.value] : w.kind === "gradient" || w.kind === "sky" ? (w.colors?.length ? w.colors : w.value.match(/oklch\([^)]*\)|#[0-9a-f]{3,8}\b/gi) ?? []) : [];
  const hex = named.map((c) => toHex(c)).filter((c): c is string => !!c);
  const dark = base.mode === "dark";
  const fa = dark ? "#2A2620" : PAPER;
  const fb = dark ? INK : "#C9D8E6";
  return { a: hex[0] ?? fa, b: hex[1] ?? hex[0] ?? fb };
}

/**
 * This app's own copy of a theme with a new accent and wallpaper (an inline theme, valid by
 * construction). Gauntlet w2-r2 item 4: when the base's navigation active fill follows its accent (Dusk,
 * Solid and their copies), the fill takes the new accent and its text a contrasting ink. The text on the
 * accent changes only when it would no longer read (under 4.5:1). `canvasText` replaces the canvas text
 * colour (the contrast fix).
 */
export function customisedTheme(base: Theme, appName: string, accent: string, wp: Wallpaper, opts: { canvasText?: string } = {}): Theme {
  const tokens = structuredClone(base.tokens);
  const accentText = ratio(base.tokens.color.accentText, accent) >= 4.5 ? base.tokens.color.accentText : readableOn([accent]).color;
  const follows = sameColour(base.tokens.chrome.activeFill, base.tokens.color.accent);
  tokens.color.accent = accent;
  tokens.color.accentText = accentText;
  if (follows) tokens.chrome = { ...tokens.chrome, activeFill: accent, activeText: accentText };
  if (opts.canvasText && HEX.test(opts.canvasText)) tokens.color.canvasText = opts.canvasText;
  if (wp.kind === "color") tokens.wallpaper = { ...tokens.wallpaper, kind: "color", value: wp.a, colors: undefined };
  if (wp.kind === "gradient") tokens.wallpaper = { ...tokens.wallpaper, kind: "gradient", value: `linear-gradient(to bottom, ${wp.a}, ${wp.b})`, colors: [wp.a, wp.b] };
  if (wp.kind === "image" && wp.image) tokens.wallpaper = { ...tokens.wallpaper, kind: "image", value: wp.image, colors: undefined };
  if (tokens.wallpaper.colors === undefined) delete tokens.wallpaper.colors;
  const id = base.id.startsWith("app-") ? base.id : `app-${base.id}`.slice(0, 60);
  let dark = base.dark;
  if (dark) {
    const darkFollows = !!dark.chrome && sameColour(dark.chrome.activeFill, dark.color?.accent ?? base.tokens.color.accent);
    const darkText = dark.color ? (ratio(dark.color.accentText, accent) >= 4.5 ? dark.color.accentText : readableOn([accent]).color) : accentText;
    dark = { ...dark, ...(dark.color ? { color: { ...dark.color, accent, accentText: darkText } } : {}), ...(dark.chrome && darkFollows ? { chrome: { ...dark.chrome, activeFill: accent, activeText: darkText } } : {}) };
  }
  const draft: Theme = { ...base, id, name: `${appName} look`.slice(0, 60), tokens, ...(dark ? { dark } : {}) };
  return revalidateTheme(draft, { id }).theme;
}

/** Contrast problems of a customised theme, the same check the Settings theme editor runs. */
export function customiseWarnings(t: Theme): ContrastWarning[] {
  // Over an image the shell's report can only assume white and black; that case is not judged here.
  return contrastReport(t).warnings.filter((w) => !(t.tokens.wallpaper.kind === "image" && w.field === "color.canvasText"));
}

const PAIR: Record<string, string> = {
  "color.canvasText": "Text on the wallpaper",
  "color.surfaceText": "Text on cards",
  "color.surfaceMuted": "Muted text on cards",
  "color.accentText": "Text on the accent",
};

function Customise({ base, appName, onSave, onCancel }: { base: Theme; appName: string; onSave(t: Theme): void; onCancel(): void }) {
  const [accent, setAccent] = useState(toHex(base.tokens.color.accent) ?? "#E9B949");
  const defaults = wallpaperDefaults(base);
  const [wp, setWallpaper] = useState<Wallpaper>({ kind: "keep", a: defaults.a, b: defaults.b, image: "" });
  const [canvasText, setCanvasText] = useState<string | undefined>(undefined);
  // A text colour picked for one wallpaper is dropped when the wallpaper changes, so it never carries
  // onto a wallpaper it does not suit; the contrast check then judges the theme's own text again.
  const setWp = (next: Wallpaper) => {
    setWallpaper(next);
    setCanvasText(undefined);
  };
  const preview = HEX.test(accent) ? customisedTheme(base, appName, accent, wp, canvasText ? { canvasText } : {}) : null;
  const warnings = preview ? customiseWarnings(preview) : [];
  const backs = wp.kind === "color" ? [wp.a] : wp.kind === "gradient" ? [wp.a, wp.b] : [];
  const textFix = warnings.some((w) => w.field === "color.canvasText") && backs.length ? readableOn(backs) : null;
  return (
    <div className="flex flex-col gap-3 border border-line-strong bg-bg-sunk p-3" data-look-customise>
      <label className="flex items-center gap-3 type-label">Accent
        <input type="color" value={hexOr(accent, "#E9B949")} onChange={(e) => setAccent(e.target.value.toUpperCase())} className="h-9 w-12 cursor-pointer border border-line-strong bg-bg-hi touch:h-11" data-look-accent />
        <input className={`${field} max-w-28 font-mono`} value={accent} onChange={(e) => setAccent(e.target.value)} aria-label="Accent hex" />
      </label>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 type-label">Wallpaper</legend>
        <ChoiceGroup label="Wallpaper" hideLabel name="look-wallpaper" value={wp.kind} onChange={(k) => setWp({ ...wp, kind: k })} options={(["keep", "color", "gradient", "image"] as const).map((k) => ({ value: k, label: k === "keep" ? "Keep" : k === "color" ? "Colour" : k === "gradient" ? "Gradient" : "Image", data: { "look-wallpaper": k } }))} />
        {(wp.kind === "color" || wp.kind === "gradient") && (
          <div className="flex items-center gap-2">
            <input type="color" value={hexOr(wp.a, defaults.a)} onChange={(e) => setWp({ ...wp, a: e.target.value.toUpperCase() })} className="h-9 w-12 border border-line-strong touch:h-11" aria-label="Wallpaper colour" data-look-wallpaper-a />
            {wp.kind === "gradient" && <input type="color" value={hexOr(wp.b, defaults.b)} onChange={(e) => setWp({ ...wp, b: e.target.value.toUpperCase() })} className="h-9 w-12 border border-line-strong touch:h-11" aria-label="Second wallpaper colour" data-look-wallpaper-b />}
            <span className="font-mono text-[11px] text-fg-2">from {base.name}</span>
          </div>
        )}
        {wp.kind === "image" && <UploadField value={wp.image || undefined} accept="image" onChange={(path: string) => setWp({ ...wp, image: path })} />}
      </fieldset>
      {/* The Settings theme editor's contrast check (gauntlet w2-r2 item 3), live as the choices change. */}
      {warnings.length > 0 ? (
        <ul className="flex flex-col gap-1 border-l-4 border-l-warn bg-bg-hi px-2 py-1.5" aria-label="Contrast warnings" data-look-contrast>
          {warnings.map((w) => (
            <li key={`${w.field}-${w.scheme}`} className="type-caption text-fg" data-look-contrast-warning={w.field}>
              {PAIR[w.field] ?? w.field}: {w.ratio.toFixed(2)}:1{preview?.mode === "auto" ? ` (${w.scheme})` : ""}, below 4.5:1.
              {w.field === "color.canvasText" && textFix && (
                <button type="button" className="ml-1 min-h-9 underline touch:min-h-11" onClick={() => setCanvasText(textFix.color)} data-look-text-fix>Use {textFix.color} ({textFix.ratio.toFixed(1)}:1)</button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="type-caption text-fg-2" data-look-contrast-ok>Text stays readable: every pair is 4.5:1 or more.</p>
      )}
      <div className="flex gap-2">
        <Button variant="ink" disabled={!preview} onClick={() => preview && onSave(preview)} data-look-save>{warnings.length ? "Use anyway" : "Use on this app"}</Button>
        <Button variant="quiet" onClick={onCancel}>Cancel</Button>
      </div>
      <p className="type-caption text-fg-2">This saves a copy of the theme inside this app. The theme in Settings is not changed.{preview && sameColour(preview.tokens.chrome.activeFill, accent) ? " The navigation's active item follows the accent." : ""}</p>
    </div>
  );
}

type Target = "root" | "item" | "active";
const STYLE_FIELDS: { prop: keyof StyleProps; label: string; kind: "color" | "len" }[] = [
  { prop: "background", label: "Background", kind: "color" },
  { prop: "color", label: "Text", kind: "color" },
  { prop: "borderRadius", label: "Corner radius (px)", kind: "len" },
  { prop: "padding", label: "Padding (px)", kind: "len" },
];

const CHROME_TOKENS = ["accent", "accentText", "surface", "surfaceText", "canvasText", "surfaceMuted", "line"] as const;
const CHROME_TOKEN_NAMES: Record<(typeof CHROME_TOKENS)[number], string> = { accent: "Accent", accentText: "Text on accent", surface: "Surface", surfaceText: "Surface text", canvasText: "Page text", surfaceMuted: "Muted text", line: "Line" };

/**
 * The chrome's style for the bar, one item and the active item (ChromeDef.style slots root and item).
 * Colours are the theme's named swatches first, saved as `token:<name>` so the navigation follows the
 * theme (gauntlet w2-r2 item 13), with a custom colour beside them.
 */
function ChromeStyle({ chrome, theme, apply }: { chrome: ChromeDef; theme: Theme; apply(ops: DraftOp[]): void }) {
  const [target, setTarget] = useState<Target>("root");
  const style: StyleOverride = chrome.style ?? {};
  const slot = target === "root" ? "root" : "item";
  const slotStyle = (style[slot] ?? {}) as StyleProps & { states?: Partial<Record<string, StyleProps>> };
  const current: StyleProps = target === "active" ? slotStyle.states?.active ?? {} : slotStyle;
  const set = (prop: keyof StyleProps, v: string) => {
    const value: string | number | undefined = v === "" ? undefined : STYLE_FIELDS.find((f) => f.prop === prop)?.kind === "len" ? Number(v) : v;
    const next: StyleProps = { ...current, [prop]: value };
    if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) delete (next as Record<string, unknown>)[prop];
    const nextSlot = target === "active" ? { ...slotStyle, states: { ...(slotStyle.states ?? {}), active: next } } : { ...next, ...(slotStyle.states ? { states: slotStyle.states } : {}) };
    apply([{ op: "chrome.update", patch: { style: { ...style, [slot]: nextSlot } } }]);
  };
  const colours = theme.tokens.color as unknown as Record<string, string>;
  return (
    <div className="flex flex-col gap-3" data-chrome-style>
      <ChoiceGroup<Target> label="Style for" hideLabel name="chrome-style-target" value={target} onChange={setTarget} options={(["root", "item", "active"] as const).map((t) => ({ value: t, label: t === "root" ? "Bar" : t === "item" ? "Item" : "Active item", data: { "chrome-style-target": t } }))} />
      {STYLE_FIELDS.map((f) => {
        const v = current[f.prop];
        const text = v === undefined ? "" : String(v);
        if (f.kind === "color") {
          return (
            <fieldset key={f.prop} className="m-0 flex flex-col gap-1.5 border-0 p-0" data-chrome-style-field={f.prop}>
              <legend className="mb-1 type-caption text-fg-2">{f.label}</legend>
              <div className="flex flex-wrap items-center gap-1" role="group" aria-label={`${f.label}: theme colours`}>
                {CHROME_TOKENS.map((t) => {
                  const on = text === `token:${t}`;
                  return <button key={t} type="button" aria-pressed={on} aria-label={CHROME_TOKEN_NAMES[t]} title={CHROME_TOKEN_NAMES[t]} onClick={() => set(f.prop, on ? "" : `token:${t}`)} className={`h-8 w-8 border touch:h-11 touch:w-11 ${on ? "border-2 border-fg outline outline-1 outline-offset-1 outline-accent-ink" : "border-line-strong"}`} style={{ background: colours[t] }} data-chrome-swatch={t} />;
                })}
                <label className="relative h-8 w-8 cursor-pointer border border-dashed border-line-strong touch:h-11 touch:w-11" title="Custom colour">
                  <span className="sr-only">{f.label}: custom colour</span>
                  <input type="color" value={hexOr(text, "#ffffff")} onChange={(e) => set(f.prop, e.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" data-chrome-style-custom={f.prop} />
                  <span aria-hidden className="absolute inset-1" style={{ background: text && !text.startsWith("token:") ? text : "transparent" }} />
                </label>
                {v !== undefined && <button type="button" className="inline-flex min-h-8 items-center px-1 type-caption underline touch:min-h-11" onClick={() => set(f.prop, "")}>Clear</button>}
              </div>
              {text.startsWith("token:") && <p className="type-caption text-fg-2">{CHROME_TOKEN_NAMES[text.slice(6) as (typeof CHROME_TOKENS)[number]] ?? text}, from the theme</p>}
            </fieldset>
          );
        }
        return (
          <label key={f.prop} className="grid grid-cols-[1fr_auto] items-center gap-2 type-caption">
            {f.label}
            <input className={`${field} w-20`} inputMode="numeric" value={text} onChange={(e) => set(f.prop, e.target.value.replace(/[^0-9]/g, ""))} data-chrome-style-field={f.prop} />
          </label>
        );
      })}
    </div>
  );
}

export function AppLookSheet({ appId, doc, page, theme, chromeRemoved, onClose, apply }: { appId: string; doc: AppDocument; page: PageDoc; theme: Theme; chromeRemoved?: string[]; onClose(): void; apply(ops: DraftOp[]): void }) {
  const [title, setTitle] = useState(doc.chrome.title ?? "");
  const [css, setCss] = useState(doc.chrome.css ?? "");
  const [customising, setCustomising] = useState(false);
  const [saving, setSaving] = useState(false);
  const layout = doc.chrome.layout;
  const inline = "inline" in doc.theme ? doc.theme.inline : null;
  // The base for "Customise": this app's inline copy, else the theme the canvas resolved.
  const base = inline ?? theme;

  async function saveAsTheme() {
    if (!inline) return;
    setSaving(true);
    const res = await fetch("/api/settings/themes", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ theme: { ...inline, name: inline.name } }) }).catch(() => null);
    const body = (await res?.json().catch(() => ({}))) as { id?: string; name?: string; error?: { message?: string } };
    setSaving(false);
    if (!res?.ok || !body.id) return toast({ kind: "error", title: "Not saved as a theme", description: body.error?.message ?? "Try again." });
    apply([{ op: "theme.set", theme: { themeId: body.id } }]);
    toast({ kind: "success", title: `Saved as the theme ${body.name ?? inline.name}`, description: "This app now uses it." });
  }

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title="App look" path="builder / app look" name="app-look" width={440}>
      <div className="flex flex-col gap-5" data-app-look-sheet data-app-id={appId}>
        <section className="flex flex-col gap-2">
          <h3 className="type-title-3">App theme</h3>
          {inline ? (
            <p className="flex items-center gap-2 type-body" data-look-inline>
              <span aria-hidden className="h-4 w-4 border border-line-strong" style={{ background: inline.tokens.color.accent }} />
              {inline.name} <span className="font-mono text-[11px] text-fg-2">this app's own copy</span>
            </p>
          ) : null}
          <ThemePicker inheritLabel={null} value={doc.theme} onChange={(ref: ThemeRef | undefined) => apply([{ op: "theme.set", theme: ref ?? { themeId: "control-room" } }])} />
          {!customising ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setCustomising(true)} data-look-customise-open>Customise</Button>
              {inline && <Button variant="quiet" disabled={saving} onClick={saveAsTheme} data-look-save-theme>Save as a theme</Button>}
            </div>
          ) : (
            <Customise base={base} appName={doc.app.name} onCancel={() => setCustomising(false)} onSave={(t) => { apply([{ op: "theme.set", theme: { inline: t } }]); setCustomising(false); toast({ kind: "success", title: "Look saved to the draft" }); }} />
          )}
        </section>
        <section className="flex flex-col gap-2">
          <h3 className="type-title-3">This page's theme</h3>
          <p className="type-caption text-fg-2">Leave it empty to use the app theme on {page.title}.</p>
          <ThemePicker value={page.theme} onChange={(ref: ThemeRef | undefined) => apply([{ op: "page.update", pageId: page.id, patch: { theme: (ref ?? null) as never } }])} />
        </section>
        <section className="flex flex-col gap-2">
          <h3 className="type-title-3">Navigation</h3>
          <ChoiceGroup<ChromeDef["layout"]> label="Navigation" hideLabel name="chrome-layout" value={layout} onChange={(l) => apply([{ op: "chrome.update", patch: { layout: l } }])} options={(["topbar", "sidebar", "tabs", "none"] as ChromeDef["layout"][]).map((l) => ({ value: l, label: l === "topbar" ? "Top bar" : l === "sidebar" ? "Sidebar" : l === "tabs" ? "Tabs" : "None", data: { "chrome-layout": l } }))} />
          <label className="flex flex-col gap-1 type-caption">Title
            <input className={field} value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title !== (doc.chrome.title ?? "") && apply([{ op: "chrome.update", patch: { title } }])} data-chrome-title />
          </label>
          <div className="flex flex-col gap-1 type-caption">Logo
            <UploadField value={doc.chrome.logo} accept="image" onChange={(path: string) => apply([{ op: "chrome.update", patch: { logo: path } }])} />
          </div>
        </section>
        {layout !== "none" && (
          <section className="flex flex-col gap-2">
            <h3 className="type-title-3">Navigation style</h3>
            <ChromeStyle chrome={doc.chrome} theme={base} apply={apply} />
          </section>
        )}
        <details className="border-t border-line pt-3" open={!!chromeRemoved?.length || undefined}>
          <summary className="cursor-pointer type-label">Advanced: navigation CSS</summary>
          <p className="mt-2 type-caption text-fg-2">Scoped to this app's frame. It can never style Atrium or reach outside the app.</p>
          <textarea className="mt-2 min-h-32 w-full border border-line-strong bg-[#1d1a15] p-2 font-mono text-[12px] text-[#f3efe4]" value={css} onChange={(e) => setCss(e.target.value)} spellCheck={false} data-chrome-css-input />
          {chromeRemoved && chromeRemoved.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1" aria-label="Removed by Atrium" data-chrome-removed>
              {chromeRemoved.map((r, i) => <li key={i} className="border-l-4 border-l-warn bg-bg-sunk px-2 py-1 font-mono text-[12px]">Removed: {r}</li>)}
            </ul>
          )}
          <Button variant="ink" className="mt-2" onClick={() => apply([{ op: "chrome.update", patch: { css } }])} data-chrome-css-save>Save CSS</Button>
        </details>
      </div>
    </Sheet>
  );
}
