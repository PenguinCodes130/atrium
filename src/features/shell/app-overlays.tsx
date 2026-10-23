"use client";
// Atrium surfaces drawn over a viewed app (architecture v3 amendment A1.6; design v4 "Guest and App
// Views"). app-builder mounts them in the (app) route group; app-shell owns how they look.
//   DraftPreviewBar: when `?draft=1`, a 36px bar on the floating glass across the top:
//     "Draft preview · rev 42 · controls here are real" and "Back to builder".
//   ControlConfirm: the host-drawn confirm before a control runs in a draft preview, a top-layer
//     <dialog> (showModal) styled as a shell window on the floating glass with the overlay shadow.
//     Esc cancels; focus returns to what opened it.
//
// Isolation (gauntlet r2 customisation M1 and L3, Fix 3): both render like the AppSwitcher, into an
// open shadow root on their own host under <body> (isolated-host.ts), wherever the caller mounts them,
// even inside an app canvas. App CSS cannot select into the shadow tree, the host is pinned with inline
// !important declarations and every style is a literal value, so no theme or custom CSS can restyle the
// Run button, hide Cancel or rewrite the title. The bar lives in the top layer (popover="manual") and
// is re-raised whenever an app opens its own popover or dialog, so "controls here are real" is never
// covered. Styles follow the shell mode, reduce transparency and reduced motion like the switcher.
import { useEffect, useId, useRef, type ReactNode } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { useIsolatedRoot, type ShellFonts } from "./isolated-host";
import { useDark } from "./app-switcher";
import { useReduceTransparency } from "./use-preferences";

// Literal design v4 values (light, then dark under [data-mode="dark"]).
function baseCss(): string {
  return `
.w { all: initial; position: fixed; inset: 0; pointer-events: none; -webkit-font-smoothing: antialiased; color: #15130F;
  --fill: rgba(251,249,243,0.86); --opaque: #FBF9F3; --fg: #15130F; --fg2: #3B372F; --line: #15130F; --hair: rgba(21,19,15,0.16); --shadow: #15130F; --ring: #8E6416;
  --bar: #15130F; --barfg: rgba(243,239,228,0.9); --sunk: #E9E3D3; --accent: #E9B949; --accenthi: #F6D98B; --accentfg: #15130F; --bad: #B23B25; --badfg: #FBF9F3;
  --soft: 0 24px 64px rgba(21,19,15,0.22); --scrim: rgba(21,19,15,0.4); --blur: blur(18px) saturate(140%); }
.w[data-mode="dark"] { color: #F3EFE4; --fill: rgba(29,26,21,0.86); --opaque: #1D1A15; --fg: #F3EFE4; --fg2: #CFC8B8; --line: rgba(243,239,228,0.45); --hair: rgba(243,239,228,0.16);
  --shadow: rgba(233,185,73,0.9); --ring: #F0C962; --bar: #2A261F; --barfg: rgba(243,239,228,0.85); --sunk: #2A261F; --bad: #F07A62; --badfg: #15130F; --soft: 0 24px 64px rgba(0,0,0,0.55); --blur: blur(18px) saturate(130%); }
.w *, .w *::before, .w *::after { box-sizing: border-box; }
.glass { background: var(--fill); -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur); border: 1px solid var(--line); }
.w[data-rt] .glass { background: var(--opaque); -webkit-backdrop-filter: none; backdrop-filter: none; }
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) { .glass { background: var(--opaque); } }
@media (prefers-reduced-transparency: reduce) { .glass { background: var(--opaque); -webkit-backdrop-filter: none; backdrop-filter: none; } }
.label { font-size: 12px; line-height: 16px; letter-spacing: -0.01em; }
.dot { display: inline-block; width: 6px; height: 6px; border-radius: 9999px; background: var(--accent); flex: none; }
.btn { appearance: none; margin: 0; display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 36px; padding: 0 14px; border: 1px solid var(--line); border-radius: 0;
  background: var(--opaque); color: var(--fg); font: inherit; font-size: 15px; line-height: 22px; font-weight: 500; letter-spacing: -0.02em; cursor: pointer; text-decoration: none; white-space: nowrap; }
.btn:hover { background: var(--sunk); }
.btn.primary { background: var(--accent); color: var(--accentfg); box-shadow: 3px 3px 0 0 var(--shadow); }
.w[data-mode="light"] .btn.primary { border-color: #15130F; }
.btn.primary:hover { background: var(--accenthi); }
.btn.danger { background: var(--bad); color: var(--badfg); border-color: var(--bad); }
.btn:active { transform: translate(2px, 2px); }
.w[data-reduced] .btn:active { transform: none; }
.btn:focus { outline: none; }
.btn:focus-visible { outline: 2px solid var(--ring); outline-offset: 3px; }
@media (pointer: coarse) { .btn { height: 44px; } }
`;
}

