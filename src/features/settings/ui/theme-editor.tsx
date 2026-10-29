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
// Wave 2.10a (operator try-out): B3 the control radius runs 0 to 24 px in steps of 2, then Pill; B6 the
// preview shows Light, Dark or Side by side with the real dark set, a theme with no dark set says so and
// offers "Make a dark set", and an auto theme's dark set is edited with the same fields as the light set
// (Editing: Light set / Dark set). B4 and B5 show in the preview because it draws the app's own nav and
// full-size controls (themes/ui/theme-sample.tsx).
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Theme, ThemeTokens } from "@/core/contracts";
import { Button, Switch, THEME_FONTS, Window, contrastReport, isThemeColor, isThemeGradient, toast } from "@/features/shell";
import { NUMBER_FIELDS, numberFieldError } from "@/features/themes/fields";
import { makeDarkSet } from "@/features/themes/dark-set";
import { CONTROL_RADIUS_MAX_BY_DENSITY, DENSITY_K, PILL_RADIUS, controlRadiusOf, resolveTokens, type Density } from "@/features/shell/theme";
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
export type EditorProps = { id: string; rev: number; theme: Theme; invalid: number; usedBy: Use[]; savedCss?: string; /** r2 low L8: an unsaved new theme, stored on the first Save. */ isNew?: boolean };

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
/**
 * Write a token path. While the dark set is being edited, `tokens.<group>...` goes to `dark.<group>...`,
 * starting from the whole group as dark viewers see it now, so the saved dark group is always complete.
 */
function writeToken(cur: Theme, path: string, value: unknown, editing: Scheme): Theme {
  if (editing !== "dark" || !path.startsWith("tokens.") || cur.mode !== "auto" || !cur.dark) return setPath(cur, path, value);
  const group = path.split(".")[1] as keyof ThemeTokens;
  const full = resolveTokens(cur, "dark");
  const next: Theme = { ...cur, dark: { ...cur.dark, [group]: structuredClone(full[group]) } };
  return setPath(next, `dark.${path.slice("tokens.".length)}`, value);
}
type Scheme = "light" | "dark";
type PreviewMode = "light" | "dark" | "both";
function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

