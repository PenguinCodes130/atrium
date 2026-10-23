"use client";
// The folded theme editor (settings spec 3.3): basics first (name, mode, accent, wallpaper, preview);
// Surfaces, Colours, Type, Shape and space, Motion, Nav chrome and the Auto dark set stay folded until
// opened; Custom CSS and font upload sit under Advanced, folded. A folded group never hides a contrast
// warning: warnings show on the basics view with a link that opens the group. Every field accepts only
// the design v4 ranges and choices, refused at the field with the range named.
// Settings r2 (gauntlet w2-r1): the nav chrome follows the accent unless set apart (item 5); square
// segments, menus, sliders and checkboxes instead of native controls (item 6); 44px segments and a
// Save that stays in reach on phones (item 9); a sampled contrast warning over image wallpapers
// (item 11); gradients parsed into stops and an angle, never overwritten silently (item 12).
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Theme, ThemeTokens } from "@/core/contracts";
import { Button, Switch, THEME_FONTS, Window, contrastReport, isThemeColor, isThemeGradient, toast } from "@/features/shell";
import { NUMBER_FIELDS, numberFieldError } from "@/features/themes/fields";
import { ThemeSample } from "@/features/themes/ui/theme-sample";
import { refreshThemePicker } from "@/features/themes/ui/theme-picker";
import { UploadField } from "@/features/uploads/ui/upload-field";
import { api, errorText, type ApiError } from "./client-api";
import { Checkbox, ChoiceGroup, Fold, INPUT_CLASS, LABEL_CLASS, MONO_INPUT_CLASS, RangeField, SelectMenu } from "./controls";
import { useImageContrast } from "./image-contrast";
import { formatGradient, parseGradient } from "./gradient";
import { alphaOf, fromPicker, swatchHex } from "./colour";
import { UsedBy } from "./used-by";
import { UseOnApp } from "./use-on-app";

type Use = { appId: string; slug: string; name: string; draft: boolean; published: boolean };
export type EditorProps = { id: string; rev: number; theme: Theme; invalid: number; usedBy: Use[]; savedCss?: string };

type GroupKey = "surfaces" | "colours" | "type" | "shape" | "motion" | "chrome" | "dark" | "advanced";
const GROUP_OF_CONTRAST: Record<string, GroupKey> = { "color.surfaceText": "colours", "color.surfaceMuted": "colours", "color.canvasText": "colours", "color.accentText": "colours" };
const PAIR: Record<string, string> = {
  "color.surfaceText": "Surface text on the surface",
  "color.surfaceMuted": "Muted surface text on the surface",
  "color.canvasText": "Canvas text on the wallpaper",
  "color.accentText": "Accent text on the accent",
};

function setPath<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split(".");
  const root = structuredClone(obj) as Record<string, unknown>;
  let cur = root;
  for (const k of keys.slice(0, -1)) {
    cur[k] = { ...((cur[k] as Record<string, unknown>) ?? {}) };
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
  return root as T;
}
function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

