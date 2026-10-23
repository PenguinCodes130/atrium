"use client";
// The app switcher (design v4 "Guest and App Views", spec v2 criteria 44 to 47): the only Atrium
// control drawn over a viewed app. A 36px square on the floating glass at the bottom left (above the
// safe area) showing the 18px lit mark, with a 44 x 44 hit area. Activating it opens a sheet on the
// floating glass (sheet spring) listing the user's other apps, "Edit this app" (editors only) and
// "Back to Atrium". Signed-in users only: guests never get it, and it is never drawn in the shell.
//
// Isolation (architecture v3 sections 4.6 and 13): the switcher renders OUTSIDE the app's scope root,
// into an open shadow root on its own host element under <body>, shown in the browser top layer
// (popover="manual"), so it sits above anything an app draws whatever its z-index. Document CSS cannot
// select into the shadow tree, the host's position and visibility are pinned with inline !important
// declarations (which beat any stylesheet), and the wrapper resets inherited properties
// (`all: initial`), so theme, chrome, component or custom CSS cannot restyle, hide, cover or move it.
// All styles are literal values in a constructed stylesheet (no inherited custom properties).
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { timed, transitionFor } from "./motion";
import { useReducedMotion, useReduceTransparency } from "./use-preferences";
import { MARK_DOORWAY, MARK_LEFT_BAND, MARK_RIGHT_BAND, MARK_VIEWBOX } from "./brand-paths";
import { useIsolatedRoot } from "./isolated-host";

export type SwitcherApp = { slug: string; name: string };
export type AppSwitcherProps = {
  /** Who is viewing: only "user" (a signed-in session) gets the switcher. */
  viewer: "user" | "guest" | "none";
  /** The app being viewed (its slug is used for "Edit this app"). */
  currentSlug: string;
  /** The user's other apps (from the app access hook's appsFor; empty until app-builder registers it). */
  apps?: SwitcherApp[];
  /** Whether this user may edit the app (canEditApp); shows "Edit this app". */
  canEdit?: boolean;
};

/** Whether the switcher is drawn at all: signed-in users only (never guests, never signed out). */
export function switcherVisible(viewer: AppSwitcherProps["viewer"]): boolean {
  return viewer === "user";
}

/** The sheet's rows, in order: the user's other apps, "Edit this app" (editors), "Back to Atrium". */
export function switcherItems(p: Pick<AppSwitcherProps, "currentSlug" | "apps" | "canEdit">): { key: string; label: string; href: string; kind: "app" | "edit" | "home" }[] {
  const rows: { key: string; label: string; href: string; kind: "app" | "edit" | "home" }[] = [];
  for (const a of p.apps ?? []) if (a.slug !== p.currentSlug) rows.push({ key: `app:${a.slug}`, label: a.name, href: `/a/${encodeURIComponent(a.slug)}`, kind: "app" });
  if (p.canEdit) rows.push({ key: "edit", label: "Edit this app", href: `/build/${encodeURIComponent(p.currentSlug)}`, kind: "edit" });
  rows.push({ key: "home", label: "Back to Atrium", href: "/", kind: "home" });
  return rows;
}

