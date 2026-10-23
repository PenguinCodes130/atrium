"use client";
// One integration: its connection settings and credentials, its endpoints with a live preview
// through the shared cache, and the actions the caller's role allows.
// Round 6 (Fix List r3 items 2 and 5): after a save the connection form and every endpoint preview
// start again from the saved state (no reload needed); endpoints are one full-width column with a
// real Preview button; the shape reads as words ("Big number"), not "(stat)".
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button, Screen, ScreenHeader, Sheet, Window, usePageTitle, toast } from "@/features/shell";
import { DataStateBadge, ShapedPreview } from "@/features/data/ui";
import type { WidgetData } from "@/features/data/types";
import type { IntegrationView, PackageCard } from "../service";
import { api, ApiFailure, Chevron, ErrorCallout, Field, HealthLine, Input, integrationPath, LockedNotice, slugOf, Spinner, UntestedBadge, type ApiError } from "./common";
import { ConnectionForm } from "./setup-form";
import { CommandsPanel, SharingPanel, type CommandsData, type SharingData } from "./commands";
import type { PickableCredential } from "./credential-picker";
import { ParamInput, type ParamProp } from "./param-input";
import { RecipesPanel } from "./recipes";

type Endpoint = { id: string; label: string; description: string; shape: string; defaultRefreshSec: number; minRefreshSec: number; params?: Record<string, unknown>; method?: string; path?: string; group?: string; advanced?: boolean; needs?: string; from?: string };
type ReadCheck = { status: "ok" | "empty" | "failed" | "odd"; reason?: string; at: string };
/** What a page will draw, in words (usability r3: "(stat)" was jargon). */
const SHAPE_SHOWN: Record<string, string> = { stat: "Big number", series: "Chart over time", table: "Table", status: "Up and down list" };

/**
 * Changes whenever what the page shows was saved anew: the integration's config, health, secrets
 * and the lock lists of the credentials it can pick. Keys the form and previews so a router.refresh
 * after "Save" or "Save and test" remounts them from the saved state (usability r3 medium).
 */
export function savedVersion(integration: IntegrationView, credentials: PickableCredential[]): string {
  return JSON.stringify([integration.config, integration.status, integration.lastHealth?.checkedAt ?? null, integration.secretFields.map((f) => [f.key, f.set, f.updatedAt ?? null, f.credential?.id ?? null]), credentials.map((c) => [c.id, c.lockedOrigins])]);
}

type Prop = ParamProp;

