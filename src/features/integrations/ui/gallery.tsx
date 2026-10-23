"use client";
// "Add integration": a URL box that runs detection, a searchable gallery of the eight official
// packages with Custom API last, an OpenAPI tick list, and the by-example way out.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { motion } from "motion/react";
import type { EndpointSummary } from "@/core/contracts";
import { Button, Window, SearchIcon, transitionFor, usePageTitle, useReducedMotion } from "@/features/shell";
import type { PackageCard } from "../service";
import { api, ApiFailure, ErrorCallout, Input, Spinner, urlInputProps, type ApiError } from "./common";
import { PackageIcon } from "./package-icon";

type Detected = { url: string; matches: string[]; openapi?: EndpointSummary[]; openapiUrl?: string; error?: ApiError };

function prefillFor(id: string, url: string): string {
  const u = new URL(url);
  if (id === "docker") return `?endpoint=${encodeURIComponent(`tcp://${u.host}`)}`;
  const base = id === "rss" ? url : u.origin;
  return `?baseUrl=${encodeURIComponent(base)}`;
}

/**
 * One gallery tile (design v4, premium-feel r2): a flat paper tile with the hard window shadow, a
 * 32px icon in a 48px sunk square, the name at title-3 and one line of body text. Hover lifts it
 * (shadow-lifted, translate -4px with the lift spring); pressing presses it. Reduced motion: no move.
 */
function GalleryTile({ p, href, hit, canEdit }: { p: PackageCard; href: string; hit: boolean; canEdit: boolean }) {
  const reduced = useReducedMotion();
  const [state, setState] = useState<"rest" | "hover" | "press">("rest");
  const shadow = state === "hover" ? "shadow-lifted" : state === "press" ? "shadow-pressed" : "shadow-window";
  const offset = reduced ? 0 : state === "hover" ? -4 : state === "press" ? 4 : 0;
  return (
    <motion.div
      className={`h-full border bg-bg-hi ${hit ? "border-2 border-accent" : "border-line-strong"} ${shadow}`}
      animate={{ x: offset, y: offset }}
      transition={transitionFor(state === "press" ? "press" : "lift", reduced)}
      onHoverStart={() => canEdit && setState("hover")}
      onHoverEnd={() => setState("rest")}
      onTapStart={() => canEdit && setState("press")}
      onTap={() => setState("hover")}
      onTapCancel={() => setState("rest")}
      data-tile-state={state}
    >
      <Link href={canEdit ? href : "#"} aria-disabled={!canEdit} className={`flex h-full min-h-24 items-center gap-4 p-4 ${canEdit ? "" : "pointer-events-none"}`}>
        <span className="flex size-12 flex-none items-center justify-center bg-bg-sunk"><PackageIcon id={p.id} size={32} /></span>
        <span className="min-w-0 flex-1">
          <span className="block type-title-3 text-fg">{p.name}</span>
          {/* Premium r3: the whole description, wrapped; no ellipsis on any tile. */}
          <span className="block type-body text-pretty text-fg-2" data-tile-description>{p.description}</span>
          {hit && <span className="mt-1 block type-label text-accent-ink" data-match-note>Matches the address you pasted</span>}
        </span>
      </Link>
    </motion.div>
  );
}

