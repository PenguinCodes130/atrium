"use client";
// Builder bar controls for the canvas (Wave 2.6 builder ease spec 3.5 to 3.7): the Snap switch, Preview
// width with its zoom, folding the side panels, and the page's width and padding (A7.5). Each person's
// choices are remembered in this browser (localStorage, wrapped: private windows have none).
import { useCallback, useEffect, useId, useState } from "react";
import { Popover } from "radix-ui";
import type { DraftOp, PageDoc } from "@/core/contracts";
import { SelectMenu } from "@/features/settings/ui/controls";

/** A per-person builder preference kept in localStorage; the default until the browser has been read. */
export function usePref<T>(key: string, initial: T, valid: (v: unknown) => v is T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return;
      const v: unknown = JSON.parse(raw);
      if (valid(v)) setValue(v);
    } catch {
      /* no storage: keep the default */
    }
  }, [key]);
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        window.localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* no storage: the choice lasts for this visit */
      }
    },
    [key],
  );
  return [value, set];
}
export const isBool = (v: unknown): v is boolean => typeof v === "boolean";

export type PreviewW = "fit" | 1280 | 1440 | 1920;
export const PREVIEW_WIDTHS: PreviewW[] = ["fit", 1280, 1440, 1920];
export const isPreviewW = (v: unknown): v is PreviewW => v === "fit" || v === 1280 || v === 1440 || v === 1920;

const seg = "h-8 px-2 type-label touch:h-11";

/** The Snap switch: on by default, meaning smart guides (F7, A11.7); Alt or Option held turns the pull off for one move. */
export function SnapSwitch({ on, onChange }: { on: boolean; onChange(v: boolean): void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      title={on ? "Widgets pull to other widgets' edges and centres, equal gaps and the columns. Hold Alt (Option on a Mac) while dragging to place freely" : "Free placement, nothing pulls. Turn Snap on for guides"}
      className={`inline-flex h-8 flex-none items-center gap-1.5 border border-line-strong px-2 type-label touch:h-11 ${on ? "bg-fg text-bg" : "text-fg-2 hover:bg-bg-sunk"}`}
      data-snap={on ? "on" : "off"}
    >
      <svg viewBox="0 0 12 12" width={11} height={11} aria-hidden>
        <path d="M1 4h10M1 8h10M4 1v10M8 1v10" stroke="currentColor" strokeWidth="1.1" strokeDasharray={on ? undefined : "1.5 1.5"} />
      </svg>
      Snap
    </button>
  );
}

/** Preview width beside Desktop and Phone: Fit, or the real width scaled to fit, with its zoom. */
export function PreviewWidth({ value, onChange, zoom, disabled }: { value: PreviewW; onChange(v: PreviewW): void; zoom: number; disabled?: boolean }) {
  return (
    <div role="group" aria-label="Preview width" className="flex flex-none items-center border border-line-strong" data-preview-width={String(value)}>
      {PREVIEW_WIDTHS.map((w) => (
        <button
          key={String(w)}
          type="button"
          disabled={disabled}
          aria-pressed={value === w}
          title={w === "fit" ? "Fit the page to the canvas" : `Draw the page ${w}px wide, as a viewer at that width sees it`}
          onClick={() => onChange(w)}
          className={`${seg} disabled:opacity-40 ${value === w ? "bg-fg text-bg" : "text-fg-2 hover:bg-bg-sunk"}`}
          data-preview-w={String(w)}
        >
          {w === "fit" ? "Fit" : w}
        </button>
      ))}
      <span className="min-w-[3.25rem] border-l border-line-strong px-2 text-center font-mono text-[11px] text-fg-2" aria-label={`Zoom ${Math.round(zoom * 100)} percent`} data-zoom={Math.round(zoom * 100)}>
        {Math.round(zoom * 100)}%
      </span>
    </div>
  );
}

