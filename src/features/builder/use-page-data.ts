"use client";
// The page's live data for a viewed or previewed app (architecture v3 section 10): the SSE stream from
// integrations' PageDataClient. Signed-in viewers get data sources by name (with their state); guests
// get only server-resolved values ("nodeId:prop").
import { useEffect, useState } from "react";
import type { ShapedData } from "@/core/contracts";
import { PageDataClient, type PageDataSource } from "@/features/data/client";
import type { SourceData } from "@/features/data/types";
import { claimLastValues, forgetOfflineAppData, LAST_PREFIX } from "@/features/pwa/offline";

/** A source on the page whose integration was skipped (see `UnmappedSource` in apps/load). */
export type UnmappedSource = { key: string; packageId: string; message: string; href: string };

/**
 * Scope states for unmapped sources (gauntlet w2-r1 item 2): an "empty" source whose message is "No
 * data: connect <package>" and whose hint is where to add that integration. Components show the empty
 * state with that message, never a binding error or an endless skeleton.
 */
export function unmappedStates(list: UnmappedSource[] | undefined): Record<string, { state: "empty"; error: { code: string; message: string; hint: string } }> {
  return Object.fromEntries((list ?? []).map((u) => [u.key, { state: "empty" as const, error: { code: "unmapped", message: u.message, hint: u.href } }]));
}

export type PageData = {
  data: Record<string, ShapedData | undefined>;
  states: Record<string, Omit<SourceData, "data"> | undefined>;
  guest: Record<string, unknown> | undefined;
  /** A4.2: signed `/api/img` paths for the absolute image URLs the stream sent, keyed by URL. */
  signedUrls: Record<string, string>;
  mode: "connecting" | "stream" | "polling";
};

const LAST_KEY = (t: { appId: string; pageId: string }) => `${LAST_PREFIX}${t.appId}:${t.pageId}`;

/** The last values this browser received for a published page (gauntlet w2-r1 item 4: offline shows them, marked stale). */
function readLast(t: { appId: string; pageId: string }): PageData | null {
  try {
    const raw = window.localStorage.getItem(LAST_KEY(t));
    if (!raw) return null;
    const v = JSON.parse(raw) as Pick<PageData, "data" | "states" | "guest">;
    const states = Object.fromEntries(Object.entries(v.states ?? {}).map(([k, s]) => [k, s ? { ...s, state: "stale" as const } : s]));
    return { data: v.data ?? {}, states: states as PageData["states"], guest: v.guest, signedUrls: {}, mode: "polling" };
  } catch {
    return null;
  }
}

function writeLast(t: { appId: string; pageId: string }, v: PageData): void {
  try {
    const text = JSON.stringify({ data: v.data, states: v.states, guest: v.guest });
    if (text.length < 200_000) window.localStorage.setItem(LAST_KEY(t), text);
  } catch {
    /* storage full or blocked: offline simply shows no values */
  }
}

/**
 * `remember` keeps the last values for offline use (published views only). `owner` names the person
 * viewing ("user:<id>" or "guest:<link id>"): values saved for someone else are wiped before this page
 * reads or writes any (gauntlet w2-r2 item 1). A page without an owner (the offline snapshot) only reads.
 */
export function usePageData(target: { appId: string; pageId: string; draft: boolean } | null, sources: PageDataSource[], enabled = true, opts: { remember?: boolean; owner?: string | null } = {}): PageData {
  const [state, setState] = useState<PageData>({ data: {}, states: {}, guest: undefined, signedUrls: {}, mode: "connecting" });
  // A source's interval is part of the key (Wave 2.9, spec 3.3): a new refresh restarts the stream at that pace.
  const key = target ? `${target.appId}|${target.pageId}|${target.draft}|${sources.map((s) => `${s.key}@${s.refreshSec}`).join(",")}` : "";
  const remember = !!opts.remember && !!target && !target.draft;
  const owner = opts.owner ?? null;
  useEffect(() => {
    if (!remember || !owner || !target || state.mode === "connecting") return;
    const t = window.setTimeout(() => {
      if (navigator.onLine) claimLastValues(owner);
      writeLast(target, state);
    }, 500);
    return () => window.clearTimeout(t);
  }, [remember, owner, key, state]);
  useEffect(() => {
    if (!target || !enabled || typeof window === "undefined" || typeof EventSource === "undefined") return;
    // Online, the person viewing is known: someone else's saved values go before anything is read.
    if (remember && owner && navigator.onLine) claimLastValues(owner);
    const last = remember && !navigator.onLine ? readLast(target) : null;
    setState(last ?? { data: {}, states: {}, guest: undefined, signedUrls: {}, mode: "connecting" });
    const client = new PageDataClient(
      target,
      sources,
      (k, d) => {
        const { data, ...rest } = d;
        // A refresh without data keeps the last value (shown with its failed or stale mark), never blanks it.
        setState((s) => ({ ...s, mode: client.mode, data: { ...s.data, [k]: data ?? s.data[k] }, states: { ...s.states, [k]: rest } }));
      },
      {
        EventSource: EventSource as never,
        // A 401 means this browser's session ended: nothing it kept for offline use may stay.
        fetch: (u) => fetch(u, { credentials: "same-origin" }).then((r) => { if (r.status === 401) void forgetOfflineAppData(); return r; }),
        setInterval: (fn, ms) => window.setInterval(fn, ms),
        clearInterval: (h) => window.clearInterval(h as number),
        setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      },
      (values) => setState((s) => ({ ...s, mode: client.mode, guest: values })),
      (signed) => setState((s) => ({ ...s, signedUrls: { ...s.signedUrls, ...signed } })),
    );
    client.start();
    return () => client.stop();
  }, [key, enabled]);
  return state;
}