export function AddIntegration({ packages, canEdit, embedded = false }: { packages: PackageCard[]; canEdit: boolean; embedded?: boolean }) {
  usePageTitle(embedded ? "Integrations" : "Add integration");
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Detected | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [ticked, setTicked] = useState<Set<number>>(new Set());

  const shown = useMemo(() => packages.filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase())), [packages, query]);
  const matched = new Set(result?.matches ?? []);
  const noMatch = result && result.matches.length === 0 && !result.openapi?.length;

  async function runDetect(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() || busy) return;
    setBusy(true);
    setFailure(null);
    setResult(null);
    setTicked(new Set());
    try {
      setResult(await api<Detected>("/api/integrations/detect", { body: { url } }));
    } catch (err) {
      setFailure(err instanceof ApiFailure ? err.error : { code: "unreachable", message: "Detection did not finish." });
    } finally {
      setBusy(false);
    }
  }

  function addTicked() {
    if (!result?.openapi) return;
    const chosen = result.openapi.filter((_, i) => ticked.has(i));
    const origin = new URL(result.url).origin;
    const q = new URLSearchParams({ url: `${origin}${chosen[0]?.path ?? ""}`, queue: JSON.stringify(chosen.map((c) => ({ method: c.method, path: c.path, summary: c.summary ?? "", shape: c.suggestedShape ?? "" }))) });
    router.push(`/integrations/new/by-example?${q.toString()}`);
  }

  return (
    <div className="flex flex-col gap-8" data-add-integration>
      {canEdit && (
        <Window title="integrations / new / detect" padded={false}>
          <form onSubmit={runDetect} className="flex flex-col gap-2 p-5 max-sm:p-4" aria-label="Detect a service">
            <label htmlFor="detect-url" className="type-callout text-fg">Paste a service URL and Atrium will try to recognise it</label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input id="detect-url" name="url" {...urlInputProps} placeholder="http://10.0.0.7:9090" value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy} autoComplete="off" />
              <Button type="submit" variant="secondary" disabled={busy || !url.trim()} aria-busy={busy} data-detect-button>
                {busy && <Spinner label="Detecting" />} Detect
              </Button>
            </div>
          </form>
        </Window>
      )}

      {failure && <ErrorCallout error={failure} />}
      {result?.error && <ErrorCallout error={result.error} />}
      {result && result.matches.length > 0 && (
        // A match gets the same weight as no-match: its own panel with one clear next step.
        <Window role="status" className="border-2 border-accent" title="integrations / detected" padded={false} data-detect-match>
          <div className="flex flex-col gap-3 p-4">
          {result.matches.map((m) => {
            const p = packages.find((x) => x.id === m);
            const name = p?.name ?? m;
            return (
              <div key={m} className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between" data-detect-result={m}>
                <div className="flex min-w-0 items-center gap-3">
                  <PackageIcon id={m} />
                  <p className="min-w-0 type-body text-fg">This looks like <span className="type-callout">{name}</span> at <span className="break-all font-mono">{new URL(result.url).origin}</span></p>
                </div>
                {canEdit && <Button variant="primary" href={`/integrations/new/${m}${prefillFor(m, result.url)}`} data-detect-setup={m}>Set up {name}</Button>}
              </div>
            );
          })}
        </div></Window>
      )}
      {noMatch && !result?.error && (
        <Window title="integrations / no match" padded={false} data-no-match>
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="type-body text-fg">No known app or API spec found here</p>
          <Button variant="secondary" href={`/integrations/new/by-example?url=${encodeURIComponent(result.url)}`}>Set it up by example</Button>
        </div></Window>
      )}
      {result?.error && canEdit && (
        <div><Button variant="quiet" href={`/integrations/new/by-example?url=${encodeURIComponent(result.url)}`}>Set it up by example</Button></div>
      )}

      {result?.openapi && result.openapi.length > 0 && (
        <Window as="section" title="integrations / openapi" padded={false} aria-labelledby="openapi-title" data-openapi>
          <div className="flex flex-col gap-3 p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between" data-openapi-import>
            <div className="min-w-0">
              <h2 id="openapi-title" className="type-title-3 text-fg">API spec found: {result.openapi.length} read{result.openapi.length === 1 ? "" : "s"}</h2>
              <p className="type-caption text-glass-muted">Import them all, named, grouped and checked on your server, or tick a few to set up by example.</p>
            </div>
            {canEdit && result.openapiUrl && <Button variant="primary" href={`/integrations/new/by-example?${new URLSearchParams({ url: result.url, spec: result.openapiUrl }).toString()}`} data-openapi-import-button>Import from this spec</Button>}
          </div>
          <ul className="flex max-h-96 flex-col gap-1 overflow-y-auto">
            {result.openapi.map((e, i) => (
              <li key={`${e.method}${e.path}`}>
                <label className="flex cursor-pointer items-start gap-3 rounded-sm p-2 hover:bg-line">
                  <input type="checkbox" className="mt-1 h-4 w-4" checked={ticked.has(i)} onChange={(ev) => setTicked((s) => { const n = new Set(s); if (ev.target.checked) n.add(i); else n.delete(i); return n; })} data-openapi-endpoint={`${e.method} ${e.path}`} />
                  <span className="min-w-0">
                    <span className="type-callout font-mono text-fg">{e.method} {e.path}</span>
                    {e.summary && <span className="block type-caption text-glass-muted">{e.summary}</span>}
                    {e.suggestedShape && <span className="block type-caption text-glass-muted">Suggested shape: {e.suggestedShape}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div><Button variant="primary" disabled={ticked.size === 0} onClick={addTicked}>Add {ticked.size || ""} ticked endpoint{ticked.size === 1 ? "" : "s"}</Button></div>
        </div></Window>
      )}

      <section aria-labelledby="gallery-title" className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h2 id="gallery-title" className="type-title-3 text-fg">Apps Atrium knows</h2>
          <div className="relative sm:w-64">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-glass-muted"><SearchIcon width={16} height={16} aria-hidden /></span>
            <Input aria-label="Search apps" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-9" data-gallery-search />
          </div>
        </div>
        <ul className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3" data-gallery>
          {shown.map((p) => {
            const hit = matched.has(p.id);
            const href = p.id === "custom-api" ? `/integrations/new/by-example${result ? `?url=${encodeURIComponent(result.url)}` : ""}` : `/integrations/new/${p.id}${hit && result ? prefillFor(p.id, result.url) : ""}`;
            return (
              <li key={p.id} data-gallery-card={p.id} data-match={hit ? "true" : undefined}>
                <GalleryTile p={p} href={href} hit={hit} canEdit={canEdit} />
              </li>
            );
          })}
        </ul>
        {shown.length === 0 && <p className="type-body text-glass-muted">No app called that. Try Custom API.</p>}
      </section>
    </div>
  );
}