// Settings r3 SFR (gauntlet w2-r2 item 5): the focus ring and the dark-mode hard shadow follow the
// instance accent. Custom properties pass "all: initial" and the shadow boundary, and only the root
// layout's BrandingStyle and the shell tokens set them on <html> (a viewed app's CSS is scoped to its
// canvas). The doorway of the mark stays Atrium gold, like the top bar's.
function sheetCss(fonts: { ui: string; mono: string }): string {
  return `
.w { all: initial; position: fixed; inset: 0; pointer-events: none; font-family: ${fonts.ui}; font-feature-settings: "ss01", "cv11"; -webkit-font-smoothing: antialiased; color: #15130F;
  --fill: rgba(251,249,243,0.86); --opaque: #FBF9F3; --fg: #15130F; --fg2: #3B372F; --line: #15130F; --hair: rgba(21,19,15,0.16); --shadow: #15130F; --ring: var(--accent-ink, #8E6416); --bar: #15130F; --barfg: rgba(243,239,228,0.9); --band: #15130F; --hover: #E9E3D3; --soft: 0 24px 64px rgba(21,19,15,0.22); }
.w[data-mode="dark"] { color: #F3EFE4; --fill: rgba(29,26,21,0.86); --opaque: #1D1A15; --fg: #F3EFE4; --fg2: #CFC8B8; --line: rgba(243,239,228,0.45); --hair: rgba(243,239,228,0.16); --shadow: color-mix(in srgb, var(--accent, #E9B949) 90%, transparent); --ring: var(--accent-ink, #F0C962); --bar: #2A261F; --barfg: rgba(243,239,228,0.85); --band: #F3EFE4; --hover: #2A261F; --soft: 0 24px 64px rgba(0,0,0,0.55); }
.w *, .w *::before, .w *::after { box-sizing: border-box; }
.glass { background: var(--fill); -webkit-backdrop-filter: blur(18px) saturate(140%); backdrop-filter: blur(18px) saturate(140%); border: 1px solid var(--line); box-shadow: 3px 3px 0 0 var(--shadow); }
.w[data-mode="dark"] .glass { -webkit-backdrop-filter: blur(18px) saturate(130%); backdrop-filter: blur(18px) saturate(130%); }
.w[data-rt] .glass { background: var(--opaque); -webkit-backdrop-filter: none; backdrop-filter: none; }
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) { .glass { background: var(--opaque); } }
@media (prefers-reduced-transparency: reduce) { .glass { background: var(--opaque); -webkit-backdrop-filter: none; backdrop-filter: none; } }
.btn { pointer-events: auto; position: fixed; left: max(8px, env(safe-area-inset-left, 0px)); bottom: calc(8px + env(safe-area-inset-bottom, 0px)); width: 44px; height: 44px; padding: 4px; margin: 0; border: 0; background: transparent; cursor: pointer; display: block; -webkit-tap-highlight-color: transparent; }
.btn .face { width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; }
.btn:hover .face { background: var(--opaque); }
.btn:focus { outline: none; }
.btn:focus-visible { outline: none; }
.btn:focus-visible .face { outline: 2px solid var(--ring); outline-offset: 3px; }
.sheet { pointer-events: auto; position: fixed; left: max(12px, env(safe-area-inset-left, 0px)); bottom: calc(60px + env(safe-area-inset-bottom, 0px)); width: min(300px, calc(100vw - 24px)); max-height: calc(100dvh - 96px); display: flex; flex-direction: column; box-shadow: var(--soft), 3px 3px 0 0 var(--shadow); }
.bar { height: 28px; flex: none; display: flex; align-items: center; gap: 8px; padding: 0 10px; background: var(--bar); color: var(--barfg); font-family: ${fonts.mono}; font-size: 12px; line-height: 16px; letter-spacing: -0.01em; }
.list { list-style: none; margin: 0; padding: 6px; overflow-y: auto; }
.label { margin: 0; padding: 10px 8px 4px; font-family: ${fonts.mono}; font-size: 11px; line-height: 15px; color: var(--fg2); }
.item { display: flex; align-items: center; gap: 10px; min-height: 36px; padding: 0 8px; color: var(--fg); text-decoration: none; font-size: 15px; line-height: 22px; font-weight: 500; letter-spacing: -0.02em; border-top: 1px solid var(--hair); }
.item:first-child { border-top: 0; }
.item:hover { background: var(--hover); }
.item:focus { outline: none; }
.item:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
.item .k { margin-left: auto; font-family: ${fonts.mono}; font-size: 11px; color: var(--fg2); }
.sep { height: 1px; background: var(--hair); margin: 6px 0; }
.sep + .item { border-top: 0; }
@media (pointer: coarse) { .item { min-height: 44px; } }
`;
}

function LitMark({ height, band }: { height: number; band: string }) {
  return (
    <svg viewBox={MARK_VIEWBOX} width={(height * 1020) / 691} height={height} aria-hidden="true" data-mark="lit">
      <path d={MARK_LEFT_BAND} fill={band} />
      <path d={MARK_RIGHT_BAND} fill={band} />
      <path d={MARK_DOORWAY} fill="#E9B949" data-doorway />
    </svg>
  );
}