export function ThemeEditor({ id, rev: initialRev, theme: initial, invalid, usedBy: initialUse, savedCss }: EditorProps) {
  const [theme, setTheme] = useState<Theme>(initial);
  const [rev, setRev] = useState(initialRev);
  const [usedBy, setUsedBy] = useState(initialUse);
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<Record<GroupKey, boolean>>({ surfaces: false, colours: false, type: false, shape: false, motion: false, chrome: false, dark: false, advanced: false });
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [offerUpdate, setOfferUpdate] = useState<Use[] | null>(null);
  const groupRefs = useRef<Partial<Record<GroupKey, HTMLElement | null>>>({});
  const contrast = useMemo(() => contrastReport(theme), [theme]);
  // Over an image the shell's report can only assume white and black; the sampled check replaces it.
  const shownWarnings = contrast.warnings.filter((w) => !(theme.tokens.wallpaper.kind === "image" && w.field === "color.canvasText"));
  const t = theme.tokens;
  const uploadedFamilies = (theme.fonts ?? []).map((f) => f.family);

  const set = (path: string, value: unknown) => setTheme((cur) => setPath(cur, path, value));
  // Item 5: the nav's active fill and text follow the accent and accent text while they match them
  // (Dusk and every copy of it); "Set apart" keeps them as they are.
  const [chromeApart, setChromeApart] = useState(() => !(same(initial.tokens.chrome.activeFill, initial.tokens.color.accent) && same(initial.tokens.chrome.activeText, initial.tokens.color.accentText)));
  const setAccent = (key: "accent" | "accentText", v: string) =>
    setTheme((cur) => {
      let next = setPath(cur, `tokens.color.${key}`, v);
      if (!chromeApart) next = setPath(next, key === "accent" ? "tokens.chrome.activeFill" : "tokens.chrome.activeText", v);
      return next;
    });
  const followAccent = (follow: boolean) => {
    setChromeApart(!follow);
    if (follow) setTheme((cur) => setPath(setPath(cur, "tokens.chrome.activeFill", cur.tokens.color.accent), "tokens.chrome.activeText", cur.tokens.color.accentText));
  };
  const imageContrast = useImageContrast(t.wallpaper, t.color.canvasText);
  const err = (path: string, msg: string | null) => setFieldErr((e) => { const n = { ...e }; if (msg) n[path] = msg; else delete n[path]; return n; });

  function openGroup(g: GroupKey) {
    setOpen((o) => ({ ...o, [g]: true }));
    requestAnimationFrame(() => groupRefs.current[g]?.scrollIntoView({ block: "start" }));
  }

  async function save() {
    if (Object.keys(fieldErr).length) {
      setSaveError({ message: "Fix the fields marked in red first.", extra: {}, status: 400 });
      return;
    }
    setBusy(true);
    setSaveError(null);
    try {
      const r = await api<{ rev: number; name: string; usedBy: Use[] }>(`/api/settings/themes/${id}`, { method: "PUT", body: { theme, rev } });
      setRev(r.rev);
      setUsedBy(r.usedBy);
      toast({ kind: "success", title: `Saved ${r.name}` });
      refreshThemePicker();
      const published = r.usedBy.filter((u) => u.published);
      setOfferUpdate(published.length ? published : null);
    } catch (x) {
      const e = x as ApiError;
      if (e.issues) setFieldErr(Object.fromEntries(e.issues.map((i) => [i.path.replace(/^tokens\./, ""), i.message])));
      setSaveError(e);
    } finally {
      setBusy(false);
    }
  }

  async function updateApps() {
    if (!offerUpdate) return;
    setBusy(true);
    try {
      const r = await api<{ updated: { name: string }[] }>(`/api/settings/themes/${id}/update-apps`, { body: { appIds: offerUpdate.map((u) => u.appId) } });
      toast({ kind: "success", title: `Updated ${r.updated.length} app draft${r.updated.length === 1 ? "" : "s"}`, description: "Publish each app to carry the theme to its live version." });
      setOfferUpdate(null);
    } catch (x) {
      toast({ kind: "error", title: errorText(x) });
    } finally {
      setBusy(false);
    }
  }

  const colour = (path: string, label: string, base: "tokens" | "root" = "tokens") => (
    <ColourField
      key={path}
      path={path}
      label={label}
      value={String(getPath(base === "tokens" ? t : theme, path) ?? "")}
      error={fieldErr[path]}
      onValid={(v) => (path === "color.accent" || path === "color.accentText" ? setAccent(path === "color.accent" ? "accent" : "accentText", v) : set(base === "tokens" ? `tokens.${path}` : path, v))}
      onError={(m) => err(path, m)}
    />
  );
  const num = (path: string) => <NumberField key={path} path={path} value={Number(getPath(t, path))} error={fieldErr[path]} onValid={(v) => set(`tokens.${path}`, v)} onError={(m) => err(path, m)} />;
  const choice = <T extends string | number>(path: string, label: string, options: readonly T[]) => (
    <ChoiceField key={path} label={label} value={getPath(t, path) as T} options={options} onChange={(v) => set(`tokens.${path}`, v)} name={path} />
  );
  const family = (path: string, label: string) => (
    <SelectMenu key={path} label={label} name={path} value={String(getPath(t, path))} onChange={(v) => set(`tokens.${path}`, v)} options={[...THEME_FONTS, ...uploadedFamilies].map((f) => ({ value: f, label: f }))} />
  );

  // Settings r3 (gauntlet w2-r2 item 7): the inspector's fold, a chevron on `pop` and the body on `sheet`.
  const group = (key: GroupKey, title: string, children: ReactNode) => (
    <Fold name={key} title={title} open={open[key]} onToggle={(isOpen) => setOpen((o) => ({ ...o, [key]: isOpen }))} foldRef={(el) => { groupRefs.current[key] = el; }} bodyClassName="grid gap-4 border-t border-line p-4 sm:grid-cols-2">
      {children}
    </Fold>
  );

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]" data-theme-editor>
      <div className="flex min-w-0 flex-col gap-6">
        {invalid > 0 && (
          <p role="status" className="border border-line-strong bg-bg-hi p-3 type-body text-fg" data-invalid-note>
            <span aria-hidden className="mr-1 text-warning">▲</span>{invalid} values were invalid and were replaced
          </p>
        )}
        <Window title={`themes / ${theme.name} / basics`} data-basics>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 sm:col-span-2">
              <span className={LABEL_CLASS}>Name</span>
              <input value={theme.name} maxLength={80} onChange={(e) => { set("name", e.target.value); err("name", e.target.value.trim() ? null : "Give the theme a name."); }} className={INPUT_CLASS} data-field="name" aria-invalid={!!fieldErr.name} />
              {fieldErr.name && <span role="alert" className="type-caption text-bad">{fieldErr.name}</span>}
            </label>
            <ChoiceField label="Mode" name="mode" value={theme.mode} options={["light", "dark", "auto"] as const} labels={{ light: "Light", dark: "Dark", auto: "Auto" }} onChange={(v) => set("mode", v)} />
            {colour("color.accent", "Accent")}
            <WallpaperFields w={t.wallpaper} onChange={(w) => set("tokens.wallpaper", w)} error={fieldErr["wallpaper.value"]} onError={(m) => err("wallpaper.value", m)} />
            {!chromeApart && <p className="type-caption text-fg-2 sm:col-span-2" data-chrome-follows>The nav's active item follows the accent. Set it apart under Nav chrome.</p>}
          </div>
          {(shownWarnings.length > 0 || imageContrast.low) && (
            <ul className="mt-5 flex flex-col gap-2 border-t border-line pt-4" data-contrast-warnings aria-label="Contrast warnings">
              {imageContrast.low && imageContrast.ratio !== null && (
                <li className="flex flex-wrap items-center gap-x-2 type-body text-fg" data-contrast-warning="wallpaper-image">
                  <span aria-hidden className="text-warning">▲</span>
                  <span>Canvas text over the wallpaper image: {imageContrast.ratio.toFixed(2)}:1 where the image is busiest, below 4.5:1.</span>
                  {imageContrast.suggest && (
                    <button type="button" className="min-h-11 cursor-pointer underline type-body text-fg" onClick={() => set("tokens.color.canvasText", imageContrast.suggest)} data-use-suggested>
                      Use {imageContrast.suggest} ({imageContrast.suggestRatio!.toFixed(1)}:1)
                    </button>
                  )}
                  {!imageContrast.suggest && <span className="type-body text-fg-2" data-contrast-advice>Raise the wallpaper dim, or pick a calmer image.</span>}
                </li>
              )}
              {shownWarnings.map((w) => (
                <li key={`${w.field}-${w.scheme}`} className="flex flex-wrap items-center gap-x-2 type-body text-fg" data-contrast-warning={w.field}>
                  <span aria-hidden className="text-warning">▲</span>
                  <span>{PAIR[w.field]}: {w.ratio.toFixed(2)}:1{theme.mode === "auto" ? ` (${w.scheme})` : ""}, below 4.5:1.</span>
                  <button type="button" className="min-h-11 cursor-pointer underline type-body text-fg" onClick={() => openGroup(GROUP_OF_CONTRAST[w.field] ?? "colours")} data-open-group>Open Colours</button>
                </li>
              ))}
            </ul>
          )}
        </Window>

        <div className="flex flex-col gap-3" data-more>
          <h2 className={LABEL_CLASS}>More</h2>
          {group("surfaces", "Surfaces", <>
            {choice("surface.material", "Material", ["solid", "glass"] as const)}
            {num("surface.opacity")}
            {num("surface.blurPx")}
            {choice("surface.border.widthPx", "Border width (px)", [0, 1, 2] as const)}
            {colour("surface.border.color", "Border colour")}
            {choice("surface.shadow", "Shadow", ["none", "soft", "hard"] as const)}
            {num("surface.shadowOffsetPx")}
            <Switch label="Window title bars on cards" checked={t.surface.titleBars} onCheckedChange={(v) => set("tokens.surface.titleBars", v)} />
          </>)}
          {group("colours", "Colours", <>
            {colour("color.surface", "Surface")}
            {colour("color.surfaceText", "Surface text")}
            {colour("color.surfaceMuted", "Muted surface text")}
            {colour("color.canvasText", "Canvas text")}
            {colour("color.accentText", "Text on accent")}
            {colour("color.ok", "OK")}
            {colour("color.warn", "Warning")}
            {colour("color.bad", "Bad")}
            {colour("color.info", "Info")}
            {colour("color.line", "Lines")}
          </>)}
          {group("type", "Type", <>
            {family("type.display", "Display font")}
            {family("type.body", "Body font")}
            {family("type.mono", "Mono font")}
            {num("type.scale")}
            {choice("type.numbers", "Numbers", ["tabular", "proportional"] as const)}
            {num("type.headingTracking")}
            {choice("type.headingWeight", "Heading weight", [400, 500, 600, 700, 800] as const)}
          </>)}
          {group("shape", "Shape and space", <>
            {num("shape.radiusPx")}
            {num("shape.controlRadiusPx")}
            {num("space.gapPx")}
            {num("space.padPx")}
            {choice("space.density", "Density", ["comfortable", "compact"] as const)}
          </>)}
          {group("motion", "Motion", <>
            {choice("motion.enter", "Entrance", ["none", "fade", "rise", "sweep"] as const)}
            <Switch label="Light drift" checked={t.motion.lightDrift} onCheckedChange={(v) => set("tokens.motion.lightDrift", v)} />
          </>)}
          {group("chrome", "Nav chrome", <>
            {colour("chrome.background", "Background")}
            {colour("chrome.text", "Text")}
            <div className="sm:col-span-2" data-chrome-follow>
              <Checkbox checked={!chromeApart} onCheckedChange={followAccent} label="Active item follows the accent" description="The active nav item uses the accent and the text on accent. Clear this to set its own colours." data-follows-accent />
            </div>
            {chromeApart ? (
              <>
                {colour("chrome.activeFill", "Active fill")}
                {colour("chrome.activeText", "Active text")}
              </>
            ) : (
              <p className="type-caption text-fg-2 sm:col-span-2" data-chrome-following>Active fill <span className="font-mono text-fg">{t.chrome.activeFill}</span> and text <span className="font-mono text-fg">{t.chrome.activeText}</span>, following the accent.</p>
            )}
            {choice("chrome.style", "Item style", ["bar", "boxed-tabs", "pills", "underline"] as const)}
          </>)}
          {group("dark", "Auto dark set", <>
            <p className="type-caption text-fg-2 sm:col-span-2">Used when the mode is Auto and the viewer prefers dark.</p>
            {(["surface", "surfaceText", "surfaceMuted", "canvasText", "accent", "accentText"] as const).map((k) => (
              <ColourField key={k} path={`dark.color.${k}`} label={`Dark ${k}`} value={String(theme.dark?.color?.[k] ?? "")} error={fieldErr[`dark.color.${k}`]} onValid={(v) => set("dark", { ...(theme.dark ?? {}), color: { ...((theme.dark?.color ?? t.color) as ThemeTokens["color"]), [k]: v } })} onError={(m) => err(`dark.color.${k}`, m)} />
            ))}
          </>)}
          <h2 className={`mt-3 ${LABEL_CLASS}`}>Advanced</h2>
          {group("advanced", "Custom CSS and fonts", <>
            <label className="flex flex-col gap-1.5 sm:col-span-2">
              <span className={LABEL_CLASS}>Custom CSS (scoped to the app canvas; at most 64 KB)</span>
              <textarea value={theme.customCss ?? ""} onChange={(e) => { set("customCss", e.target.value || undefined); err("customCss", e.target.value.length > 65536 ? "Custom CSS is limited to 64 KB." : null); }} rows={8} spellCheck={false} className="border border-line-strong bg-fg p-2 font-mono text-[13px] text-bg" data-field="customCss" />
              <span className="type-caption text-fg-2">It can never style the Atrium shell, dialogs or toasts. The preview shows the saved CSS.</span>
              {fieldErr.customCss && <span role="alert" className="type-caption text-bad">{fieldErr.customCss}</span>}
            </label>
            <FontsField fonts={theme.fonts ?? []} onChange={(f) => set("fonts", f.length ? f : undefined)} />
          </>)}
        </div>
      </div>

      {/* Settings r3 (gauntlet w2-r2 item 6): below lg this column is `display: contents`, so the actions
          bar is a child of the whole editor grid and sticks to the bottom of the page above the tab bar
          at any scroll position (in round 2 it could only stick inside the short preview column). */}
      <div className="min-w-0 max-lg:contents lg:sticky lg:top-20 lg:flex lg:flex-col lg:gap-4 lg:self-start" data-editor-side>
        <Window title="preview" status={<span>live</span>} data-preview>
          <ThemeSample theme={theme} scopedCss={savedCss} scope={`s${id.replace(/[^a-z0-9]/g, "")}`} height={300} />
          <UsedBy usedBy={usedBy} />
          <UseOnApp themeId={id} themeName={theme.name} className="mt-3" note="It uses the saved theme, so save first to include your changes." onUsed={(d) => setUsedBy((u) => (u.some((x) => x.appId === d.appId) ? u : [...u, { appId: d.appId, slug: d.slug, name: d.name, draft: true, published: false }]))} />
        </Window>
        <div className="z-20 flex flex-col gap-2 max-lg:sticky max-lg:bottom-[calc(var(--tabbar-height)+env(safe-area-inset-bottom,0px))] max-lg:-mx-4 max-lg:border-y max-lg:border-line-strong max-lg:bg-bg max-lg:px-4 max-lg:py-2" data-editor-actions>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={busy} onClick={save} data-save-theme>{busy ? "Saving" : "Save theme"}</Button>
            <Button variant="quiet" href="/settings/themes">Back to themes</Button>
          </div>
          {saveError && (
            <div role="alert" className="border border-line-strong bg-bg-hi p-3 type-body text-fg" data-save-error>
              <p>{saveError.message}</p>
              {saveError.code === "stale" && <Button variant="secondary" className="mt-2" onClick={() => window.location.reload()} data-reload>Reload the theme</Button>}
            </div>
          )}
        </div>
        {offerUpdate && (
          <Window title="themes / update apps" data-update-apps>
            <p className="type-body text-fg">Published apps keep the copy of this theme they were published with. Update their drafts so the next publish carries your changes?</p>
            <ul className="mt-2 list-disc pl-5 type-body text-fg">{offerUpdate.map((u) => <li key={u.appId}>{u.name}</li>)}</ul>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="ink" disabled={busy} onClick={updateApps} data-confirm-update-apps>Update apps using this theme</Button>
              <Button variant="quiet" onClick={() => setOfferUpdate(null)}>Not now</Button>
            </div>
          </Window>
        )}
      </div>
    </div>
  );
}

