"use client";
// Wave 2.9 components (architecture Amendment 10, A10.7; direct data spec 3.5 and 3.6): the service tile,
// the group, the resource bar and bookmarks. They read only --theme-* tokens (components.css), so each
// app theme decides their look. Status is never colour alone: the badge says it in words. The tile's
// integrationId is a builder reference and is never rendered.
import { useEffect, useId, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { ComponentNode, RenderContext, ValueFormat } from "@/core/contracts";
import { transitionFor, useReducedMotion } from "@/features/shell";
import { text as textOf } from "../bindings";
import { useNodeEnv } from "./context";
import { StateMarks } from "./states";
import { ICON_PATHS } from "./icons";
import { isValueFormat, templateFormat } from "./format";
import { domainOf, iconRefKind, initials, percentOf, SAFE_HREF, searchHref, statText, statusBadge } from "./tiles-logic";
import { DEFAULT_SEARCH_URL } from "../catalogue/schemas";
import type { PageScope } from "./resolve";

type P = { node: ComponentNode; resolved: Record<string, unknown>; ctx: RenderContext };
const str = (v: unknown) => textOf(v ?? "");

/** An icon reference drawn: a built-in glyph, an uploaded picture, or a neutral box for anything else. */
export function TileIcon({ icon, size = 28, letters }: { icon: string; size?: number; letters?: string }) {
  const k = iconRefKind(icon);
  if (k.kind === "upload") return <img src={k.path} alt="" width={size} height={size} className="atr-tile-img" loading="lazy" decoding="async" />;
  if (k.kind === "unknown" && letters) return <span className="atr-letters" aria-hidden>{letters}</span>;
  const d = k.kind === "builtin" ? ICON_PATHS[k.name]! : ICON_PATHS.server!;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden data-icon={k.kind === "builtin" ? k.name : "unknown"}>
      {d.map((p, i) => (
        <path key={i} d={p} />
      ))}
    </svg>
  );
}

/** The format a nested binding reads (A8.4), when its data says, so "{{ d_x.value }}" of a percent read shows "7.8 %". */
function nestedFormat(v: unknown, scope: PageScope): ValueFormat | null {
  return v && typeof v === "object" && !Array.isArray(v) && typeof (v as { $bind?: unknown }).$bind === "string" ? templateFormat((v as { $bind: string }).$bind, scope as never) : null;
}

// ---------- service tile ----------

export function ServiceTileView({ node, resolved, ctx }: P) {
  const { status, scope } = useNodeEnv();
  const edit = ctx.mode === "edit";
  const name = str(resolved.name) || "Service";
  const description = str(resolved.description);
  const href = str(resolved.href).trim();
  const safe = href && SAFE_HREF.test(href) ? href : "";
  const newTab = resolved.newTab !== false;
  const badge = statusBadge(resolved.status);
  const down = badge?.state === "down";
  const rawStats = (Array.isArray(node.props.stats) ? node.props.stats : []) as Record<string, unknown>[];
  const stats = (Array.isArray(resolved.stats) ? resolved.stats : []).slice(0, 4) as { label?: unknown; value?: unknown; format?: unknown }[];
  const loading = status.kind === "loading";
  const icon = typeof resolved.icon === "string" && resolved.icon ? resolved.icon : "server";
  const body = (
    <>
      <div className="atr-tile-head">
        <span data-slot="icon" className="atr-tile-icon">
          <TileIcon icon={icon} size={30} />
        </span>
        <span className="atr-tile-text">
          <span data-slot="name" className="atr-tile-name">{name}</span>
          {description ? <span data-slot="description" className="atr-tile-desc">{description}</span> : null}
        </span>
        <span className="atr-tile-side">
          <StateMarks status={status} />
          {badge ? (
            <span data-slot="badge" className="atr-badge" data-tone={badge.tone} data-badge-state={badge.state} title={badge.detail ? `${badge.word}: ${badge.detail}` : badge.word}>
              <span aria-hidden className="atr-badge-dot" />
              <span aria-hidden>{badge.word}</span>
              <span className="sr-only">{badge.spoken}</span>
            </span>
          ) : loading && node.props.status !== undefined ? (
            <span className="atr-badge atr-badge-wait" data-badge-state="loading" aria-label="Status loading">
              <span aria-hidden className="atr-badge-dot" />
            </span>
          ) : null}
        </span>
      </div>
      {stats.length ? (
        <dl className="atr-tile-stats" style={{ gridTemplateColumns: `repeat(${stats.length}, minmax(0, 1fr))` }} data-down={down ? "" : undefined}>
          {stats.map((s, i) => {
            const fmt = isValueFormat(s.format) ? s.format : nestedFormat(rawStats[i]?.value, scope);
            const t = statText(s.value, fmt);
            const empty = !t.text;
            return (
              <div key={i} data-slot="stat" className="atr-tile-stat" data-stat-index={i}>
                <dd data-stat-value>
                  {empty ? <span className={loading ? "atr-placeholder" : "atr-dash"} aria-label={loading ? "loading" : "no value"}>{loading ? "" : "–"}</span> : (
                    <>
                      {t.text}
                      {t.unit ? <small>{t.unit === "%" ? "%" : ` ${t.unit}`}</small> : null}
                    </>
                  )}
                </dd>
                <dt>{str(s.label)}</dt>
              </div>
            );
          })}
        </dl>
      ) : null}
    </>
  );
  const cls = "atr-tile canvas-surface";
  const common = { "data-slot": "root", "data-down": down ? "" : undefined, "data-status": status.kind } as const;
  if (safe) {
    return (
      <a
        {...common}
        className={`${cls} atr-tile-link`}
        href={safe}
        {...(newTab ? { target: "_blank" } : {})}
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        aria-label={`${name}${description ? `, ${description}` : ""}${badge ? `, ${badge.spoken}` : ""}${newTab ? " (opens in a new tab)" : ""}`}
        onClick={edit ? (e) => e.preventDefault() : undefined}
        data-tile-href={safe}
      >
        {body}
      </a>
    );
  }
  return (
    <div {...common} className={cls} role="group" aria-label={name}>
      {body}
    </div>
  );
}