export function ThemeEditor({ id, rev: initialRev, theme: initial, invalid, usedBy: initialUse, savedCss, isNew = false }: EditorProps) {
  const router = useRouter();
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
  const hasDark = theme.mode === "auto" && !!theme.dark;
  const [editingRaw, setEditing] = useState<Scheme>("light");
  const editing: Scheme = hasDark ? editingRaw : "light";
  const [previewMode, setPreviewMode] = useState<PreviewMode>("light");
  // r2 item 3: on a phone the preview docks above the Save bar, one tap away, while the fields scroll.
  const [docked, setDocked] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const editingRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bar = actionsRef.current, root = rootRef.current;
    if (!bar || !root || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => root.style.setProperty("--editor-actions-h", `${Math.ceil(bar.getBoundingClientRect().height)}px`));
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);
  // Over an image the shell's report can only assume white and black; the sampled check replaces it.
  const shownWarnings = contrast.warnings.filter((w) => !(theme.tokens.wallpaper.kind === "image" && w.field === "color.canvasText"));
  // The token set the fields show and write: the light set, or the dark set as dark viewers see it.
  const t = editing === "dark" ? resolveTokens(theme, "dark") : theme.tokens;
  const uploadedFamilies = (theme.fonts ?? []).map((f) => f.family);

  const set = (path: string, value: unknown) => setTheme((cur) => writeToken(cur, path, value, editing));
  // r2 item 5 (design Note 3): a radius above the new density's last stop becomes Pill, as it draws.
  const setDensity = (d: Density) =>
    setTheme((cur) => {
      let next = writeToken(cur, "tokens.space.density", d, editing);
      const r = (editing === "dark" ? resolveTokens(next, "dark") : next.tokens).shape.controlRadiusPx;
      if (r !== PILL_RADIUS && controlRadiusOf(r, d) === PILL_RADIUS) next = writeToken(next, "tokens.shape.controlRadiusPx", PILL_RADIUS, editing);
      return next;
    });
  // Item 5: the nav's active fill and text follow the accent and accent text while they match them
  // (Dusk and every copy of it); "Set apart" keeps them as they are.
  const [chromeApart, setChromeApart] = useState(() => !(same(initial.tokens.chrome.activeFill, initial.tokens.color.accent) && same(initial.tokens.chrome.activeText, initial.tokens.color.accentText)));
  const setAccent = (key: "accent" | "accentText", v: string) =>
    setTheme((cur) => {
      let next = writeToken(cur, `tokens.color.${key}`, v, editing);
      if (!chromeApart) next = writeToken(next, key === "accent" ? "tokens.chrome.activeFill" : "tokens.chrome.activeText", v, editing);
      return next;
    });
  const followAccent = (follow: boolean) => {
    setChromeApart(!follow);
    if (follow)
      setTheme((cur) => {
        const c = editing === "dark" ? resolveTokens(cur, "dark").color : cur.tokens.color;
        return writeToken(writeToken(cur, "tokens.chrome.activeFill", c.accent, editing), "tokens.chrome.activeText", c.accentText, editing);
      });
  };
  // B6: a full dark set filled from the light set (darker surfaces, dimmer wallpaper, same accent),
  // checked for contrast; the theme becomes Auto so dark viewers get it, and the editor switches to it.
  const makeDark = () => {
    const wasMode = theme.mode;
    setTheme((cur) => ({ ...cur, mode: "auto", dark: makeDarkSet(cur.tokens) }));
    setEditing("dark");
    setPreviewMode("both");
    toast({ kind: "success", title: "Dark set made from the light set", description: `You are now editing the Dark set: the Editing switch at the top goes back to the Light set. ${wasMode === "auto" ? "" : "Mode is now Auto, so dark viewers get it. "}Adjust it, then save.` });
    // r2 low L6: bring the Editing switch it moved to into view, and mark it for a moment.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = editingRef.current;
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      el.setAttribute("data-just-switched", "");
      window.setTimeout(() => el.removeAttribute("data-just-switched"), 2400);
    }));
  };
  const removeDark = () => {
    setTheme((cur) => {
      const { dark: _d, ...rest } = cur;
      void _d;
      return rest;
    });
    setEditing("light");
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
      if (isNew) {
        const c = await api<{ id: string; name: string }>("/api/settings/themes", { body: { theme } });
        toast({ kind: "success", title: `Saved ${c.name}` });
        refreshThemePicker();
        router.replace(`/settings/themes/${c.id}`);
        return;
      }
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

  // r2 item 8 (design Note 3): published apps keep their snapshot. An app whose draft no longer points
  // at this theme (it holds a copy) can have its draft pointed back, so its next publish carries it.
  async function updateApps() {
    const stale = (offerUpdate ?? []).filter((u) => !u.draft);
    if (!stale.length) return;
    setBusy(true);
    try {
      const r = await api<{ updated: { name: string }[] }>(`/api/settings/themes/${id}/update-apps`, { body: { appIds: stale.map((u) => u.appId) } });
      toast({ kind: "success", title: `Updated ${r.updated.length} app draft${r.updated.length === 1 ? "" : "s"}`, description: "Publish each app to carry the theme to its live version." });
      setOfferUpdate((cur) => (cur ? cur.map((u) => ({ ...u, draft: true })) : cur));
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
    <div ref={rootRef} className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]" data-theme-editor data-preview-docked={docked ? "true" : "false"}>
      <div className="flex min-w-0 flex-col gap-6">
        {invalid > 0 && (
          <p role="status" className="border border-line-strong bg-bg-hi p-3 type-body text-fg" data-invalid-note>
            <span aria-hidden className="mr-1 text-warning">▲</span>{invalid} values were invalid and were replaced
          </p>
        )}
        <Window title={`themes / ${theme.name} / basics`} data-basics>
          {hasDark && (
            <div ref={editingRef} className="mb-4 flex scroll-mt-24 flex-col gap-1.5 border-b border-line pb-4 outline-offset-4 data-[just-switched]:outline-2 data-[just-switched]:outline-[color:var(--accent)] data-[just-switched]:outline" data-editing-scheme={editing}>
              <ChoiceField label="Editing" name="editing.scheme" value={editing} options={["light", "dark"] as const} labels={{ light: "Light set", dark: "Dark set" }} onChange={(v) => { setEditing(v); setPreviewMode(v); }} />
              <p className="type-caption text-fg-2">{editing === "dark" ? "Every field below changes the set dark viewers see. Name and mode belong to the whole theme." : "Every field below changes the set light viewers see."}</p>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2" key={`basics-${editing}`}>
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
                  <span>{PAIR[w.field]}: {w.ratio.toFixed(2)}:1{theme.mode === "auto" ? ` (${w.scheme})` : ""}, below 4.5:1.{assumesWorstCase(theme, w) ? " Measured with the glass over black and over white, the worst case, because the wallpaper image shows through it. Over this image it may read better." : ""}</span>
                  <button type="button" className="min-h-11 cursor-pointer underline type-body text-fg" onClick={() => openGroup(GROUP_OF_CONTRAST[w.field] ?? "colours")} data-open-group>Open Colours</button>
                </li>
              ))}
            </ul>
          )}
        </Window>

        <div className="flex flex-col gap-3" data-more key={`more-${editing}`}>
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
            <ControlRadiusField key={`shape.controlRadiusPx-${t.space.density}`} density={t.space.density} value={t.shape.controlRadiusPx} error={fieldErr["shape.controlRadiusPx"]} onValid={(v) => set("tokens.shape.controlRadiusPx", v)} onError={(m) => err("shape.controlRadiusPx", m)} />
            <NumberField key="space.gapPx" path="space.gapPx" value={t.space.gapPx} error={fieldErr["space.gapPx"]} onValid={(v) => set("tokens.space.gapPx", v)} onError={(m) => err("space.gapPx", m)} inForce={inForce("gap", t)} />
            <NumberField key="space.padPx" path="space.padPx" value={t.space.padPx} error={fieldErr["space.padPx"]} onValid={(v) => set("tokens.space.padPx", v)} onError={(m) => err("space.padPx", m)} inForce={inForce("pad", t)} />
            <ChoiceField key="space.density" label="Density" name="space.density" value={t.space.density} options={["comfortable", "compact"] as const} labels={{ comfortable: "Comfortable", compact: "Compact" }} onChange={(v) => setDensity(v)} />
            <p className="type-caption text-fg-2 sm:col-span-2" data-density-hint>Compact tightens card padding, gaps, title bars, nav items and service tiles to two thirds and makes buttons 32 px tall. Touch screens keep 44 px controls. Boxes sized at Comfortable keep their height until you use Fit in the builder.</p>
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
            <ChoiceField key="chrome.style" label="Item style" name="chrome.style" value={t.chrome.style} options={["bar", "boxed-tabs", "pills", "underline"] as const} labels={{ bar: "Bar", "boxed-tabs": "Boxed tabs", pills: "Pills", underline: "Underline" }} onChange={(v) => set("tokens.chrome.style", v)} />
          </>)}
          {group("dark", "Dark set", <>
            {hasDark ? (
              <>
                <p className="type-body text-fg sm:col-span-2" data-dark-state="set">Dark viewers get this theme's dark set. Pick Editing: Dark set at the top to change any of its fields.</p>
                <div className="flex flex-wrap gap-2 sm:col-span-2">
                  <Button variant="secondary" onClick={() => { setEditing("dark"); setPreviewMode("dark"); groupRefs.current.dark?.closest("[data-theme-editor]")?.scrollIntoView({ block: "start" }); }} data-edit-dark>Edit the dark set</Button>
                  <Button variant="quiet" onClick={makeDark} data-remake-dark>Make it again from the light set</Button>
                  <Button variant="quiet" onClick={removeDark} data-remove-dark>Remove the dark set</Button>
                </div>
              </>
            ) : (
              <>
                <p className="type-body text-fg sm:col-span-2" data-dark-state="none">{theme.mode === "dark" ? "Mode is Dark, so every viewer sees this dark theme." : "Dark viewers see the light theme. Make a dark set to give them their own colours, then adjust it."}</p>
                {theme.mode !== "dark" && <div className="sm:col-span-2"><Button variant="secondary" onClick={makeDark}>Make a dark set</Button></div>}
              </>
            )}
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
        {/* r2 item 3: the sample grows to its content (nothing is cut off). Side by side stacks the two
            samples unless the column is wide enough for both at a width where the nav stays on one line.
            On a phone "Show preview" docks this window above the Save bar, so a tap on any field shows
            its effect without scrolling; it scrolls inside itself if the sample is taller than half
            the screen. */}
        <Window
          title="preview"
          status={<span>live</span>}
          data-preview
          data-docked={docked ? "true" : "false"}
          className={docked ? "max-lg:sticky max-lg:bottom-[calc(var(--tabbar-height)+env(safe-area-inset-bottom,0px)+var(--editor-actions-h,64px))] max-lg:z-20 max-lg:-mx-4 max-lg:max-h-[62dvh] max-lg:overflow-y-auto max-lg:shadow-[var(--shadow-overlay)]" : undefined}
        >
          <ChoiceField<PreviewMode> label="Preview" name="preview.scheme" value={previewMode} options={["light", "dark", "both"] as const} labels={{ light: "Light", dark: "Dark", both: "Side by side" }} onChange={setPreviewMode} />
          {previewMode === "both" ? (
            <div className="@container mt-3">
              <div className="grid grid-cols-1 gap-3 @min-[760px]:grid-cols-2" data-preview-both>
                {(["light", "dark"] as const).map((sc) => (
                  <figure key={sc} className="m-0 flex min-w-0 flex-col gap-1.5">
                    <figcaption className={LABEL_CLASS}>{sc === "light" ? "Light viewers" : "Dark viewers"}</figcaption>
                    <ThemeSample theme={theme} scheme={sc} scopedCss={savedCss} scope={`s${id.replace(/[^a-z0-9]/g, "")}`} />
                  </figure>
                ))}
              </div>
            </div>
          ) : (
            <div className="mt-3">
              <ThemeSample theme={theme} scheme={previewMode} scopedCss={savedCss} scope={`s${id.replace(/[^a-z0-9]/g, "")}`} />
            </div>
          )}
          {!hasDark && theme.mode !== "dark" && (
            <div className={`mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border border-line-strong bg-bg-hi p-3 ${docked ? "max-lg:hidden" : ""}`} data-no-dark-set>
              <p className="type-body text-fg">Dark viewers see the light theme.</p>
              <Button variant="secondary" onClick={makeDark} data-make-dark>Make a dark set</Button>
            </div>
          )}
          {theme.mode === "dark" && <p className="mt-3 type-caption text-fg-2" data-mode-dark-note>Mode is Dark, so light and dark viewers both see this.</p>}
        </Window>
        {!isNew && <Window title="themes / apps" data-theme-apps>
          <UsedBy usedBy={usedBy} />
          <UseOnApp themeId={id} themeName={theme.name} className="mt-3" note="It uses the saved theme, so save first to include your changes." onUsed={(d) => setUsedBy((u) => (u.some((x) => x.appId === d.appId) ? u : [...u, { appId: d.appId, slug: d.slug, name: d.name, draft: true, published: false }]))} />
        </Window>}
        <div ref={actionsRef} className="z-20 flex flex-col gap-2 max-lg:sticky max-lg:bottom-[calc(var(--tabbar-height)+env(safe-area-inset-bottom,0px))] max-lg:-mx-4 max-lg:border-y max-lg:border-line-strong max-lg:bg-bg max-lg:px-4 max-lg:py-2" data-editor-actions>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={busy} onClick={save} data-save-theme>{busy ? "Saving" : "Save theme"}</Button>
            <Button variant="secondary" className="lg:hidden" aria-pressed={docked} onClick={() => setDocked((d) => !d)} data-preview-open>{docked ? "Hide preview" : "Show preview"}</Button>
            <Button variant="quiet" href="/settings/themes" className={docked ? "max-lg:hidden" : undefined}>Back to themes</Button>
          </div>
          {saveError && (
            <div role="alert" className="border border-line-strong bg-bg-hi p-3 type-body text-fg" data-save-error>
              <p>{saveError.message}</p>
              {saveError.code === "stale" && <Button variant="secondary" className="mt-2" onClick={() => window.location.reload()} data-reload>Reload the theme</Button>}
            </div>
          )}
        </div>
        {offerUpdate && <PublishedApps apps={offerUpdate} busy={busy} onUpdateDrafts={updateApps} onClose={() => setOfferUpdate(null)} />}
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

/** r2 low: a glass surface over an image wallpaper is measured over black and white (the image is unknown). */
function assumesWorstCase(theme: Theme, w: { field: string; scheme: string }): boolean {
  if (w.field !== "color.surfaceText" && w.field !== "color.surfaceMuted") return false;
  const set = w.scheme === "dark" && theme.mode === "auto" ? resolveTokens(theme, "dark") : theme.tokens;
  return set.surface.material === "glass" && set.wallpaper.kind === "image";
}

/** r2 item 4: the value in force at Compact, for the Gap and Padding fields (the same rounding as the CSS). */
function inForce(which: "gap" | "pad", t: ThemeTokens): string | undefined {
  if (t.space.density !== "compact") return undefined;
  const k = DENSITY_K.compact;
  const v = which === "gap" ? Math.max(4, Math.floor(Math.min(40, Math.max(4, Math.round(t.space.gapPx))) * k)) : Math.floor(Math.min(40, Math.max(8, Math.round(t.space.padPx))) * k);
  return `${v} px at Compact`;
}

function NumberField({ path, value, error, onValid, onError, inForce: note }: { path: string; value: number; error?: string; onValid(v: number): void; onError(m: string | null): void; inForce?: string }) {
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
      {...(note ? { note } : {})}
    />
  );
}

/**
 * B3 with design Note 3 (r2 item 5): the control radius slider offers only stops a control can show,
 * 0 to half the density's pointer control height (Comfortable 0 to 20, Compact 0 to 16) in steps of 2,
 * then a last stop named Pill (stored as 999). The text box takes a number in that range or the word
 * Pill. A stored value above the last stop shows as Pill, as it draws.
 */
function ControlRadiusField({ value, density, error, onValid, onError }: { value: number; density: Density; error?: string; onValid(v: number): void; onError(m: string | null): void }) {
  const max: number = CONTROL_RADIUS_MAX_BY_DENSITY[density === "compact" ? "compact" : "comfortable"];
  const pillStop = max + 2;
  const shown = controlRadiusOf(value, density);
  const [text, setText] = useState(shown === PILL_RADIUS ? "Pill" : String(shown));
  const type = (raw: string) => {
    setText(raw);
    const v = raw.trim();
    if (/^pill$/i.test(v)) {
      onError(null);
      return onValid(PILL_RADIUS);
    }
    const n = Number(v);
    if (v === "" || !Number.isFinite(n) || n < 0 || n > max) return onError(`Control radius must be between 0 and ${max} px, or Pill.`);
    onError(null);
    onValid(n);
  };
  return (
    <div className="flex flex-col gap-1">
      <RangeField
        label="Control radius (px)"
        rangeText={`0 to ${max}, then Pill`}
        name="shape.controlRadiusPx"
        min={0}
        max={pillStop}
        step={2}
        value={shown === PILL_RADIUS ? pillStop : shown}
        valueText={shown === PILL_RADIUS ? "Pill" : `${shown} px`}
        text={text}
        error={error}
        onType={type}
        onSlide={(v) => type(v >= pillStop ? "Pill" : String(Math.round(v)))}
      />
      <span className="type-caption text-fg-2">Buttons, toggles, selects and nav items. {density === "compact" ? "Compact" : "Comfortable"} buttons are {max * 2} px tall, so {max} px is the roundest corner before Pill rounds them fully.</span>
    </div>
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

/**
 * r2 item 8 (design Note 3): after a save, the published apps on this theme still show their snapshot.
 * "Used by N published apps: publish them to show this", with a button per app that opens its review.
 */
function PublishedApps({ apps, busy, onUpdateDrafts, onClose }: { apps: Use[]; busy: boolean; onUpdateDrafts(): void; onClose(): void }) {
  const n = apps.length;
  const copies = apps.filter((u) => !u.draft);
  return (
    <Window title="themes / published apps" data-published-apps={n} data-update-apps>
      <p className="type-body text-fg" data-published-note>
        Used by {n} published {n === 1 ? "app" : "apps"}: publish {n === 1 ? "it" : "them"} to show this. Viewers keep the theme as it was at the last publish until then.
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {apps.map((u) => (
          <li key={u.appId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Button variant="secondary" href={`/build/${encodeURIComponent(u.slug)}?review=1`} data-review-app={u.slug}>Review and publish {u.name}</Button>
            {!u.draft && <span className="type-caption text-fg-2">Its draft holds its own copy of the theme.</span>}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        {copies.length > 0 && <Button variant="ink" disabled={busy} onClick={onUpdateDrafts} data-confirm-update-apps>Point {copies.length === 1 ? "its draft" : "their drafts"} at this theme</Button>}
        <Button variant="quiet" onClick={onClose}>Not now</Button>
      </div>
    </Window>
  );
}

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
