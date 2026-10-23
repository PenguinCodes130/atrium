"use client";
// Mounted once by the root layout, on every screen: Ctrl/Cmd+K opens the command palette from
// anywhere; the on-screen keyboard handling for phones; and the input-modality marker. The palette
// fallback (a jump list until command-palette ships) is mounted by ShellFrame, where the nav lives.
import { useEffect } from "react";
import { isPaletteShortcut, openPalette } from "./palette-bridge";

function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isPaletteShortcut(e)) {
        e.preventDefault();
        openPalette("keyboard");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Sets data-input="keyboard|pointer" on <html> (diagnostics; focus rings use :focus-visible). */
function useInputModality() {
  useEffect(() => {
    const root = document.documentElement;
    const kb = () => root.setAttribute("data-input", "keyboard");
    const ptr = () => root.setAttribute("data-input", "pointer");
    window.addEventListener("keydown", kb, true);
    window.addEventListener("pointerdown", ptr, true);
    return () => {
      window.removeEventListener("keydown", kb, true);
      window.removeEventListener("pointerdown", ptr, true);
    };
  }, []);
}

const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "range", "color", "file", "button", "submit", "reset", "image", "hidden"]);
export function isTextField(el: Element | null): el is HTMLElement {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  return el instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(el.type);
}

/**
 * On-screen keyboard (phones): `data-typing` on <html> while a text field has focus (the tab bar
 * steps aside), `--keyboard-inset` from the visual viewport (bottom sheets sit above an overlaying
 * keyboard), and the focused field is scrolled into view whenever the viewport shrinks.
 */
function useKeyboardHandling() {
  useEffect(() => {
    const root = document.documentElement;
    const coarse = window.matchMedia("(pointer: coarse)");
    const vv = window.visualViewport;
    const reveal = () => {
      const el = document.activeElement;
      if (!coarse.matches || !isTextField(el)) return;
      requestAnimationFrame(() => el.scrollIntoView({ block: "center", inline: "nearest" }));
    };
    const onViewport = () => {
      const inset = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
      root.style.setProperty("--keyboard-inset", `${inset}px`);
      reveal();
    };
    const onFocusIn = (e: FocusEvent) => {
      if (!isTextField(e.target as Element)) return;
      root.setAttribute("data-typing", "");
      reveal();
    };
    const onFocusOut = () => {
      // focus may be moving to another field; check once it has landed
      setTimeout(() => {
        if (!isTextField(document.activeElement)) root.removeAttribute("data-typing");
      }, 0);
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    vv?.addEventListener("resize", onViewport);
    window.addEventListener("resize", onViewport);
    onViewport();
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      vv?.removeEventListener("resize", onViewport);
      window.removeEventListener("resize", onViewport);
    };
  }, []);
}

export function ShellGlobals() {
  useEffect(() => {
    // Marks the client as hydrated (used by e2e tests to know the page is interactive).
    document.documentElement.setAttribute("data-hydrated", "");
  }, []);
  useGlobalShortcuts();
  useInputModality();
  useKeyboardHandling();
  return null;
}