// ---------- group ----------

export function GroupView({ node, resolved, ctx }: P) {
  const env = useNodeEnv();
  const reduced = useReducedMotion();
  const title = str(resolved.title);
  const cols = env.device === "mobile" ? 1 : Math.min(6, Math.max(1, typeof resolved.columns === "number" ? Math.round(resolved.columns) : 4));
  const collapsible = resolved.collapsible === true;
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  const edit = ctx.mode === "edit";
  const children = node.children ?? [];
  const shown = !collapsible || open;
  return (
    <section data-slot="root" className="atr-group" data-columns={cols} aria-label={title || undefined}>
      {title || collapsible ? (
        <header className="atr-group-head">
          {title ? <h2 data-slot="title" className="atr-group-title">{title}</h2> : <span />}
          {collapsible ? (
            <button
              type="button"
              className="atr-group-fold"
              aria-expanded={open}
              aria-controls={bodyId}
              data-group-fold
              onClick={(e) => {
                e.stopPropagation();
                setOpen((o) => !o);
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden style={{ transform: open ? "rotate(90deg)" : "none", transition: reduced ? "none" : "transform 160ms" }}>
                <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" />
              </svg>
              <span className="sr-only">{open ? `Fold ${title || "group"}` : `Show ${title || "group"}`}</span>
            </button>
          ) : null}
        </header>
      ) : null}
      <AnimatePresence initial={false}>
        {shown ? (
          <motion.div
            key="body"
            id={bodyId}
            data-slot="body"
            className="atr-group-body"
            data-group-body={node.id}
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={transitionFor("settle", reduced)}
          >
            {children.map((c, i) => (
              <div key={c.id} className="atr-group-item" data-group-item={c.id} data-group-index={i}>
                {env.renderChild(c)}
              </div>
            ))}
            {!children.length && edit ? <p className="atr-group-empty" data-group-empty>Drag tiles here</p> : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}

// ---------- resource bar ----------

function useClock(on: boolean, seconds: boolean): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    if (!on) return;
    setNow(new Date());
    const h = setInterval(() => setNow(new Date()), seconds ? 1000 : 15_000);
    return () => clearInterval(h);
  }, [on, seconds]);
  return now;
}

export function clockText(now: Date, format: string): string {
  const hour12 = format.endsWith("12h");
  const time = now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", ...(format === "time-seconds" ? { second: "2-digit" } : {}), hour12 });
  if (format.startsWith("date-time")) return `${now.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}, ${time}`;
  return time;
}

const SAMPLE_BAR = [
  { icon: "cpu", label: "CPU", value: 12.4, percent: 12.4, format: "percent" },
  { icon: "memory", label: "Free", value: 21.4 * 1024 ** 3, percent: 62, format: "bytes" },
  { icon: "disk", label: "Free", value: 412 * 1024 ** 3, percent: 41, format: "bytes" },
] as const;

export function ResourceBarView({ node, resolved, ctx }: P) {
  const { status, scope } = useNodeEnv();
  const edit = ctx.mode === "edit";
  const raw = (Array.isArray(node.props.items) ? node.props.items : []) as Record<string, unknown>[];
  const given = (Array.isArray(resolved.items) ? resolved.items : []).slice(0, 8) as { icon?: unknown; label?: unknown; value?: unknown; percent?: unknown; format?: unknown }[];
  // A new bar shows sample readings while editing, marked as samples; viewers see only the clock and search.
  const sample = edit && !given.length;
  const items = sample ? (SAMPLE_BAR as unknown as typeof given) : given;
  const clockFormat = typeof resolved.clockFormat === "string" ? resolved.clockFormat : "date-time";
  const now = useClock(resolved.clock === true, clockFormat === "time-seconds");
  const template = typeof resolved.searchUrl === "string" && resolved.searchUrl ? resolved.searchUrl : DEFAULT_SEARCH_URL;
  const [q, setQ] = useState("");
  const loading = status.kind === "loading";
  return (
    <section data-slot="root" className="atr-bar canvas-surface" data-status={status.kind} data-sample-bar-items={sample ? "" : undefined} aria-label="Resources">
      <StateMarks status={status} />
      <ul className="atr-bar-items" data-count={items.length}>
        {items.map((it, i) => {
          const fmt = isValueFormat(it.format) ? it.format : nestedFormat(raw[i]?.value, scope);
          const t = statText(it.value, fmt);
          const pct = percentOf(it.percent);
          const label = str(it.label);
          return (
            <li key={i} data-slot="item" className="atr-bar-item" data-bar-index={i}>
              <span className="atr-bar-icon">
                <TileIcon icon={typeof it.icon === "string" && it.icon ? it.icon : "info"} size={18} />
              </span>
              <span className="atr-bar-text">
                <span className="atr-bar-line">
                  <span data-slot="value" className="atr-bar-value" data-bar-value>
                    {t.text ? `${t.text}${t.unit ? (t.unit === "%" ? "%" : ` ${t.unit}`) : ""}` : <span className={loading ? "atr-placeholder" : "atr-dash"}>{loading ? "" : "–"}</span>}
                  </span>
                  <span data-slot="label" className="atr-bar-label">{label}</span>
                </span>
                {pct !== null ? (
                  <span data-slot="bar" className="atr-bar-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={`${label || "Value"} ${Math.round(pct)} percent`}>
                    <span className="atr-bar-fill" style={{ transform: `scaleX(${pct / 100})` }} data-level={pct >= 90 ? "bad" : pct >= 75 ? "warn" : "ok"} />
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
        {sample ? <li className="atr-sample-note" data-bar-sample>Sample readings: add your own in the inspector</li> : null}
      </ul>
      {resolved.clock === true || resolved.search === true ? (
        <div className="atr-bar-end">
          {resolved.clock === true ? (
            <time data-slot="clock" className="atr-bar-clock" dateTime={now?.toISOString()} data-bar-clock>
              {now ? clockText(now, clockFormat) : "--:--"}
            </time>
          ) : null}
          {resolved.search === true ? (
            <form
              role="search"
              data-slot="search"
              className="atr-bar-search"
              onSubmit={(e) => {
                e.preventDefault();
                if (edit) return;
                const url = searchHref(template, q);
                if (url) window.open(url, "_blank", "noopener,noreferrer");
              }}
            >
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search the web" data-bar-search-input />
              <button type="submit" aria-label="Search" data-bar-search-go>
                <TileIcon icon="search" size={16} />
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// ---------- bookmarks ----------

export function BookmarksView({ resolved, ctx }: P) {
  const env = useNodeEnv();
  const edit = ctx.mode === "edit";
  const items = (Array.isArray(resolved.items) ? resolved.items : []).slice(0, 50) as { name?: unknown; href?: unknown; icon?: unknown }[];
  const cols = env.device === "mobile" ? 1 : Math.min(6, Math.max(1, typeof resolved.columns === "number" ? Math.round(resolved.columns) : 1));
  if (!items.length) return <div data-slot="root" className="atr-bookmarks atr-muted" data-bookmarks-empty>{edit ? "Add bookmarks in the inspector." : null}</div>;
  return (
    <ul data-slot="root" className="atr-bookmarks" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }} aria-label="Bookmarks">
      {items.map((b, i) => {
        const name = str(b.name) || "Bookmark";
        const href = str(b.href).trim();
        const domain = domainOf(href);
        const icon = typeof b.icon === "string" && b.icon.trim() ? b.icon : "";
        const inner: ReactNode = (
          <>
            <span className="atr-bookmark-mark" aria-hidden>
              {icon ? <TileIcon icon={icon} size={16} letters={initials(name)} /> : <span className="atr-letters">{initials(name)}</span>}
            </span>
            <span data-slot="name" className="atr-bookmark-name">{name}</span>
            <span data-slot="domain" className="atr-bookmark-domain">{domain}</span>
          </>
        );
        return (
          <li key={i} data-slot="item" data-bookmark={i}>
            {domain ? (
              <a className="atr-bookmark" href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" onClick={edit ? (e) => e.preventDefault() : undefined}>
                {inner}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            ) : (
              <span className="atr-bookmark atr-bookmark-inert" aria-disabled="true" data-inert-link title={href ? "This address was refused: only http and https open." : undefined}>
                {inner}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