function EndpointPreview({ integrationId, e, cachedOnly, path, readable = true, check }: { integrationId: string; e: Endpoint; cachedOnly: boolean; path: string; readable?: boolean; check?: ReadCheck | undefined }) {
  const props = ((e.params as { properties?: Record<string, Prop> } | undefined)?.properties ?? {}) as Record<string, Prop>;
  const required = ((e.params as { required?: string[] } | undefined)?.required ?? []) as string[];
  const [params, setParams] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(props).map(([k, p]) => [k, p.default !== undefined ? String(p.default) : ""])));
  const [data, setData] = useState<WidgetData | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const ready = required.every((k) => params[k]?.trim());
  const missing = required.filter((k) => !params[k]?.trim()).map((k) => props[k]?.title ?? k);
  const why = missing.length === 0 ? "" : missing.some((m) => /query/i.test(m)) ? "Type a query to preview" : `Fill in ${missing.join(" and ")} to preview`;

  const load = useCallback(async (cached: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const p = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== "").map(([k, v]) => [k, props[k]?.type === "number" ? Number(v) : v]));
      const q = new URLSearchParams({ integration: integrationId, endpoint: e.id, ...(Object.keys(p).length ? { params: JSON.stringify(p) } : {}), ...(cached ? { cached: "1" } : {}) });
      setData(await api<WidgetData>(`/api/data/endpoint?${q.toString()}`));
    } catch (x) {
      setErr(x instanceof ApiFailure ? x.error : { code: "internal", message: "The preview failed." });
    } finally {
      setBusy(false);
    }
    // params change on every keystroke; previews run on demand
  }, [integrationId, e.id, params]);

  // Load once on mount; later previews run when the user asks.
  useEffect(() => { if (ready && readable) void load(cachedOnly); }, []);

  return (
    <Window as="li" title={`${path} / ${slugOf(e.id)}`} padded={false} data-endpoint={e.id} data-endpoint-state={data?.state}>
      <div className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="type-callout text-fg">{e.label} <span className="type-caption text-glass-muted" data-endpoint-shape={e.shape}>{SHAPE_SHOWN[e.shape] ?? e.shape}</span></p>
          <p className="type-caption text-glass-muted">{e.method ? <span className="font-mono">{e.method} {e.path}</span> : e.description}</p>
          {e.from && <p className="type-caption text-glass-muted" data-endpoint-from>{e.from}</p>}
          {check && check.status !== "ok" && <p className={`type-caption ${check.status === "failed" ? "text-danger" : "text-fg-2"}`} data-endpoint-check={check.status}>{check.status === "failed" ? "Did not work on this server" : check.status === "empty" ? "Empty on this server" : "Looks odd"}{check.reason ? `: ${check.reason}` : ""}</p>}
        </div>
        {data && <DataStateBadge data={data} />}
      </div>
      {Object.keys(props).length > 0 && (
        <div className="flex flex-col gap-2">
          {Object.entries(props).map(([k, p]) => (
            <div key={k} className="flex flex-col gap-2">
              <Field label={p.title ?? k} htmlFor={`p-${e.id}-${k}`}>
                <ParamInput id={`p-${e.id}-${k}`} k={k} p={p} value={params[k] ?? ""} onChange={(v) => setParams((x) => ({ ...x, [k]: v }))} integrationId={integrationId} endpointId={e.id} all={params} />
              </Field>
              {p.examples && p.examples.length > 0 && (
                <div className="flex flex-wrap items-center gap-1" data-param-examples={k}>
                  <span className="type-caption text-glass-muted">Try:</span>
                  {p.examples.map((x) => (
                    // Chips wrap instead of cutting the query off, and are at least 44 x 44 on touch (mobile r2).
                    <button key={x} type="button" className="min-h-8 min-w-8 max-w-full border border-line-strong bg-bg-hi px-2 py-1 text-left font-mono type-label break-all whitespace-normal text-fg hover:bg-bg-sunk touch:min-h-11 touch:min-w-11" onClick={() => setParams((v) => ({ ...v, [k]: x }))} title={x} data-example={x}>{x}</button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="min-h-10">
        {data?.data ? <ShapedPreview data={data.data as never} /> : data?.error ? (
          // A failed read says what went wrong; "No data yet" only when there truly is nothing yet.
          <div className="flex flex-col gap-1" data-read-error={data.error.code}>
            <p className="type-callout text-fg">{data.error.message.startsWith("Query error") ? "Query error" : "Could not read this endpoint"}</p>
            <p className="type-body text-fg">{data.error.message.replace(/^Query error: /, "")}</p>
            {data.error.hint && <p className="type-caption text-glass-muted">{data.error.hint}</p>}
          </div>
        ) : data?.state === "empty" ? <p className="type-body text-glass-muted" data-no-data>No data yet</p> : null}
        {err && <ErrorCallout error={err} />}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" onClick={() => void load(false)} disabled={busy || !ready || !readable} aria-busy={busy} aria-describedby={!ready || !readable ? `why-${e.id}` : undefined} data-preview-button>{busy && <Spinner label="Loading" />} Preview</Button>
        {!readable ? <span id={`why-${e.id}`} className="type-caption text-glass-muted" data-preview-why>Previews are for the owner and the person who added it, or when it is shared.</span> : !ready && <span id={`why-${e.id}`} className="type-caption text-glass-muted" data-preview-why>{why}</span>}
      </div>
      {/* Settings r3 shared file request (gauntlet w2-r2 usability): apps exist now, so the next step names where to go. */}
      <p className="type-caption text-glass-muted" data-next-step>Next: use it in an app. In the builder, pick a component and choose this endpoint as its data source.</p>
    </div></Window>
  );
}

/**
 * Wave 2.8: a group made only of imported recipe reads (a Grafana dashboard can add 270) starts
 * folded, and its previews (and their which-thing lists) load only once it is opened.
 */
function FoldedGroup({ name, items, draw }: { name: string; items: Endpoint[]; draw: (e: Endpoint) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="flex flex-col gap-3" data-endpoint-group={name} data-folded={open ? "no" : "yes"}>
      <h3 className="type-label text-fg-2">
        <button type="button" className="flex min-h-11 w-full items-center gap-2 text-left" aria-expanded={open} onClick={() => setOpen((x) => !x)} data-endpoint-group-toggle={name}>
          <Chevron open={open} /> {name} ({items.length})
        </button>
      </h3>
      {open && <ul className="flex flex-col gap-6">{items.map(draw)}</ul>}
    </section>
  );
}

/**
 * Wave 2.7 (A8.1): endpoints under headings in words, the Advanced tier folded, and reads this
 * service has no data for hidden until "Show all reads". Availability comes from the bindable
 * listing (the same answer the builder's picker gets); without it every read shows.
 */
function EndpointGroups({ endpoints, integrationId, render }: { endpoints: Endpoint[]; integrationId: string; render: (e: Endpoint, check?: ReadCheck) => ReactNode }) {
  const [avail, setAvail] = useState<Record<string, boolean>>({});
  const [checks, setChecks] = useState<Record<string, ReadCheck>>({});
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    const ctl = new AbortController();
    api<{ integrations: { integrationId: string; endpoints: { id: string; available: boolean; check?: ReadCheck }[] }[] }>("/api/integrations/bindable", { signal: ctl.signal })
      .then((r) => {
        const mine = r.integrations.find((i) => i.integrationId === integrationId);
        if (mine) {
          setAvail(Object.fromEntries(mine.endpoints.map((e) => [e.id, e.available])));
          setChecks(Object.fromEntries(mine.endpoints.flatMap((e) => (e.check ? [[e.id, e.check] as const] : []))));
        }
      })
      .catch(() => undefined);
    return () => ctl.abort();
  }, [integrationId, endpoints.length]);
  const grouped = endpoints.some((e) => e.group || e.advanced);
  const draw = (e: Endpoint) => render(e, checks[e.id]);
  if (!grouped) return <ul className="flex flex-col gap-6" data-endpoint-list>{endpoints.map(draw)}</ul>;
  const hidden = endpoints.filter((e) => avail[e.id] === false);
  const visible = endpoints.filter((e) => showAll || avail[e.id] !== false);
  const groups: { name: string; items: Endpoint[] }[] = [];
  for (const e of visible.filter((x) => !x.advanced)) {
    const name = e.group ?? "Other";
    (groups.find((g) => g.name === name) ?? groups[groups.push({ name, items: [] }) - 1]!).items.push(e);
  }
  const advanced = visible.filter((x) => x.advanced);
  const failed = hidden.filter((e) => checks[e.id]?.status === "failed").length;
  const needs = [...new Set(hidden.filter((e) => checks[e.id]?.status !== "failed").map((e) => e.needs).filter(Boolean))];
  return (
    <div className="flex flex-col gap-6" data-endpoint-list data-endpoint-groups>
      {hidden.length > 0 && (
        <div className="flex flex-wrap items-center gap-3" data-hidden-reads={hidden.length}>
          <p className="type-body text-glass-muted">{showAll ? `Showing ${hidden.length} ${hidden.length === 1 ? "read" : "reads"} this service has no data for${failed ? " or that did not work on it" : ""}.` : failed === hidden.length ? `${hidden.length} ${hidden.length === 1 ? "read is" : "reads are"} hidden because ${hidden.length === 1 ? "it" : "they"} did not work on this server.` : `${hidden.length} ${hidden.length === 1 ? "read is" : "reads are"} hidden because this service has no data for ${hidden.length === 1 ? "it" : "them"}${needs.length ? ` (they need ${needs.join("; ")})` : ""}${failed ? `, or ${failed === 1 ? "it" : "they"} did not work on it` : ""}.`}</p>
          <Button variant="secondary" onClick={() => setShowAll((x) => !x)} aria-pressed={showAll} data-show-all-reads>{showAll ? "Hide them" : "Show all reads"}</Button>
        </div>
      )}
      {groups.map((g) => (g.items.every((e) => e.id.startsWith("r:")) ? <FoldedGroup key={g.name} name={g.name} items={g.items} draw={draw} /> : (
        <section key={g.name} className="flex flex-col gap-3" data-endpoint-group={g.name}>
          <h3 className="type-label text-fg-2">{g.name}</h3>
          <ul className="flex flex-col gap-6">{g.items.map(draw)}</ul>
        </section>
      )))}
      {advanced.length > 0 && (
        <details className="flex flex-col gap-3" data-endpoint-group="Advanced">
          <summary className="type-label text-fg-2 cursor-pointer min-h-11 flex items-center">Advanced ({advanced.length})</summary>
          <ul className="mt-3 flex flex-col gap-6">{advanced.map(draw)}</ul>
        </details>
      )}
    </div>
  );
}

export function IntegrationDetail({ integration, pkg, endpoints, canEdit, cachedOnly, commands, sharing, credentials = [], canRead = true, canRecipes = false }: { integration: IntegrationView; pkg: PackageCard | null; endpoints: Endpoint[]; canEdit: boolean; cachedOnly: boolean; commands: CommandsData; sharing: SharingData; credentials?: PickableCredential[]; canRead?: boolean; canRecipes?: boolean }) {
  usePageTitle(integration.name);
  const router = useRouter();
  const [error, setError] = useState<ApiError | null>(null);
  const [pkgName, setPkgName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const path = integrationPath(integration);
  const slug = path.replace(/^integrations \/ /, "");
  const version = savedVersion(integration, credentials);

  async function act(fn: () => Promise<unknown>, done?: string) {
    setError(null);
    try { await fn(); if (done) toast({ kind: "success", title: done }); router.refresh(); }
    catch (e) { setError(e instanceof ApiFailure ? e.error : { code: "internal", message: "That did not work." }); }
  }

  return (
    <Screen data-integration-detail={integration.id}>
      <div className="flex flex-col gap-3">
        <ScreenHeader title={integration.name} lead={integration.packageName} />
        <div className="flex flex-wrap items-center gap-3 type-body text-fg-2">
          {integration.status !== "active" && <span className="border border-line-strong px-1.5 type-label" data-status-badge={integration.status}>{integration.status === "draft" ? "Draft" : "Disabled"}</span>}
          {integration.locked ? <LockedNotice /> : integration.lastHealth ? <HealthLine {...integration.lastHealth} /> : <UntestedBadge />}
        </div>
        {integration.status === "draft" && <p className="type-body text-fg">This draft was made by an agent. Open the credentials link it gave you to enter the key and publish.</p>}
      </div>
      {error && <ErrorCallout error={error} />}

      {pkg ? <ConnectionForm key={version} pkg={pkg} integration={integration} canEdit={canEdit} credentials={credentials} /> : <ErrorCallout error={{ code: "config", message: `The package "${integration.packageId}" is not installed.`, hint: "Import the package again to bring this integration back." }} heading="Package missing" />}

      <section aria-labelledby="endpoints-title" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="endpoints-title" className="type-title-3 text-fg">Endpoints</h2>
          {canEdit && integration.packageId === "custom-api" && <Button variant="secondary" href={`/integrations/new/by-example?integration=${integration.id}&url=${encodeURIComponent(String(integration.config.baseUrl ?? ""))}`}>Add endpoint by example</Button>}
        </div>
        {endpoints.length === 0 ? <p className="type-body text-glass-muted">No endpoints yet.</p> : (
          <EndpointGroups endpoints={endpoints} integrationId={integration.id} render={(e, check) => <EndpointPreview key={`${e.id}:${version}`} integrationId={integration.id} e={e} cachedOnly={cachedOnly} path={path} readable={canRead} check={check} />} />
        )}
      </section>

      {canRecipes && <RecipesPanel integrationId={integration.id} titleSlug={slug} />}

      <div className="grid grid-cols-1 gap-6" data-r3-panels>
        <CommandsPanel integrationId={integration.id} initial={commands} titleSlug={slug} />
        <SharingPanel integrationId={integration.id} initial={sharing} titleSlug={slug} />
      </div>

      {canEdit && (
        <Window as="section" title={`${path} / manage`} aria-labelledby="manage-title" bodyClassName="flex flex-col gap-4" data-manage>
          <h2 id="manage-title" className="type-title-3 text-fg">Manage</h2>
          {integration.packageId === "custom-api" && endpoints.length > 0 && (
            <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); void act(() => api(`/api/integrations/${integration.id}/package`, { body: { name: pkgName } }), "Saved as a package"); }}>
              <Field label="Save as a shareable package" htmlFor="pkg-name"><Input id="pkg-name" value={pkgName} onChange={(e) => setPkgName(e.target.value)} placeholder="My home API" required /></Field>
              <Button type="submit" variant="secondary" data-save-package>Save as package</Button>
            </form>
          )}
          <div className="flex flex-wrap gap-2">
            {integration.status !== "draft" && (
              <Button variant="secondary" onClick={() => void act(() => api(`/api/integrations/${integration.id}`, { method: "PATCH", body: { status: integration.status === "active" ? "disabled" : "active" } }))}>
                {integration.status === "active" ? "Disable" : "Enable"}
              </Button>
            )}
            <Button variant="destructive" onClick={() => setConfirmDelete(true)} data-delete>Delete</Button>
          </div>
          <Sheet open={confirmDelete} onOpenChange={setConfirmDelete} title={`Delete ${integration.name}?`} path="integrations / delete" name="integration-delete" width={440}>
            <div className="flex flex-col gap-4" data-delete-integration-confirm>
              <p className="type-body text-fg">Its own saved values are deleted too. Saved credentials it used stay under Credentials.</p>
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="quiet" onClick={() => setConfirmDelete(false)}>Keep it</Button>
                <Button variant="destructive-confirm" onClick={() => { setConfirmDelete(false); void act(async () => { await api(`/api/integrations/${integration.id}`, { method: "DELETE" }); router.push("/integrations"); }); }} data-delete-confirm>Delete</Button>
              </div>
            </div>
          </Sheet>
        </Window>
      )}
    </Screen>
  );
}
