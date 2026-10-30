"use client";
// Wave 2.10b F6: the one visual icon picker every icon field opens (icon, service tile, bookmarks,
// resource bar items). Search, categories, Recent, every built-in icon drawn as itself, and Upload.
// "From website" is N4 (Wave 2.10c): it goes in the `extraEntries` slot beside Upload, nothing else moves.
// The field shows the current icon drawn (F10 sweep: show, don't name) with its name in words.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button, Sheet, useReducedMotion } from "@/features/shell";
import { MediaField } from "@/features/uploads/client";
import { ICON_PATHS } from "../render/icons";
import { iconRefKind } from "../render/tiles-logic";
import { iconWords, PICKER_CATEGORIES, PICKER_ICONS, readRecentIcons, rememberIcon, searchIcons } from "../render/icon-catalogue";

/** One icon reference drawn: a built-in glyph (pkg:<id> draws the package's own), or an uploaded picture. */
export function IconGlyph({ icon, size = 20 }: { icon: string; size?: number }) {
  const k = iconRefKind(icon);
  if (k.kind === "upload") return <img src={k.path} alt="" width={size} height={size} className="object-contain" style={{ width: size, height: size }} />;
  const d = k.kind === "builtin" ? ICON_PATHS[k.name]! : ICON_PATHS.info!;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden data-glyph={k.kind === "builtin" ? k.name : k.kind}>
      {d.map((p, i) => (
        <path key={i} d={p} />
      ))}
    </svg>
  );
}

/** The words for an icon reference: its name, "Your picture", or the package it is the glyph of. */
export function iconRefWords(icon: string): string {
  const k = iconRefKind(icon);
  if (k.kind === "upload") return "Your picture";
  if (k.kind === "builtin") return icon.startsWith("pkg:") ? `${iconWords(k.name)} (service)` : iconWords(k.name);
  return icon ? `${icon} (not found)` : "";
}

const chipCls = (on: boolean) => `inline-flex min-h-8 items-center border px-2 type-caption touch:min-h-11 ${on ? "border-fg bg-fg text-bg" : "border-line-strong text-fg hover:bg-bg-sunk"}`;
const cellCls = (on: boolean) => `flex h-10 w-10 items-center justify-center border text-fg touch:h-11 touch:w-11 ${on ? "border-accent-ink bg-bg-sunk outline outline-1 outline-accent-ink" : "border-transparent hover:border-line-strong hover:bg-bg-sunk"} focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-ink`;

export type IconPickerProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  value: string;
  onPick(ref: string): void;
  /** Offer "No icon" (the field draws two letters from the name instead). */
  noneLabel?: string;
  onNone?(): void;
  /** N4 hook: "From website" goes here, beside Upload. */
  extraEntries?: ReactNode;
};

