"use client";
// The inspector folds (builder ease spec 3.2): each inspector group opens on its simple set, the rest folds
// under one of these, and whether a fold is open is remembered per person (in this browser) for each group.
// Wave 2.10b F4: a fold is titled with what it holds ("More: change, warning from, problem from"), from
// `holds` (the labels of the settings inside), never a bare "More settings".
// Browser storage here is only a convenience: without it every fold simply starts closed.
import { useId, useSyncExternalStore, type ReactNode } from "react";
import { motion } from "motion/react";
import { transitionFor, useReducedMotion } from "@/features/shell";

const KEY = "atrium.inspector.more";
const listeners = new Set<() => void>();
let cache: Record<string, boolean> | null = null;

function read(): Record<string, boolean> {
  if (cache) return cache;
  try {
    const raw = typeof window === "undefined" ? null : window.localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    cache = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, boolean>) : {};
  } catch {
    cache = {};
  }
  return cache;
}

/** Opens or folds one group's "More settings" for this person. */
export function setFoldOpen(group: string, open: boolean): void {
  cache = { ...read(), [group]: open };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* storage blocked: the choice lasts until the page reloads */
  }
  for (const l of listeners) l();
}

/** Whether a group's "More settings" is open for this person (closed until they open it). */
export function useFoldOpen(group: string): [boolean, (open: boolean) => void] {
  const open = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => read()[group] === true,
    () => false,
  );
  return [open, (o: boolean) => setFoldOpen(group, o)];
}

/** A rotating chevron for folds (design v4: `pop`). */
export function Chevron({ open }: { open: boolean }) {
  const reduced = useReducedMotion();
  return (
    <motion.svg viewBox="0 0 12 12" width="12" height="12" aria-hidden className="flex-none text-fg-2" data-fold-chevron={open ? "open" : "closed"} initial={false} animate={{ rotate: open ? 90 : 0 }} transition={transitionFor("pop", reduced)}>
      <path d="M4 2.5 7.5 6 4 9.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
    </motion.svg>
  );
}

/**
 * The fold itself: a quiet toggle with how many of its settings hold a value, then its fields. `group`
 * names what is remembered ("content", "data", "layout", "style"...).
 */
/** "More: decimals, min and max, colours": a fold's title from the labels of what it holds (F4). */
export function foldTitle(holds: readonly string[], lead = "More"): string {
  // Sentence case inside the title: "Decimal places" reads "decimal places"; "CPU" stays as written.
  const lower = (h: string) => (/^[A-Z][a-z]/.test(h) ? h[0]!.toLowerCase() + h.slice(1) : h);
  const words = [...new Set(holds.map((h) => h.trim()).filter(Boolean))].map(lower);
  return words.length ? `${lead}: ${words.join(", ")}` : lead;
}

export function MoreFold({ group, count, children, label, holds, toggleAttr }: { group: string; count?: number; children: ReactNode; /** A written title; otherwise it is made from `holds`. */ label?: string; /** The labels of the settings inside (F4), for the title. */ holds?: readonly string[]; /** An extra data attribute on the toggle (kept for older tests). */ toggleAttr?: string }) {
  const [open, setOpen] = useFoldOpen(group);
  // Without a title or what it holds the fold keeps its older title (callers outside components pass holds).
  const title = label ?? (holds ? foldTitle(holds) : "More settings");
  const id = useId();
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-2" data-more-settings={group} data-open={open ? "" : undefined}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="flex min-h-9 items-center gap-2 text-left type-label text-fg hover:text-accent-ink touch:min-h-11"
        data-more-settings-toggle={group}
        {...(toggleAttr ? { [toggleAttr]: "" } : {})}
      >
        <Chevron open={open} />
        <span className="min-w-0 flex-1" data-fold-title>
          {title}
        </span>
        {count ? <span className="font-mono text-[11px] text-fg-2" data-more-count>{count} set</span> : null}
      </button>
      {open ? (
        <div id={id} className="flex flex-col gap-3" data-more-body={group}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