/** Fold or unfold one side panel; `[` and `]` do the same. */
export function FoldButton({ side, folded, onToggle }: { side: "left" | "right"; folded: boolean; onToggle(): void }) {
  const name = side === "left" ? "Insert and Layers" : "the inspector";
  return (
    <button
      type="button"
      aria-pressed={folded}
      aria-label={`${folded ? "Show" : "Hide"} ${name} (${side === "left" ? "[" : "]"})`}
      title={`${folded ? "Show" : "Hide"} ${name} (${side === "left" ? "[" : "]"})`}
      onClick={onToggle}
      className={`inline-flex h-8 w-8 flex-none items-center justify-center border border-line-strong touch:h-11 touch:w-11 ${folded ? "bg-fg text-bg" : "text-fg-2 hover:bg-bg-sunk"}`}
      data-fold={side}
      data-folded={folded ? "" : undefined}
    >
      <svg viewBox="0 0 14 12" width={14} height={12} aria-hidden>
        <rect x="0.75" y="0.75" width="12.5" height="10.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <rect x={side === "left" ? 0.75 : 9} y="0.75" width="4.25" height="10.5" fill="currentColor" opacity={folded ? 0.25 : 1} />
      </svg>
    </button>
  );
}

const WIDTHS = [
  { value: "fill", label: "Fill the screen" },
  { value: "1280", label: "1280 px, centred" },
  { value: "1440", label: "1440 px, centred" },
  { value: "1920", label: "1920 px, centred" },
] as const;
const PADS = [
  { value: "theme", label: "Theme" },
  { value: "none", label: "None" },
  { value: "custom", label: "A number of px" },
] as const;

/** Page width and Page padding (A7.5), beside the page switcher. Each change is one undoable edit. */
export function PageSettings({ page, apply }: { page: PageDoc; apply(ops: DraftOp[]): void }) {
  const id = useId();
  const pad = page.padding === undefined ? "theme" : page.padding === "none" ? "none" : "custom";
  const [text, setText] = useState(typeof page.padding === "number" ? String(page.padding) : "16");
  const [bad, setBad] = useState<string | null>(null);
  useEffect(() => {
    if (typeof page.padding === "number") setText(String(page.padding));
  }, [page.padding]);
  const set = (patch: Partial<PageDoc> | Record<string, null>) => apply([{ op: "page.update", pageId: page.id, patch: patch as Partial<PageDoc> }]);
  const commit = (raw: string) => {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isInteger(n) || n < 0 || n > 64) {
      setBad("A whole number from 0 to 64.");
      return;
    }
    setBad(null);
    if (page.padding !== n) set({ padding: n });
  };
  return (
    <Popover.Root modal={false}>
      <Popover.Trigger asChild>
        <button type="button" className="flex h-8 flex-none cursor-pointer items-center border border-line-strong px-2 type-label hover:bg-bg-sunk data-[state=open]:bg-bg-sunk touch:h-11" data-page-settings>
          Page settings
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={4} collisionPadding={8} className="z-50 flex w-64 flex-col gap-3 border border-line-strong bg-bg-hi p-3 text-fg shadow-window-sm" data-page-settings-content>
          <p className="type-label">{page.title}</p>
          <div className="flex flex-col gap-1">
            <SelectMenu label="Page width" name="page-width" value={page.maxWidth ? (String(page.maxWidth) as "1280") : "fill"} options={WIDTHS} onChange={(v) => set(v === "fill" ? { maxWidth: null } : { maxWidth: Number(v) as 1280 })} />
            <p className="type-caption text-fg-2">Fill the screen, or keep the page at most this wide in the middle of wide screens.</p>
          </div>
          <div className="flex flex-col gap-1">
            <SelectMenu label="Page padding" name="page-padding" value={pad} options={PADS} onChange={(v) => { setBad(null); if (v === "theme") set({ padding: null }); else if (v === "none") set({ padding: "none" }); else commit(text); }} />
            {pad === "custom" && (
              <span className="flex items-center gap-2">
                <label htmlFor={`${id}-pad`} className="sr-only">Padding in px</label>
                <input
                  id={`${id}-pad`}
                  type="number"
                  min={0}
                  max={64}
                  step={1}
                  inputMode="numeric"
                  value={text}
                  aria-invalid={bad ? true : undefined}
                  onChange={(e) => setText(e.target.value)}
                  onBlur={(e) => commit(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") commit((e.target as HTMLInputElement).value); }}
                  className="h-9 w-20 border border-line-strong bg-bg-hi px-2 font-mono text-[13px] touch:h-11 aria-[invalid=true]:border-bad"
                  data-page-padding-px
                />
                <span className="type-caption text-fg-2">px, 0 to 64</span>
              </span>
            )}
            {bad && <p className="type-caption text-bad" role="alert">{bad}</p>}
            <p className="type-caption text-fg-2">Space between the window edges and the page. None lets the page touch the edges.</p>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