export function IconPicker({ open, onOpenChange, value, onPick, noneLabel, onNone, extraEntries }: IconPickerProps) {
  const reduced = useReducedMotion();
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<string>("all");
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    if (open) {
      setRecent(readRecentIcons().filter((r) => iconRefKind(r).kind !== "unknown"));
      setQuery("");
    }
  }, [open]);
  // Typing searches every icon, whatever category is chosen.
  const pool = useMemo(() => (cat === "all" || query.trim() ? PICKER_ICONS : PICKER_CATEGORIES.find((c) => c.id === cat)?.names ?? PICKER_ICONS), [cat, query]);
  const shown = useMemo(() => searchIcons(query, pool), [query, pool]);
  const current = iconRefKind(value);
  const currentName = current.kind === "builtin" ? current.name : "";
  const pick = (ref: string) => {
    rememberIcon(ref);
    onPick(ref);
    onOpenChange(false);
  };
  const cell = (n: string, where: string) => (
    <button key={`${where}-${n}`} type="button" className={cellCls(n === currentName || n === value)} title={iconWords(n)} aria-label={iconWords(n)} aria-pressed={n === currentName || n === value} data-icon-choice={n} onClick={() => pick(n)}>
      <IconGlyph icon={n} size={22} />
    </button>
  );
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Choose an icon" name="icon-picker" width={560} description={`${PICKER_ICONS.length} icons, or your own picture.`}>
      <div className="flex flex-col gap-3" data-icon-picker data-motion={reduced ? "none" : "sheet"}>
        <input
          type="search"
          // Focus the search on a pointer screen; on touch it would pop the keyboard over the grid.
          autoFocus={typeof window !== "undefined" && !window.matchMedia?.("(pointer: coarse)").matches}
          aria-label="Search icons"
          placeholder="Search: server, light, film..."
          className="w-full border border-line-strong bg-bg-hi px-2 py-1.5 type-body text-fg placeholder:text-fg-3 min-h-9 touch:min-h-11"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-icon-search
        />
        <div className="flex flex-wrap gap-1" role="group" aria-label="Categories">
          <button type="button" className={chipCls(cat === "all")} aria-pressed={cat === "all"} onClick={() => setCat("all")} data-icon-category-all>
            All
          </button>
          {PICKER_CATEGORIES.map((c) => (
            <button key={c.id} type="button" className={chipCls(cat === c.id)} aria-pressed={cat === c.id} onClick={() => setCat(c.id)} data-icon-category={c.id}>
              {c.title}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-start gap-2" data-icon-entries>
          <div className="min-w-0 flex-1" data-icon-upload-entry>
            <MediaField accept="image" label="Upload your own" hint="A small square picture works best" value={current.kind === "upload" ? current.path : undefined} onChange={(p) => pick(p)} />
          </div>
          {extraEntries}
          {onNone ? (
            <Button
              variant="secondary"
              onClick={() => {
                onNone();
                onOpenChange(false);
              }}
              data-icon-none
            >
              {noneLabel ?? "No icon"}
            </Button>
          ) : null}
        </div>
        {recent.length && !query.trim() ? (
          <section className="flex flex-col gap-1" data-icon-recent>
            <h4 className="m-0 type-label text-fg-2">Recent</h4>
            <div className="flex flex-wrap gap-1">
              {recent.map((r) =>
                iconRefKind(r).kind === "upload" ? (
                  <button key={`recent-${r}`} type="button" className={cellCls(r === value)} title="Your picture" aria-label="Your picture" data-icon-choice={r} onClick={() => pick(r)}>
                    <IconGlyph icon={r} size={22} />
                  </button>
                ) : (
                  cell(r, "recent")
                ),
              )}
            </div>
          </section>
        ) : null}
        <section className="flex flex-col gap-1">
          <h4 className="m-0 type-label text-fg-2" data-icon-count>
            {query.trim() ? `${shown.length} found in every category` : cat === "all" ? "All icons" : PICKER_CATEGORIES.find((c) => c.id === cat)?.title}
          </h4>
          {shown.length ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(40px,1fr))] gap-1 touch:grid-cols-[repeat(auto-fill,minmax(44px,1fr))]" data-icon-grid>
              {shown.map((n) => cell(n, "grid"))}
            </div>
          ) : (
            <p className="type-body m-0 text-fg-2" data-icon-empty>
              No icon called &apos;{query.trim()}&apos;. Try another word, or upload your own picture.
            </p>
          )}
        </section>
      </div>
    </Sheet>
  );
}

/**
 * The icon field itself: the current icon drawn with its name, opening the picker. `optional` fields can
 * be emptied (bookmarks then draw two letters from the name).
 */
export function IconPickField({ label, value, onSet, path, optional, hint, reason }: { label: string; value: unknown; onSet(v: string | null): void; path: string; optional?: boolean; hint?: string; reason?: string | null }) {
  const [open, setOpen] = useState(false);
  const icon = typeof value === "string" ? value : "";
  return (
    <div className="flex flex-col gap-1" data-icon-field={path}>
      <span className="type-label text-fg-2" data-field-label>
        {label}
      </span>
      <button type="button" onClick={() => setOpen(true)} className="flex min-h-11 items-center gap-2 border border-line-strong bg-bg-hi px-2 text-left hover:bg-bg-sunk" aria-label={`${label}: ${iconRefWords(icon) || "none"}. Change`} data-icon-pick={path}>
        <span className="flex h-8 w-8 flex-none items-center justify-center border border-line text-fg" data-icon-preview={icon}>
          {icon ? <IconGlyph icon={icon} size={22} /> : <span className="type-caption text-fg-3">Aa</span>}
        </span>
        <span className="min-w-0 flex-1 truncate type-body text-fg">{icon ? iconRefWords(icon) : "Two letters from the name"}</span>
        <span className="type-caption text-accent-ink">Change</span>
      </button>
      {reason ? (
        <p className="type-caption m-0 text-fg-2" data-field-reason>
          {reason}
        </p>
      ) : hint ? (
        <p className="type-caption m-0 text-fg-3" data-field-hint>
          {hint}
        </p>
      ) : null}
      <IconPicker open={open} onOpenChange={setOpen} value={icon} onPick={(r) => onSet(r)} {...(optional ? { onNone: () => onSet(null), noneLabel: "No icon: two letters" } : {})} />
    </div>
  );
}