export function useDark(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const read = () => {
      const t = document.documentElement.getAttribute("data-theme");
      setDark(t === "dark" || (t !== "light" && mq.matches));
    };
    read();
    mq.addEventListener("change", read);
    window.addEventListener("atrium:preferences", read);
    return () => {
      mq.removeEventListener("change", read);
      window.removeEventListener("atrium:preferences", read);
    };
  }, []);
  return dark;
}

export function AppSwitcher({ viewer, currentSlug, apps = [], canEdit = false }: AppSwitcherProps) {
  if (!switcherVisible(viewer)) return null;
  return <SwitcherInner currentSlug={currentSlug} apps={apps} canEdit={canEdit} />;
}

function SwitcherInner({ currentSlug, apps, canEdit }: { currentSlug: string; apps: SwitcherApp[]; canEdit: boolean }) {
  const root = useIsolatedRoot("atrium-switcher", "data-atrium-switcher", sheetCss, { popover: true, keepOnTop: true });
  const dark = useDark();
  const reduced = useReducedMotion();
  const reduceTransparency = useReduceTransparency();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const sheetId = useId();
  const items = switcherItems({ currentSlug, apps, canEdit });
  const appRows = items.filter((i) => i.kind === "app");
  const otherRows = items.filter((i) => i.kind !== "app");

  const close = useCallback((restore = true) => {
    setOpen(false);
    if (restore) button.current?.focus({ preventScroll: true });
  }, []);

  // Focus the first row when the sheet opens.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => sheet.current?.querySelector<HTMLElement>("a")?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Esc closes and returns focus; a press outside closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(true);
      }
    };
    const onDown = (e: PointerEvent) => {
      const path = e.composedPath();
      if (sheet.current && !path.includes(sheet.current) && button.current && !path.includes(button.current)) close(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [open, close]);

  // Tab stays inside the open sheet (it is a small modal list).
  const onSheetKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || !sheet.current) return;
    const links = [...sheet.current.querySelectorAll<HTMLElement>("a")];
    if (!links.length) return;
    const active = (sheet.current.getRootNode() as ShadowRoot).activeElement;
    const i = links.indexOf(active as HTMLElement);
    const next = e.shiftKey ? (i <= 0 ? links.length - 1 : i - 1) : i === links.length - 1 ? 0 : i + 1;
    e.preventDefault();
    links[next]?.focus();
  };

  if (!root) return null;
  const band = dark ? "#F3EFE4" : "#15130F";
  return createPortal(
    <div className="w" data-mode={dark ? "dark" : "light"} data-rt={reduceTransparency ? "" : undefined} data-switcher-root>
      <AnimatePresence>
        {open && (
          <motion.div
            ref={sheet}
            id={sheetId}
            role="dialog"
            aria-modal="true"
            aria-label="Switch apps"
            className="sheet glass"
            data-switcher-sheet
            onKeyDown={onSheetKey}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0, transition: { duration: 0.12 } } : { opacity: 0, y: 16, transition: timed("fade") }}
            transition={transitionFor("sheet", reduced)}
          >
            <div className="bar" aria-hidden="true">
              <svg viewBox="0 0 12 14" width="9" height="10">
                <path d="M1 13V6a5 5 0 0 1 10 0v7Z" fill="#E9B949" />
              </svg>
              atrium / switch
            </div>
            <div className="list">
              {appRows.length > 0 && (
                <>
                  <p className="label">your apps</p>
                  {appRows.map((r) => (
                    <Link key={r.key} href={r.href} className="item" data-switcher-item={r.kind} onClick={() => setOpen(false)}>
                      {r.label}
                    </Link>
                  ))}
                  <div className="sep" />
                </>
              )}
              {otherRows.map((r) => (
                <Link key={r.key} href={r.href} className="item" data-switcher-item={r.kind} onClick={() => setOpen(false)}>
                  {r.label}
                  <span className="k" aria-hidden="true">{r.kind === "edit" ? "builder" : "apps"}</span>
                </Link>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <button
        ref={button}
        type="button"
        className="btn"
        aria-label="Atrium: switch apps"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? sheetId : undefined}
        onClick={() => (open ? close(true) : setOpen(true))}
        data-switcher-button
      >
        <span className="face glass">
          <LitMark height={18} band={band} />
        </span>
      </button>
    </div>,
    root,
  );
}