function confirmCss(fonts: ShellFonts): string {
  return `${baseCss()}
.w { font-family: ${fonts.ui}; font-feature-settings: "ss01", "cv11"; }
.mono { font-family: ${fonts.mono}; }
dialog { all: initial; display: none; box-sizing: border-box; position: fixed; inset: 0; margin: auto; padding: 0; border: 0; background: transparent; color: var(--fg); max-width: calc(100vw - 32px); max-height: calc(100dvh - 32px); overflow: visible; pointer-events: auto; font-family: ${fonts.ui}; }
dialog[open] { display: block; width: min(440px, calc(100vw - 32px)); height: fit-content; }
dialog::backdrop { background: var(--scrim); }
.win { display: flex; flex-direction: column; box-shadow: var(--soft), 6px 6px 0 0 var(--shadow); color: var(--fg); }
.bar { height: 28px; flex: none; display: flex; align-items: center; gap: 8px; padding: 0 10px; background: var(--bar); color: var(--barfg); font-family: ${fonts.mono}; font-size: 12px; line-height: 16px; letter-spacing: -0.01em; }
.bar .st { margin-left: auto; opacity: 0.8; }
.body { display: flex; flex-direction: column; gap: 12px; padding: 20px; }
@media (max-width: 639.98px) { .body { padding: 16px; } }
h2 { all: unset; display: block; font-size: 20px; line-height: 24px; font-weight: 600; letter-spacing: -0.02em; color: var(--fg); }
.cmd { margin: 0; padding: 6px 8px; background: var(--sunk); color: var(--fg); font-family: ${fonts.mono}; font-size: 12px; line-height: 16px; letter-spacing: -0.01em; overflow-wrap: anywhere; }
.text { margin: 0; font-size: 15px; line-height: 22px; letter-spacing: -0.01em; color: var(--fg2); }
.row { margin-top: 8px; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
`;
}

function barCss(fonts: ShellFonts): string {
  return `${baseCss()}
.w { font-family: ${fonts.ui}; }
.bar { pointer-events: auto; position: fixed; left: 0; right: 0; top: 0; height: calc(36px + env(safe-area-inset-top, 0px)); padding: env(safe-area-inset-top, 0px) max(12px, env(safe-area-inset-right, 0px)) 0 max(12px, env(safe-area-inset-left, 0px));
  display: flex; align-items: center; gap: 12px; border-left: 0; border-right: 0; border-top: 0; }
.msg { flex: 1; min-width: 0; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); font-family: ${fonts.mono}; font-size: 12px; line-height: 16px; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
.back { height: 28px; padding: 0 8px; font-family: ${fonts.mono}; font-size: 12px; line-height: 16px; font-weight: 400; letter-spacing: -0.01em; }
@media (pointer: coarse) { .back { height: 44px; } }
`;
}

function useReducedMotionNow(): boolean {
  if (typeof window === "undefined") return false;
  return document.documentElement.getAttribute("data-motion") === "reduce" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function DraftPreviewBar({ rev, builderHref }: { rev: number; builderHref: string }) {
  const root = useIsolatedRoot("atrium-draft-bar", "data-draft-preview-host", barCss, { popover: true, keepOnTop: true });
  const dark = useDark();
  const rt = useReduceTransparency();
  if (!root) return null;
  return createPortal(
    <div className="w" data-mode={dark ? "dark" : "light"} data-rt={rt ? "" : undefined}>
      <div role="region" aria-label="Draft preview" className="bar glass" data-draft-preview-bar>
        <span aria-hidden="true" className="dot" />
        <p className="msg">
          Draft preview · rev {rev} · controls here are real
        </p>
        <Link href={builderHref} className="btn back" data-back-to-builder>
          Back to builder
        </Link>
      </div>
    </div>,
    root,
  );
}

export type ControlConfirmProps = {
  open: boolean;
  /** What will happen, for example "Turn on Office lamp". */
  title: string;
  /** The integration and command in mono, for example "home-assistant · light.toggle office_lamp". */
  command?: string;
  /** Plain text (it renders inside the isolated shadow root, where shell utility classes do not apply). */
  body?: ReactNode;
  confirmLabel?: string;
  /** Destructive controls use the destructive confirm style. */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ControlConfirm({ open, title, command, body, confirmLabel = "Run it", destructive = false, onConfirm, onCancel }: ControlConfirmProps) {
  const root = useIsolatedRoot("atrium-control-confirm", "data-control-confirm-host", confirmCss);
  const dark = useDark();
  const rt = useReduceTransparency();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement as HTMLElement | null;
      d.showModal();
    } else if (!open && d.open) {
      d.close();
      opener.current?.focus({ preventScroll: true });
    }
  }, [open, root]);
  if (!root) return null;
  return createPortal(
    <div className="w" data-mode={dark ? "dark" : "light"} data-rt={rt ? "" : undefined} data-reduced={useReducedMotionNow() ? "" : undefined}>
      <dialog
        ref={ref}
        data-shell-dialog
        data-control-confirm
        aria-labelledby={titleId}
        onCancel={(e) => {
          e.preventDefault();
          onCancel();
        }}
      >
        <div data-window="dialog" className="win glass">
          <div className="bar">
            <svg viewBox="0 0 12 14" width="9" height="10" aria-hidden="true">
              <path d="M1 13V6a5 5 0 0 1 10 0v7Z" fill="#E9B949" />
            </svg>
            <span>control · confirm</span>
            <span className="st">draft preview</span>
          </div>
          <div className="body">
            <h2 id={titleId} data-confirm-title>
              {title}
            </h2>
            {command && (
              <p className="cmd" data-confirm-command>
                {command}
              </p>
            )}
            {body && <div className="text">{body}</div>}
            <div className="row">
              <button type="button" className="btn" onClick={onCancel} data-confirm-cancel>
                Cancel
              </button>
              <button type="button" className={`btn ${destructive ? "danger" : "primary"}`} onClick={onConfirm} data-confirm-run>
                {confirmLabel}
              </button>
            </div>
          </div>
        </div>
      </dialog>
    </div>,
    root,
  );
}
