"use client";
// Wave 2.8 (recipes spec 3.1, 3.2, 3.4, section 4): the Recipes section of one integration. Lists
// the recipes that apply (built in, imported, from Grafana, from a spec) with their source, how many
// reads work on this server and a switch; Export, Import a file or a link, Import a Grafana dashboard
// (Prometheus), and the live check's progress ("Checked 37 of 120"). Editors only: the page does not
// render it for viewers, and every route it calls answers not found to them.
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, buttonClass, Sheet, Switch, Tag, Window, toast } from "@/features/shell";
import { api, ApiFailure, ErrorCallout, Field, formatDate, Input, Spinner, urlInputProps, type ApiError } from "./common";

type Check = { status: "ok" | "empty" | "failed" | "odd"; reason?: string; at: string };
type RecipeRow = {
  id: string; name: string; version: string; author: string; description: string; source: string; tag: string; status: "draft" | "active"; builtin: boolean; problem?: string;
  reads: number; checked: number; works: number; lastCheckedAt?: string; stale: boolean; skipped: { title: string; reason: string }[];
  readList: { endpointId: string; label: string; group?: string; check?: Check }[];
};
type Progress = { running: boolean; total: number; done: number; finishedAt?: string };
type View = { integrationId: string; packageId: string; recipes: RecipeRow[]; progress: Progress; migrated: boolean; canChange: boolean; canImport: boolean; grafana: boolean };
type Conflict = { existing: { id: string; name: string; version: string }; incoming: { name: string; version: string }; retry: (choice: "replace" | "keep-both") => Promise<void> };

const SOURCE: Record<string, string> = { builtin: "Built in", file: "From a file", url: "From a link", grafana: "From Grafana", spec: "From the spec" };
const STATUS_WORDS: Record<Check["status"], string> = { ok: "Works", empty: "Empty", failed: "Failed", odd: "Looks odd" };

function worksLine(r: RecipeRow, checking: boolean): string {
  if (r.problem) return `Cannot load: ${r.problem}`;
  if (!r.checked) return checking ? "Checking its reads on this server" : `${r.reads} ${r.reads === 1 ? "read" : "reads"}, not checked on this server yet`;
  return `${r.works} of ${r.reads} reads work on this server`;
}

function ReadsDetail({ r }: { r: RecipeRow }) {
  const notOk = r.readList.filter((x) => x.check && x.check.status !== "ok");
  return (
    <details className="flex flex-col gap-2" data-recipe-reads={r.id}>
      <summary className="type-label text-fg-2 cursor-pointer min-h-11 flex items-center">Reads ({r.reads}){notOk.length ? `, ${notOk.length} need a look` : ""}</summary>
      <ul className="mt-2 flex flex-col gap-1">
        {r.readList.map((x) => (
          <li key={x.endpointId} className="flex flex-wrap items-baseline gap-x-2 type-body" data-recipe-read={x.endpointId} data-check={x.check?.status ?? "none"}>
            <span className="text-fg">{x.label}</span>
            {x.group && <span className="type-caption text-glass-muted">{x.group}</span>}
            <span className={`type-caption ${x.check?.status === "failed" ? "text-danger font-medium" : "text-glass-muted"}`}>{x.check ? STATUS_WORDS[x.check.status] : "Not checked"}{x.check?.reason ? `: ${x.check.reason}` : ""}</span>
          </li>
        ))}
      </ul>
      {r.skipped.length > 0 && (
        <div className="mt-2 flex flex-col gap-1" data-recipe-skipped={r.skipped.length}>
          <p className="type-label text-fg-2">Panels that could not become reads ({r.skipped.length})</p>
          <ul className="flex flex-col gap-1">{r.skipped.map((s, i) => <li key={i} className="type-body text-fg-2" data-skipped-panel>{s.title}: {s.reason}</li>)}</ul>
        </div>
      )}
    </details>
  );
}

