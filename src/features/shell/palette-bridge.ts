// Bridge between the shell and the command palette (owned by command-palette). The shell calls
// openPalette() on Ctrl/Cmd+K, the search hint and the phone Search tab. The palette registers with
// onPaletteRequest() and claims the request; if nothing claims it, the shell shows a fallback.
export const PALETTE_EVENT = "atrium:open-palette";

/** Ask the palette to open. Returns true when a palette claimed the request. */
export function openPalette(source: "keyboard" | "sidebar" | "tab" | "other" = "other"): boolean {
  if (typeof window === "undefined") return false;
  const event = new CustomEvent(PALETTE_EVENT, { detail: { source }, cancelable: true });
  return !window.dispatchEvent(event);
}

/** For the palette: handle open requests. Call event.preventDefault() is done for you. */
export function onPaletteRequest(handler: (source: string) => void): () => void {
  const listener = (e: Event) => {
    e.preventDefault();
    handler((e as CustomEvent<{ source: string }>).detail?.source ?? "other");
  };
  window.addEventListener(PALETTE_EVENT, listener);
  return () => window.removeEventListener(PALETTE_EVENT, listener);
}

/** True for Ctrl+K (Windows, Linux) or Cmd+K (macOS). */
export function isPaletteShortcut(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): boolean {
  return (e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
}