// Settings r3 (gauntlet w2-r2 item 3): the swatch paints the real colour (oklch included), on a
// checkerboard when it has alpha. The native picker sits invisibly over the swatch, opens on the sRGB
// equivalent and writes back in the author's format (colour.ts).
const CHECKER = "repeating-conic-gradient(var(--fg-3) 0 25%, var(--bg-hi) 0 50%) 0 0 / 8px 8px";

function ColourField({ path, label, value, error, onValid, onError }: { path: string; label: string; value: string; error?: string; onValid(v: string): void; onError(m: string | null): void }) {
  const [text, setText] = useState(value);
  // A value changed elsewhere (a suggested canvas text, the accent the chrome follows) shows here too.
  useEffect(() => {
    setText((cur) => (isThemeColor(cur) && cur.trim().toLowerCase() !== value.trim().toLowerCase() ? value : cur));
  }, [value]);
  const valid = isThemeColor(text);
  const shown = valid ? text.trim() : isThemeColor(value) ? value.trim() : "";
  const hex = shown ? swatchHex(shown) : null;
  const translucent = shown ? alphaOf(shown) < 1 : false;
  const apply = (v: string) => {
    setText(v);
    if (isThemeColor(v)) {
      onError(null);
      onValid(v.trim());
    } else onError(`${label}: use an oklch() or #hex colour.`);
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={`colour-${path}`} className={LABEL_CLASS}>{label}</label>
      <span className="flex items-center gap-2">
        <span className="relative h-9 w-11 flex-none border border-line-strong bg-bg-hi p-0.5 focus-within:ring-2 focus-within:ring-[color:var(--ink)] touch:h-11 dark:focus-within:ring-fg" data-swatch={path} data-swatch-hex={hex ?? ""} data-swatch-alpha={translucent ? "1" : "0"}>
          <span aria-hidden className="block size-full" style={translucent ? { background: CHECKER } : undefined}>
            <span className="block size-full" style={{ background: shown || "transparent" }} data-swatch-fill />
          </span>
          <input type="color" value={hex ?? "#000000"} onChange={(e) => apply(fromPicker(e.target.value, shown || text))} aria-label={`${label} picker`} className="absolute inset-0 size-full cursor-pointer opacity-0" data-picker={path} />
        </span>
        <input id={`colour-${path}`} value={text} onChange={(e) => apply(e.target.value)} className={`${MONO_INPUT_CLASS} flex-1`} data-field={path} aria-invalid={!!error} spellCheck={false} />
      </span>
      {error && <span role="alert" className="type-caption text-bad" data-field-error={path}>{error}</span>}
    </div>
  );
}