export function RecipesPanel({ integrationId, titleSlug }: { integrationId: string; titleSlug: string }) {
  const router = useRouter();
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [grafanaOpen, setGrafanaOpen] = useState(false);
  const [dashId, setDashId] = useState("");
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const gfile = useRef<HTMLInputElement>(null);
  const polling = useRef(false);

  const load = useCallback(async () => {
    try {
      setView(await api<View>(`/api/recipes?integrationId=${encodeURIComponent(integrationId)}`));
    } catch (e) {
      setError(e instanceof ApiFailure ? e.error : { code: "internal", message: "The recipes could not be loaded." });
    }
  }, [integrationId]);

  // While a check runs, ask for its progress every second; reload the list (and the page's reads) when it ends.
  const poll = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    try {
      for (let i = 0; i < 600; i++) {
        const p = await api<Progress>(`/api/recipes/check?integrationId=${encodeURIComponent(integrationId)}`).catch(() => null);
        if (p) setView((v) => (v ? { ...v, progress: p } : v));
        if (!p?.running) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    } finally {
      polling.current = false;
      await load();
      router.refresh();
    }
  }, [integrationId, load, router]);

  useEffect(() => { void load().then(() => undefined); }, [load]);
  useEffect(() => { if (view?.progress.running) void poll(); }, [view?.progress.running, poll]);

  async function run(label: string, fn: () => Promise<unknown>, done?: string) {
    setError(null);
    setBusy(label);
    try {
      await fn();
      if (done) toast({ kind: "success", title: done });
      await load();
      router.refresh();
      void poll();
    } catch (e) {
      if (e instanceof ApiFailure && e.error.code === "recipe_exists") return; // handled by the conflict sheet
      setError(e instanceof ApiFailure ? e.error : { code: "internal", message: "That did not work." });
    } finally {
      setBusy(null);
    }
  }

  /** Posts an import; a 409 recipe_exists opens the replace or keep both choice. */
  async function importWith(path: string, body: Record<string, unknown>, label: string) {
    const send = async (onConflict?: "replace" | "keep-both") => {
      const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, ...(onConflict ? { onConflict } : {}) }) });
      const data = (await res.json().catch(() => ({}))) as { error?: ApiError; existing?: Conflict["existing"]; incoming?: Conflict["incoming"]; name?: string; reads?: number; skipped?: unknown[] };
      if (res.status === 409 && data.error?.code === "recipe_exists" && data.existing && data.incoming) {
        setConflict({ existing: data.existing, incoming: data.incoming, retry: async (choice) => { setConflict(null); await run(label, () => send(choice), "Imported as a draft"); } });
        throw new ApiFailure(res.status, data.error);
      }
      if (!res.ok) throw new ApiFailure(res.status, data.error ?? { code: "internal", message: "The import failed." });
      return data;
    };
    await run(label, () => send(), "Imported as a draft. Turn it on to use its reads.");
  }

  async function pickFile(f: File, grafana: boolean) {
    if (f.size > (grafana ? 10 : 2) * 1024 * 1024) { setError({ code: "too_large", message: `That file is larger than ${grafana ? 10 : 2} MB.` }); return; }
    const text = await f.text();
    if (grafana) { setGrafanaOpen(false); await importWith("/api/recipes/grafana", { integrationId, json: text }, "grafana"); }
    else await importWith("/api/recipes/import", { integrationId, text }, "file");
  }

  if (!view) {
    return (
      <Window as="section" title={`${titleSlug} / recipes`} aria-labelledby="recipes-title" bodyClassName="flex flex-col gap-3" data-recipes="loading">
        <h2 id="recipes-title" className="type-title-3 text-fg">Recipes</h2>
        {error ? <ErrorCallout error={error} /> : <p className="type-body text-glass-muted"><Spinner label="Loading" /> Loading recipes</p>}
      </Window>
    );
  }

  const p = view.progress;
  return (
    <Window as="section" title={`${titleSlug} / recipes`} aria-labelledby="recipes-title" bodyClassName="flex flex-col gap-4" data-recipes={view.recipes.length}>
      <div className="flex flex-col gap-1">
        <h2 id="recipes-title" className="type-title-3 text-fg">Recipes</h2>
        <p className="type-body text-fg-2">Ready-made reads for this kind of service. Imported recipes start off; turn one on to see its reads here and in the builder. Every read is tried once on this server, and reads that fail are hidden until Show all reads.</p>
      </div>
      {!view.migrated && <p className="type-body text-fg" data-recipes-not-migrated>Imported recipes need a database update that has not been applied yet. Built-in recipes still work.</p>}
      {error && <ErrorCallout error={error} heading={error.field ? "That recipe cannot be imported" : undefined} />}

      <div aria-live="polite" className="min-h-6">
        {p.running ? (
          <p className="type-body text-fg flex items-center gap-2" data-check-progress={`${p.done}/${p.total}`}><Spinner label="Checking" /> Checked {p.done} of {p.total}</p>
        ) : p.finishedAt ? <p className="type-caption text-glass-muted" data-check-done>Last check finished {formatDate(p.finishedAt)}.</p> : null}
      </div>

      {view.recipes.length === 0 ? (
        <p className="type-body text-glass-muted" data-recipes-empty>No recipes yet</p>
      ) : (
        <ul className="flex flex-col gap-4" data-recipe-list>
          {view.recipes.map((r) => (
            <li key={r.id} className="flex flex-col gap-2 border border-line-strong bg-bg-hi p-3" data-recipe={r.id} data-recipe-status={r.status} data-recipe-source={r.source}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="type-callout text-fg break-words">{r.name} {r.version && <span className="type-caption text-glass-muted">v{r.version}</span>}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Tag tone={r.source === "builtin" ? "paper" : r.source === "grafana" ? "gold" : "ink"}>{SOURCE[r.source] ?? r.source}</Tag>
                    {r.status === "draft" && !r.builtin && <Tag tone="paper">Draft</Tag>}
                  </div>
                  <p className="type-body text-fg" data-recipe-works={`${r.works}/${r.reads}`}>{worksLine(r, p.running)}</p>
                  {r.stale && r.lastCheckedAt && <p className="type-caption text-glass-muted" data-recipe-stale>Last checked {formatDate(r.lastCheckedAt)}.</p>}
                  {r.description && <p className="type-caption text-glass-muted break-words">{r.description}</p>}
                </div>
                {view.canChange && !r.problem && (
                  <Switch checked={r.status === "active"} disabled={busy !== null} label={r.status === "active" ? "On" : "Off"} aria-label={`Use ${r.name}`} onCheckedChange={(on) => void run(`switch-${r.id}`, () => api("/api/recipes/status", { body: { id: r.id, status: on ? "active" : "draft", integrationId } }), on ? `${r.name} is on` : `${r.name} is off`)} />
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {view.canImport && !r.problem && <a className={buttonClass("secondary")} href={`/api/recipes/export?id=${encodeURIComponent(r.id)}`} download data-recipe-export={r.id}>Export</a>}
                {view.canChange && !r.builtin && <Button variant="quiet" disabled={busy !== null} onClick={() => void run(`delete-${r.id}`, () => api("/api/recipes/delete", { body: { id: r.id } }), `${r.name} deleted`)} data-recipe-delete={r.id}>Delete</Button>}
              </div>
              {r.reads > 0 && <ReadsDetail r={r} />}
            </li>
          ))}
        </ul>
      )}

      {view.canImport && (
        <div className="flex flex-col gap-3 border-t border-line pt-4" data-recipe-imports>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => file.current?.click()} disabled={busy !== null} aria-busy={busy === "file"} data-recipe-import-file>{busy === "file" && <Spinner label="Importing" />} Import a file</Button>
            <input ref={file} type="file" accept=".json,application/json" className="sr-only" aria-label="Recipe file" tabIndex={-1} data-recipe-file onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickFile(f, false); e.target.value = ""; }} />
            {view.grafana && <Button variant="secondary" onClick={() => setGrafanaOpen(true)} disabled={busy !== null} aria-busy={busy === "grafana"} data-recipe-import-grafana>{busy === "grafana" && <Spinner label="Importing" />} Import a Grafana dashboard</Button>}
            {view.packageId === "custom-api" && <Button variant="secondary" href="/integrations/new" data-recipe-find-spec>Find a spec</Button>}
            <Button variant="quiet" onClick={() => void run("check", () => api("/api/recipes/check", { body: { integrationId } }))} disabled={busy !== null || p.running} data-recipe-check>Check again</Button>
          </div>
          <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); if (link.trim()) void importWith("/api/recipes/import", { integrationId, url: link.trim() }, "link"); }}>
            <Field label="Or import from a link" hint="An https address of a .atrium-recipe.json file, at most 2 MB." htmlFor="recipe-link">
              <Input id="recipe-link" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://example.com/sonarr.atrium-recipe.json" {...urlInputProps} />
            </Field>
            <Button type="submit" variant="secondary" disabled={busy !== null || !link.trim()} data-recipe-import-link>Import</Button>
          </form>
        </div>
      )}

      <Sheet open={grafanaOpen} onOpenChange={setGrafanaOpen} title="Import a Grafana dashboard" path={`${titleSlug} / recipes / grafana`} name="recipe-grafana" width={480}>
        <div className="flex flex-col gap-4" data-grafana-sheet>
          <p className="type-body text-fg">Its panels become reads on this Prometheus, as a draft recipe. Atrium tries every read once on this server; turn the recipe on when you are happy with it.</p>
          <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); setGrafanaOpen(false); void importWith("/api/recipes/grafana", { integrationId, dashboardId: dashId.trim() }, "grafana"); }}>
            <Field label="Dashboard id from grafana.com" hint="For example 1860 for Node Exporter Full. Atrium downloads it." htmlFor="grafana-id">
              <Input id="grafana-id" value={dashId} onChange={(e) => setDashId(e.target.value)} inputMode="numeric" placeholder="1860" />
            </Field>
            <Button type="submit" variant="primary" disabled={!dashId.trim()} data-grafana-download>Download and import</Button>
          </form>
          <div className="flex flex-col gap-2">
            <p className="type-body text-fg-2">Or use a dashboard JSON file you exported from Grafana (at most 10 MB).</p>
            <Button variant="secondary" onClick={() => gfile.current?.click()} data-grafana-file-button>Choose a JSON file</Button>
            <input ref={gfile} type="file" accept=".json,application/json" className="sr-only" aria-label="Grafana dashboard file" tabIndex={-1} data-grafana-file onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickFile(f, true); e.target.value = ""; }} />
          </div>
        </div>
      </Sheet>

      <Sheet open={!!conflict} onOpenChange={(o) => { if (!o) setConflict(null); }} title="This recipe is already here" path={`${titleSlug} / recipes / import`} name="recipe-conflict" width={440}>
        {conflict && (
          <div className="flex flex-col gap-4" data-recipe-conflict>
            <p className="type-body text-fg">&ldquo;{conflict.existing.name}&rdquo; version {conflict.existing.version} is already here. The file holds version {conflict.incoming.version}.</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="quiet" onClick={() => setConflict(null)}>Cancel</Button>
              <Button variant="secondary" onClick={() => void conflict.retry("keep-both")} data-conflict-keep-both>Keep both</Button>
              <Button variant="primary" onClick={() => void conflict.retry("replace")} data-conflict-replace>Replace it</Button>
            </div>
          </div>
        )}
      </Sheet>
    </Window>
  );
}
