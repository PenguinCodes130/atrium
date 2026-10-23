"use client";
// The app launcher at / (design v4 "The App Launcher"; spec section 3 "Launcher", criteria 1 to 3, 49):
// the greeting, one window per app the user can open, and the "New app" tile for owners and members.
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { Button, EmptyRoom, LightSweep, ROOM_COPY, Screen, SettleItem, Tag, TitleBar, transitionFor, usePageTitle, useReducedMotion } from "@/features/shell";
import { NewAppSheet, type IntegrationOption, type TemplateOption } from "./new-app-sheet";
import { ImportSheet } from "./import-sheet";

export type Tile = {
  id: string;
  slug: string;
  name: string;
  icon?: string;
  tag: "owner only" | "members" | "guest link";
  pageCount: number;
  version: number | null;
  dirty: boolean;
  canEdit: boolean;
  canvas: string;
  accent: string;
};

export type LauncherProps = { firstName: string; instance: string; tiles: Tile[]; canCreate: boolean; templates: TemplateOption[]; integrations: IntegrationOption[] };

export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 18) return "Good afternoon";
  return "Good evening";
}

function useNow(): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

function TileThumb({ tile }: { tile: Tile }) {
  // A4.3: the app icon on its theme's canvas colour until live thumbnails exist (Wave 4).
  return (
    <div className="flex h-[132px] items-center justify-center" style={{ background: tile.canvas }} data-tile-thumb>
      {tile.icon?.startsWith("/uploads/") ? (
        <img src={tile.icon} alt="" className="size-16 object-contain" />
      ) : (
        <span aria-hidden className="flex size-16 items-center justify-center border border-line-strong text-[32px] font-semibold" style={{ background: tile.accent, color: "#15130F" }}>
          {tile.name.trim().charAt(0).toUpperCase() || "A"}
        </span>
      )}
    </div>
  );
}

function AppTile({ tile, index }: { tile: Tile; index: number }) {
  const reduced = useReducedMotion();
  const href = tile.version == null && tile.canEdit ? `/build/${tile.slug}` : `/a/${tile.slug}`;
  return (
    <SettleItem index={index}>
      <motion.a
        href={href}
        className="group block w-full border border-line-strong bg-bg-hi text-fg shadow-window outline-none transition-shadow duration-150 hover:shadow-lifted focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-accent-ink motion-reduce:transition-none"
        whileHover={reduced ? undefined : { x: -4, y: -4 }}
        whileTap={reduced ? undefined : { x: 4, y: 4 }}
        transition={transitionFor("lift", reduced)}
        data-app-tile={tile.slug}
      >
        <TitleBar
          title={`apps / ${tile.slug}`}
          status={tile.dirty ? <span className="inline-flex items-center gap-1.5" data-draft-dot><span aria-hidden className="size-1.5 rounded-full bg-accent" /> draft</span> : undefined}
        />
        <TileThumb tile={tile} />
        <div className="flex flex-col gap-2 border-t border-line-strong p-(--window-pad)">
          <span className="type-title-2" data-tile-name>{tile.name}</span>
          <span className="flex flex-wrap items-center gap-2 font-mono text-[12px] text-fg-2">
            <Tag tone="paper">{tile.tag}</Tag>
            <span data-tile-pages>{tile.pageCount} {tile.pageCount === 1 ? "page" : "pages"}</span>
            <span aria-hidden>·</span>
            <span data-tile-version>{tile.version == null ? "not published" : `v${tile.version}`}</span>
          </span>
        </div>
      </motion.a>
    </SettleItem>
  );
}

export function Launcher({ firstName, instance, tiles, canCreate, templates, integrations }: LauncherProps) {
  usePageTitle("Apps");
  const router = useRouter();
  const now = useNow();
  const [sheet, setSheet] = useState<null | { template?: string }>(null);
  const [importing, setImporting] = useState(false);
  const date = useMemo(() => (now ? now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }) : ""), [now]);
  const greeting = now ? greetingFor(now.getHours()) : "Welcome";
  const reduced = useReducedMotion();
  const c = ROOM_COPY.launcher;
  return (
    <LightSweep>
      {tiles.length === 0 ? (
        <div className="flex flex-1 flex-col" data-launcher-empty>
          <EmptyRoom
            headingLevel={1}
            title={c.title}
            body={c.body}
            actions={
              canCreate ? (
                <>
                  <Button variant="primary" onClick={() => setSheet({})} data-new-app>{c.primary}</Button>
                  <Button variant="secondary" onClick={() => setSheet({ template: "homelab" })} data-start-template>{c.secondary}</Button>
                </>
              ) : undefined
            }
            footer={canCreate ? undefined : <p className="mt-6 type-body text-fg-2">No apps are shared with you yet. Ask the owner to share one.</p>}
          />
        </div>
      ) : (
        <Screen>
          <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 pt-10 pb-8" data-launcher-header>
            <div className="flex min-w-0 flex-col gap-2">
              <h1 className="type-display text-fg" data-greeting suppressHydrationWarning>
                {greeting}, {firstName}.
              </h1>
              <p className="font-mono text-[13px] text-fg-2" data-launcher-meta suppressHydrationWarning>
                {date ? `${date} · ` : ""}{instance}
              </p>
            </div>
            {canCreate && <Button variant="secondary" onClick={() => setImporting(true)} data-import-app>Import an app file</Button>}
          </header>
          {/* One full-width tile per row on a phone; 300px tiles, as many as fit, from 640px (gauntlet w2-r1 item 20).
              The 20px gap fits three tiles in the shared 1024px column, so the left edge stays the sky band's. */}
          <div className="grid grid-cols-1 gap-5 pb-16 sm:grid-cols-[repeat(auto-fill,300px)]" data-launcher-tiles>
            {tiles.map((t, i) => (
              <AppTile key={t.id} tile={t} index={i} />
            ))}
            {canCreate && (
              <SettleItem index={tiles.length}>
                <motion.button
                  type="button"
                  onClick={() => setSheet({})}
                  className="flex h-full min-h-[220px] w-full flex-col items-center justify-center gap-3 border border-dashed border-line-strong bg-transparent text-fg outline-none focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-accent-ink"
                  whileHover={reduced ? undefined : { x: -4, y: -4 }}
                  transition={transitionFor("lift", reduced)}
                  data-new-app-tile
                >
                  <span aria-hidden className="text-[64px] leading-none text-accent-ink">+</span>
                  <span className="type-title-2">New app</span>
                  <span className="type-body text-fg-2">From a template, or blank</span>
                </motion.button>
              </SettleItem>
            )}
          </div>
        </Screen>
      )}
      {sheet && (
        <NewAppSheet
          open
          initialTemplate={sheet.template}
          templates={templates}
          integrations={integrations}
          onClose={() => setSheet(null)}
          onCreated={(slug) => router.push(`/build/${slug}`)}
        />
      )}
      {importing && <ImportSheet open onClose={() => setImporting(false)} onImported={(slug) => router.push(`/build/${slug}`)} />}
    </LightSweep>
  );
}