function NumberField({ path, value, error, onValid, onError }: { path: string; value: number; error?: string; onValid(v: number): void; onError(m: string | null): void }) {
  const f = NUMBER_FIELDS[path]!;
  const [text, setText] = useState(String(value));
  const type = (raw: string) => {
    setText(raw);
    const n = Number(raw);
    const m = raw.trim() === "" ? `${f.label} must be between ${f.min} and ${f.max}.` : numberFieldError(path, n);
    onError(m);
    if (!m) onValid(n);
  };
  return (
    <RangeField
      label={f.label}
      name={path}
      min={f.min}
      max={f.max}
      step={f.step}
      value={Number(text)}
      text={text}
      error={error}
      onType={type}
      onSlide={(v) => type(String(+v.toFixed(4)))}
    />
  );
}

function ChoiceField<T extends string | number>({ label, name, value, options, labels, onChange }: { label: string; name: string; value: T; options: readonly T[]; labels?: Partial<Record<string, string>>; onChange(v: T): void }) {
  return <ChoiceGroup<T> label={label} name={name} value={value} onChange={onChange} options={options.map((o) => ({ value: o, label: labels?.[String(o)] ?? String(o) }))} />;
}

function WallpaperFields({ w, onChange, error, onError }: { w: ThemeTokens["wallpaper"]; onChange(w: ThemeTokens["wallpaper"]): void; error?: string; onError(m: string | null): void }) {
  const fallback: [string, string] = ["#F3EFE4", "#A9C8E4"];
  const parsed = w.kind === "gradient" ? parseGradient(w.value) : null;
  const two: [string, string] = parsed?.stops ?? w.colors ?? fallback;
  const [customText, setCustomText] = useState(w.kind === "gradient" && !parsed ? w.value : "");
  const setKind = (kind: ThemeTokens["wallpaper"]["kind"]) => {
    onError(null);
    if (kind === "none") onChange({ ...w, kind, value: "" });
    else if (kind === "color") onChange({ ...w, kind, value: isThemeColor(w.value) ? w.value : "#F3EFE4" });
    else if (kind === "gradient") {
      // A stored gradient is kept as it is (item 12); a new one starts from two colours, top to bottom.
      const keep = isThemeGradient(w.value) ? w.value : formatGradient({ angle: 180, stops: two });
      const p = parseGradient(keep);
      onChange({ ...w, kind, value: keep, ...(p ? { colors: p.stops } : {}) });
      setCustomText(p ? "" : keep);
    } else if (kind === "sky") onChange({ ...w, kind, value: "", colors: two });
    else onChange({ ...w, kind, value: w.value.startsWith("/uploads/") ? w.value : "" });
  };
  const setGradient = (g: { angle?: number; stop?: [0 | 1, string] }) => {
    const base = parsed ?? { angle: 180, stops: two };
    const stops: [string, string] = [...base.stops] as [string, string];
    if (g.stop) stops[g.stop[0]] = g.stop[1];
    const next = { angle: g.angle ?? base.angle, stops };
    onChange({ ...w, value: formatGradient(next), colors: stops });
  };
  const setTwo = (i: 0 | 1, v: string) => {
    if (w.kind === "gradient") return setGradient({ stop: [i, v] });
    const c: [string, string] = [...two] as [string, string];
    c[i] = v;
    onChange({ ...w, colors: c });
  };
  return (
    <div className="flex flex-col gap-3 sm:col-span-2" data-wallpaper>
      <ChoiceField label="Wallpaper" name="wallpaper.kind" value={w.kind} options={["none", "color", "gradient", "image", "sky"] as const} labels={{ none: "None", color: "Colour", gradient: "Gradient", image: "Image", sky: "Sky" }} onChange={setKind} />
      <div className="grid gap-4 sm:grid-cols-2">
        {w.kind === "color" && <ColourField path="wallpaper.value" label="Wallpaper colour" value={w.value} error={error} onValid={(v) => onChange({ ...w, value: v })} onError={onError} />}
        {(w.kind === "sky" || (w.kind === "gradient" && parsed)) && (
          <>
            <ColourField path="wallpaper.colors.0" label="From" value={two[0]} onValid={(v) => setTwo(0, v)} onError={onError} />
            <ColourField path="wallpaper.colors.1" label="To" value={two[1]} onValid={(v) => setTwo(1, v)} onError={onError} />
          </>
        )}
        {w.kind === "gradient" && parsed && (
          <div className="sm:col-span-2" data-gradient-angle>
            <RangeField label="Angle (deg)" name="wallpaper.angle" min={0} max={359} step={5} value={parsed.angle} text={String(parsed.angle)} onSlide={(v) => setGradient({ angle: Math.round(v) })} onType={(raw) => { const n = Number(raw); if (raw.trim() !== "" && Number.isFinite(n) && n >= 0 && n < 360) setGradient({ angle: Math.round(n) }); }} />
          </div>
        )}
        {w.kind === "gradient" && !parsed && (
          <div className="flex flex-col gap-2 sm:col-span-2" data-custom-gradient>
            <label className="flex flex-col gap-1.5">
              <span className={LABEL_CLASS}>Custom gradient (edit as text)</span>
              <textarea
                value={customText || w.value}
                rows={3}
                spellCheck={false}
                onChange={(e) => {
                  setCustomText(e.target.value);
                  if (isThemeGradient(e.target.value)) {
                    onError(null);
                    const p = parseGradient(e.target.value);
                    onChange({ ...w, value: e.target.value.trim(), ...(p ? { colors: p.stops } : {}) });
                  } else onError("Wallpaper: use a linear-, radial- or conic-gradient() with oklch() or #hex colours.");
                }}
                className="border border-line-strong bg-bg-hi p-2 font-mono text-[13px] text-fg"
                data-field="wallpaper.value"
                aria-invalid={!!error}
              />
            </label>
            <p className="type-caption text-fg-2">This gradient has more than two stops or another shape, so the colour pickers would change it. It is kept exactly as written.</p>
            {error && <span role="alert" className="type-caption text-bad" data-field-error="wallpaper.value">{error}</span>}
            <div>
              <Button variant="secondary" onClick={() => { const g = { angle: 180, stops: two }; onError(null); setCustomText(""); onChange({ ...w, value: formatGradient(g), colors: g.stops }); }} data-replace-gradient>
                Replace with a two-colour gradient
              </Button>
            </div>
          </div>
        )}
        {w.kind === "image" && (
          <div className="sm:col-span-2">
            <UploadField accept="image" value={w.value || undefined} onChange={(p) => onChange({ ...w, value: p })} label="Wallpaper image (uploaded to this Atrium)" />
            {!w.value && <span className="type-caption text-fg-2">Upload an image to use it.</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function FontsField({ fonts, onChange }: { fonts: NonNullable<Theme["fonts"]>; onChange(f: NonNullable<Theme["fonts"]>): void }) {
  const [family, setFamily] = useState("");
  const [weight, setWeight] = useState("400");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-3 sm:col-span-2" data-fonts>
      <span className={LABEL_CLASS}>Uploaded fonts (woff2, at most 2 MB each)</span>
      {fonts.length > 0 && (
        <ul className="flex flex-col gap-1">
          {fonts.map((f, i) => (
            <li key={`${f.family}${i}`} className="flex flex-wrap items-center gap-2 type-body text-fg">
              <span>{f.family} {f.weight} {f.style}</span>
              <Button variant="quiet" onClick={() => onChange(fonts.filter((_, j) => j !== i))}>Remove</Button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className={LABEL_CLASS}>Family name</span>
          <input value={family} onChange={(e) => setFamily(e.target.value)} maxLength={48} className={INPUT_CLASS} data-field="font-family" />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={LABEL_CLASS}>Weight</span>
          <input value={weight} onChange={(e) => setWeight(e.target.value)} className={MONO_INPUT_CLASS} />
        </label>
      </div>
      <UploadField
        accept="font"
        onChange={(path) => {
          if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,47}$/.test(family) || THEME_FONTS.includes(family as never)) return setError("Give the font a family name (letters, digits, spaces), not one of the built-in names.");
          if (!/^[1-9]00(?: [1-9]00)?$/.test(weight)) return setError("Use a weight such as 400, or a range such as 100 900.");
          setError(null);
          onChange([...fonts, { family, file: path, weight, style: "normal" }]);
        }}
      />
      {error && <span role="alert" className="type-caption text-bad">{error}</span>}
    </div>
  );
}

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
