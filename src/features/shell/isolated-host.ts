"use client";
// Isolated hosts for Atrium surfaces drawn over a viewed app (architecture v3 sections 4.6 and 13): the
// app switcher, the draft preview bar and the control confirm dialog. Each renders OUTSIDE the app's
// scope root, into an open shadow root on its own host element under <body>:
//   - document CSS (theme, chrome, component or custom CSS) cannot select into the shadow tree;
//   - the host's box, visibility and stacking are pinned with inline !important declarations, which
//     beat any stylesheet rule, including !important ones in cascade layers;
//   - the shadow tree's styles are one constructed stylesheet of literal values that starts from
//     `all: initial`, so no inherited property or custom property from the page reaches it;
//   - with `popover`, the host is shown in the browser top layer (above any z-index an app can use)
//     and re-shown if anything closes it; with `keepOnTop`, it is also re-raised whenever another
//     top-layer item (a popover or modal dialog an app opens) appears, so it is never covered.
import { useLayoutEffect, useState } from "react";

/** Inline !important pins on every isolated host element. */
export const HOST_PINS: [string, string][] = [
  ["position", "fixed"],
  ["inset", "0px"],
  ["width", "100vw"],
  ["height", "100dvh"],
  ["max-width", "none"],
  ["max-height", "none"],
  ["margin", "0px"],
  ["padding", "0px"],
  ["border", "0px none"],
  ["background", "transparent"],
  ["overflow", "visible"],
  ["display", "block"],
  ["visibility", "visible"],
  ["opacity", "1"],
  ["transform", "none"],
  ["translate", "none"],
  ["scale", "none"],
  ["rotate", "none"],
  ["filter", "none"],
  ["clip-path", "none"],
  ["mask", "none"],
  ["mix-blend-mode", "normal"],
  ["contain", "none"],
  ["z-index", "2147483647"],
  ["pointer-events", "none"],
  ["color-scheme", "normal"],
  ["content-visibility", "visible"],
  ["zoom", "1"],
  ["outline", "none"],
  ["box-shadow", "none"],
];

/** Marks every isolated host, so their own top-layer moves never re-raise each other. */
export const ISOLATED_ATTR = "data-atrium-isolated";

export type ShellFonts = { ui: string; mono: string };

/** The shell families as literal stacks (next/font sets the variables on <html>). */
export function shellFonts(): ShellFonts {
  const css = getComputedStyle(document.documentElement);
  return {
    ui: `${css.getPropertyValue("--font-inter-tight").trim() || "'Inter Tight'"}, ui-sans-serif, system-ui, sans-serif`,
    mono: `${css.getPropertyValue("--font-geist-mono").trim() || "'Geist Mono'"}, ui-monospace, monospace`,
  };
}

function show(host: HTMLElement) {
  try {
    if (!host.matches(":popover-open")) host.showPopover();
  } catch {
    // No popover support: the pinned fixed position and maximum z-index still apply.
  }
}

/**
 * Create the isolated host once and remove it on unmount. Returns its shadow root (null until mounted).
 * `tag` is the host's custom element name; `marker` a data attribute set on it for tests and pins.
 */
export function useIsolatedRoot(tag: string, marker: string, css: (fonts: ShellFonts) => string, opts: { popover?: boolean; keepOnTop?: boolean } = {}): ShadowRoot | null {
  const [root, setRoot] = useState<ShadowRoot | null>(null);
  const { popover = false, keepOnTop = false } = opts;
  useLayoutEffect(() => {
    const host = document.createElement(tag);
    host.setAttribute(marker, "");
    host.setAttribute(ISOLATED_ATTR, "");
    if (popover) host.setAttribute("popover", "manual");
    for (const [k, v] of HOST_PINS) host.style.setProperty(k, v, "important");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css(shellFonts()));
    shadow.adoptedStyleSheets = [sheet];
    const cleanups: (() => void)[] = [];
    if (popover) {
      show(host);
      // If anything closes it, reopen it.
      const keep = () => show(host);
      host.addEventListener("toggle", keep);
      cleanups.push(() => host.removeEventListener("toggle", keep));
      if (keepOnTop) {
        // Another top-layer item opened (an app's popover or modal dialog): move back above it.
        const lift = () => {
          try {
            host.hidePopover();
          } catch {
            /* ignore */
          }
          show(host);
        };
        const raise = (e: Event) => {
          const t = e.target as Element | null;
          if (!t || t === host || (t instanceof Element && t.closest(`[${ISOLATED_ATTR}]`))) return;
          if ((e as ToggleEvent).newState && (e as ToggleEvent).newState !== "open") return;
          lift();
        };
        window.addEventListener("toggle", raise, true);
        cleanups.push(() => window.removeEventListener("toggle", raise, true));
        // Modal dialogs do not always fire "toggle": watch for any <dialog> gaining `open`.
        const mo = new MutationObserver((list) => {
          for (const m of list) {
            const t = m.target;
            if (t instanceof HTMLDialogElement && t.open && !t.closest(`[${ISOLATED_ATTR}]`)) return lift();
          }
        });
        mo.observe(document.body, { attributes: true, attributeFilter: ["open"], subtree: true });
        cleanups.push(() => mo.disconnect());
      }
    }
    setRoot(shadow);
    return () => {
      for (const c of cleanups) c();
      host.remove();
      setRoot(null);
    };
    // The host is created once per mount; css and options are fixed for a component.
  }, []);
  return root;
}
