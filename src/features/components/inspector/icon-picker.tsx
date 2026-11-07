"use client";
// Wave 2.10b F6: the one visual icon picker every icon field opens (icon, service tile, bookmarks,
// resource bar items). Search, categories, Recent, every built-in icon drawn as itself, and Upload.
// Wave 2.10c N4 (A11.6): "From website" beside Upload takes an address, asks THIS Atrium to fetch that site's
// icon (POST /api/settings/uploads/favicon; the browser never contacts the site), shows the stored icon before
// Use, and says why in words when it cannot, with the grid still there. A service tile with a known address
// (`siteUrl`) offers that service's own icon first, at the top.
// The field shows the current icon drawn (F10 sweep: show, don't name) with its name in words.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, Sheet, useReducedMotion } from "@/features/shell";
import { fetchFavicon, MediaField } from "@/features/uploads/client";
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

/**
 * Round 2 (item 20): an icon taken from a website keeps its site's words ("github.com icon, from the
 * website") in this browser, so the field does not call it "Your picture". Only words, never the site.
 */
const SITE_ICON_KEY = "atrium.siteIcons";
export function rememberSiteIcon(path: string, name: string): void {
  try {
    const cur = JSON.parse(localStorage.getItem(SITE_ICON_KEY) ?? "{}") as Record<string, string>;
    const next: Record<string, string> = Object.create(null);
    for (const [k, v] of Object.entries(cur).slice(-49)) if (typeof v === "string" && k.startsWith("/uploads/")) next[k] = v;
    if (path.startsWith("/uploads/")) next[path] = name.slice(0, 80);
    localStorage.setItem(SITE_ICON_KEY, JSON.stringify(next));
  } catch {
    // Private mode or storage off: the field just says "Your picture".
  }
}
export function siteIconName(path: string): string | null {
  try {
    const cur = JSON.parse(localStorage.getItem(SITE_ICON_KEY) ?? "{}") as Record<string, unknown>;
    const v = Object.prototype.hasOwnProperty.call(cur, path) ? cur[path] : undefined;
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

/** The words for an icon reference: its name, "Your picture" (or its website's name), or the package's glyph. */
export function iconRefWords(icon: string): string {
  const k = iconRefKind(icon);
  if (k.kind === "upload") {
    const site = typeof window !== "undefined" ? siteIconName(k.path) : null;
    return site ? `${site}, from the website` : "Your picture";
  }
  if (k.kind === "builtin") return icon.startsWith("pkg:") ? `${iconWords(k.name)} (service)` : iconWords(k.name);
  return icon ? `${icon} (not found)` : "";
}

const chipCls = (on: boolean) => `inline-flex min-h-8 items-center border px-2 type-caption touch:min-h-11 ${on ? "border-fg bg-fg text-bg" : "border-line-strong text-fg hover:bg-bg-sunk"}`;
const cellCls = (on: boolean) => `flex h-10 w-10 items-center justify-center border text-fg touch:h-11 touch:w-11 ${on ? "border-accent-ink bg-bg-sunk outline outline-1 outline-accent-ink" : "border-transparent hover:border-line-strong hover:bg-bg-sunk"} focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-ink`;

/** The browser gives up on a favicon answer after this (the server stops at 5 s). */
export const FAVICON_ABORT_MS = 8000;
const NO_ANSWER = "Atrium could not fetch that icon. Try again.";

type FetchState = { kind: "idle" } | { kind: "loading"; url: string } | { kind: "ready"; url: string; path: string; name: string } | { kind: "failed"; url: string; message: string };

/** Asks this Atrium for a site's icon; the newest request wins, and closing aborts it. */
function useFavicon() {
  const [state, setState] = useState<FetchState>({ kind: "idle" });
  const ctl = useRef<AbortController | null>(null);
  useEffect(() => () => ctl.current?.abort(), []);
  const run = async (raw: string) => {
    const url = raw.trim();
    ctl.current?.abort();
    if (!url) {
      setState({ kind: "failed", url, message: "Type a website address, such as https://example.com." });
      return;
    }
    const c = new AbortController();
    ctl.current = c;
    const timer = setTimeout(() => c.abort(), FAVICON_ABORT_MS);
    setState({ kind: "loading", url });
    try {
      const r = await fetchFavicon(url, { signal: c.signal });
      if (ctl.current === c) setState({ kind: "ready", url, path: r.path, name: r.name });
    } catch (e) {
      if (ctl.current !== c) return;
      const aborted = (e as { name?: string })?.name === "AbortError";
      setState({ kind: "failed", url, message: aborted ? "That website did not answer within 5 seconds." : e instanceof Error && e.message ? e.message : NO_ANSWER });
    } finally {
      clearTimeout(timer);
    }
  };
  const reset = () => {
    ctl.current?.abort();
    ctl.current = null;
    setState({ kind: "idle" });
  };
  return { state, run, reset };
}

/** The preview square: a spinner while the server fetches, then the stored icon (from /uploads/, never the site). */
function FaviconSquare({ state }: { state: FetchState }) {
  return (
    <span className="flex h-12 w-12 flex-none items-center justify-center border border-line bg-bg-hi text-fg" data-favicon-preview={state.kind}>
      {state.kind === "loading" ? (
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-line-strong border-t-accent-ink motion-reduce:animate-none" role="status" aria-label="Fetching the icon" data-favicon-spinner />
      ) : state.kind === "ready" ? (
        <img src={state.path} alt="" width={32} height={32} className="h-8 w-8 object-contain" data-favicon-img={state.path} />
      ) : (
        <IconGlyph icon="globe" size={22} />
      )}
    </span>
  );
}

/** N4: "From website": an address field, Get icon, the icon shown before Use, or the reason in words. */
export function FromWebsite({ onUse, initialUrl }: { onUse(path: string): void; initialUrl?: string }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(initialUrl ?? "");
  const { state, run, reset } = useFavicon();
  const id = useMemo(() => `fw-${Math.random().toString(36).slice(2, 8)}`, []);
  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)} data-icon-from-website>
        Type its address
      </Button>
    );
  }
  return (
    <form
      className="flex w-full flex-col gap-2 border border-line-strong p-2"
      data-from-website
      onSubmit={(e) => {
        e.preventDefault();
        void run(url);
      }}
    >
      <label htmlFor={id} className="type-label text-fg-2">
        Website address
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={id}
          type="text"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          placeholder="https://plex.example"
          className="min-h-9 min-w-0 flex-1 border border-line-strong bg-bg-hi px-2 py-1.5 type-body text-fg placeholder:text-fg-3 touch:min-h-11"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-describedby={`${id}-msg`}
          aria-invalid={state.kind === "failed" ? true : undefined}
          data-website-url
        />
        <Button type="submit" variant="secondary" disabled={state.kind === "loading"} data-website-fetch>
          Get icon
        </Button>
      </div>
      <div className="flex items-center gap-3">
        <FaviconSquare state={state} />
        <div className="flex min-w-0 flex-1 flex-col gap-1" id={`${id}-msg`} aria-live="polite">
          {state.kind === "idle" ? <p className="type-caption m-0 text-fg-3">Atrium fetches the site&apos;s own icon and keeps a copy. Your browser never visits the site.</p> : null}
          {state.kind === "loading" ? <p className="type-caption m-0 text-fg-2">Fetching the icon, at most 5 seconds.</p> : null}
          {state.kind === "ready" ? <p className="type-body m-0 truncate text-fg" data-favicon-name>{state.name}</p> : null}
          {state.kind === "failed" ? (
            <p className="type-caption m-0 text-[color:var(--bad)]" role="alert" data-favicon-error>
              {state.message} The icons below still work.
            </p>
          ) : null}
        </div>
        {state.kind === "ready" ? (
          <Button onClick={() => { rememberSiteIcon(state.path, state.name); onUse(state.path); }} data-favicon-use>
            Use
          </Button>
        ) : null}
        <Button
          variant="quiet"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          data-favicon-cancel
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** N4: a service tile with a known address offers that service's own icon first. */
function SiteIcon({ siteUrl, onUse }: { siteUrl: string; onUse(path: string): void }) {
  const { state, run } = useFavicon();
  useEffect(() => {
    void run(siteUrl);
    // Fetch once per address the picker opens with (the server answers a repeat from its 7 day store).
  }, [siteUrl]);
  return (
    <section className="flex items-center gap-3 border border-line p-2" data-site-icon={state.kind}>
      <FaviconSquare state={state} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5" aria-live="polite">
        <h4 className="m-0 type-label text-fg-2">This service&apos;s own icon</h4>
        {state.kind === "loading" ? <p className="type-caption m-0 text-fg-3">Fetching it from {hostOf(siteUrl)}...</p> : null}
        {state.kind === "ready" ? <p className="type-caption m-0 truncate text-fg-2">{state.name}</p> : null}
        {state.kind === "failed" ? <p className="type-caption m-0 text-fg-2" data-site-icon-error>{state.message}</p> : null}
      </div>
      {state.kind === "ready" ? (
        <Button onClick={() => { rememberSiteIcon(state.path, state.name); onUse(state.path); }} data-site-icon-use>
          Use
        </Button>
      ) : null}
    </section>
  );
}

function hostOf(u: string): string {
  try {
    return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).host || u;
  } catch {
    return u;
  }
}

/** The tile's address when it is one Atrium can ask about (a typed http or https address). */
export function siteUrlOf(v: unknown): string | undefined {
  return typeof v === "string" && /^https?:\/\/[^\s/]+/i.test(v.trim()) ? v.trim() : undefined;
}

export type IconPickerProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  value: string;
  onPick(ref: string): void;
  /** Offer "No icon" (the field draws two letters from the name instead). */
  noneLabel?: string;
  onNone?(): void;
  /** More entries beside Upload and From website. */
  extraEntries?: ReactNode;
  /** N4: the service's own address (a tile's), whose icon is offered first. */
  siteUrl?: string;
};

export function IconPicker({ open, onOpenChange, value, onPick, noneLabel, onNone, extraEntries, siteUrl }: IconPickerProps) {
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
  // Item 18: the sheet's own box clips (overflow hidden); a focused field near its edge must never scroll it
  // and push the title out of view. The list inside scrolls instead.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    let sheet: HTMLElement | null = null;
    const keep = () => { if (sheet && sheet.scrollTop) sheet.scrollTop = 0; };
    const t = setTimeout(() => {
      sheet = rootRef.current?.closest<HTMLElement>("[data-sheet]") ?? null;
      sheet?.addEventListener("scroll", keep);
      keep();
    }, 0);
    return () => { clearTimeout(t); sheet?.removeEventListener("scroll", keep); };
  }, [open]);
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
      <div ref={rootRef} className="flex flex-col gap-3" data-icon-picker data-motion={reduced ? "none" : "sheet"}>
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
        {open && siteUrl ? <SiteIcon siteUrl={siteUrl} onUse={(p) => pick(p)} /> : null}
        {/* Round 2 (item 20): the ways to an icon of your own read as peers, each on its own row. */}
        <div className="flex flex-col gap-2" data-icon-entries>
          <section className="flex flex-col gap-1 border border-line p-2" data-icon-website-entry>
            <h4 className="m-0 type-label text-fg-2">From a website</h4>
            <FromWebsite key={open ? "open" : "closed"} onUse={(p) => pick(p)} {...(siteUrl ? { initialUrl: siteUrl } : {})} />
          </section>
          <section className="min-w-0 border border-line p-2" data-icon-upload-entry>
            <MediaField accept="image" label="Upload your own" hint="A small square picture works best" value={current.kind === "upload" ? current.path : undefined} onChange={(p) => pick(p)} />
          </section>
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
              No icon called &apos;{query.trim()}&apos;. Try From website or Upload.
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
export function IconPickField({ label, value, onSet, path, optional, hint, reason, siteUrl }: { label: string; value: unknown; onSet(v: string | null): void; path: string; optional?: boolean; hint?: string; reason?: string | null; /** N4: a tile's own address, whose icon is offered first. */ siteUrl?: string }) {
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
      <IconPicker open={open} onOpenChange={setOpen} value={icon} onPick={(r) => onSet(r)} {...(siteUrl ? { siteUrl } : {})} {...(optional ? { onNone: () => onSet(null), noneLabel: "No icon: two letters" } : {})} />
    </div>
  );
}
