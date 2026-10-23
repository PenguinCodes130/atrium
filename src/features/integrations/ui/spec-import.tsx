"use client";
// Custom API: import from an API spec (Wave 2.8 spec import v2, recipes spec 3.3). Find the spec at
// the service's address, paste its own address, or upload the file (JSON or YAML, up to 10 MB).
// Atrium reads every call, shows the headline reads first and the rest under Advanced, lists the
// changes the service could make (off until picked, each with a risk), and imports the reads
// already named, grouped and checked against the server: no Try it per read.
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { Button, LockIcon, Window, toast } from "@/features/shell";
import { api, ApiFailure, Chevron, ErrorCallout, Field, Input, inputClass, Spinner, urlInputProps, type ApiError } from "./common";

const MAX_BYTES = 10 * 1024 * 1024;

type Setting = { key: string; title: string; required: boolean; choices: boolean };
type Read = { id: string; label: string; description?: string; group: string; headline: boolean; shape: string; path: string; settings: Setting[]; formats: string[] };
type Command = { id: string; label: string; description: string; method: string; path: string; canAdd: boolean; why?: string };
type Auth = { key: string; scheme: string; label: string; hint: string; as: string; name?: string; needsUser?: boolean };
type Preview = {
  specId: string; specUrl?: string; title: string; version: string; specVersion: string; basePath: string;
  totals: { operations: number; gets: number; reads: number; headline: number; commands: number; skipped: number };
  reads: Read[]; commands: Command[]; auth: Auth[]; unsupportedAuth: string[]; skipped: { method: string; path: string; reason: string }[];
};
type Check = { status: "ok" | "empty" | "failed" | "odd"; reason?: string; at: string };
type Imported =
  | { ok: false; heading: string; error: ApiError }
  | { ok: true; integrationId: string; added: number; skipped: { id: string; reason: string }[]; commands: { added: string[]; drafts: boolean }; recipe?: { id: string; saved: boolean; problem?: string }; check: { running: boolean; total: number; results?: Record<string, Check> } };

const SHAPE: Record<string, string> = { stat: "One value", series: "Over time", table: "Table", status: "Up and down" };
const FORMAT: Record<string, string> = { bytes: "bytes", percent: "percent", seconds: "time span", celsius: "temperature", bytesPerSec: "bytes per second", number: "number" };
type Mode = "find" | "url" | "file";

function settingWords(s: Setting[]): string {
  const req = s.filter((x) => x.required);
  if (!req.length) return s.length ? `${s.length} optional setting${s.length === 1 ? "" : "s"}` : "";
  return req.map((x) => (x.choices ? `pick ${x.title.toLowerCase()}` : `type ${x.title.toLowerCase()}`)).join(", ");
}

function ReadRow({ r, on, toggle }: { r: Read; on: boolean; toggle: (id: string, v: boolean) => void }) {
  const extra = [SHAPE[r.shape] ?? r.shape, settingWords(r.settings), ...r.formats.map((f) => `shown as ${FORMAT[f] ?? f}`)].filter(Boolean).join(" · ");
  return (
    <li>
      <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-sm px-2 py-2 hover:bg-line" data-spec-read={r.id} data-headline={r.headline ? "true" : undefined}>
        <input type="checkbox" className="mt-1 h-5 w-5 shrink-0" checked={on} onChange={(e) => toggle(r.id, e.target.checked)} aria-describedby={`sr-${r.id}`} />
        <span className="min-w-0">
          <span className="block type-callout text-fg" data-spec-read-label>{r.label}</span>
          <span id={`sr-${r.id}`} className="block type-caption text-glass-muted">{extra}</span>
          <span className="block break-all font-mono type-caption text-glass-muted">{r.path}</span>
        </span>
      </label>
    </li>
  );
}

function Fold({ title, count, children, data }: { title: string; count: number; children: React.ReactNode; data: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col" data-fold={data}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex min-h-11 items-center gap-2 rounded-sm px-2 text-left type-callout text-fg hover:bg-line" data-fold-toggle={data}>
        <Chevron open={open} /> {title} <span className="type-caption text-glass-muted">({count})</span>
      </button>
      {open && <div className="flex flex-col gap-2 pl-2">{children}</div>}
    </div>
  );
}

export function SpecImport({ initialAddress, initialSpecUrl, integrationId, open: openAtStart = false }: { initialAddress?: string; initialSpecUrl?: string; integrationId?: string; open?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(openAtStart || !!initialSpecUrl);
  const [mode, setMode] = useState<Mode>(initialSpecUrl ? "url" : initialAddress ? "find" : "url");
  const [address, setAddress] = useState(initialAddress ?? "");
  const [specUrl, setSpecUrl] = useState(initialSpecUrl ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [changes, setChanges] = useState<Record<string, "low" | "medium">>({});
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [authKey, setAuthKey] = useState<string>("");
  const [secret, setSecret] = useState("");
  const [basicUser, setBasicUser] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ heading?: string; error: ApiError } | null>(null);
  const [done, setDone] = useState<Extract<Imported, { ok: true }> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const headline = useMemo(() => preview?.reads.filter((r) => r.headline) ?? [], [preview]);
  const groups = useMemo(() => {
    const m = new Map<string, Read[]>();
    for (const r of preview?.reads ?? []) if (!r.headline) m.set(r.group, [...(m.get(r.group) ?? []), r]);
    return [...m.entries()].sort((a, b) => (a[0] === "Other" ? 1 : b[0] === "Other" ? -1 : a[0].localeCompare(b[0])));
  }, [preview]);
  const auth = preview?.auth.find((a) => a.key === authKey);

  async function read(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setPreview(null);
    setDone(null);
    let body: Record<string, string>;
    if (mode === "file") {
      if (!file) { setError({ code: "config", message: "Choose a spec file first." }); return; }
      if (file.size > MAX_BYTES) { setError({ code: "config", message: "This spec is larger than 10 MB, the most Atrium reads." }); return; }
      body = { text: await file.text(), ...(address.trim() ? { address: address.trim() } : {}) };
    } else if (mode === "url") {
      if (!specUrl.trim()) { setError({ code: "config", message: "Paste the spec's address first." }); return; }
      body = { specUrl: specUrl.trim(), ...(address.trim() ? { address: address.trim() } : {}) };
    } else {
      if (!address.trim()) { setError({ code: "config", message: "Paste the service's address first." }); return; }
      body = { address: address.trim() };
    }
    setBusy(true);
    try {
      const p = await api<Preview>("/api/integrations/spec", { body });
      setPreview(p);
      setPicked(new Set(p.reads.map((r) => r.id)));
      setChanges({});
      setName(p.title);
      setAuthKey(p.auth[0]?.key ?? "");
      const origin = (() => { try { return new URL(address.trim() || p.specUrl || "").origin; } catch { return ""; } })();
      setBaseUrl(origin);
    } catch (err) {
      setError(err instanceof ApiFailure ? err.error : { code: "unreachable", message: "The spec could not be read." });
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string, v: boolean) {
    setPicked((s) => { const n = new Set(s); if (v) n.add(id); else n.delete(id); return n; });
  }
  function toggleMany(ids: string[], v: boolean) {
    setPicked((s) => { const n = new Set(s); for (const id of ids) { if (v) n.add(id); else n.delete(id); } return n; });
  }

  async function doImport(untested = false) {
    if (!preview || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const r = await api<Imported>("/api/integrations/spec/import", {
        body: {
          specId: preview.specId,
          ...(integrationId ? { integrationId } : { name: name.trim() || preview.title, baseUrl: baseUrl.trim() }),
          authKey: authKey || null,
          ...(secret ? { secret } : {}),
          ...(auth?.needsUser ? { basicUser } : {}),
          readIds: [...picked],
          commands: Object.entries(changes).map(([id, risk]) => ({ id, risk })),
          ...(untested ? { untested: true } : {}),
        },
      });
      if (!r.ok) { setSaveError({ heading: r.heading, error: r.error }); return; }
      setSecret("");
      setDone(r);
      toast({ kind: "success", title: `Imported ${r.added} reads from ${preview.title}` });
    } catch (err) {
      setSaveError({ error: err instanceof ApiFailure ? err.error : { code: "internal", message: "The import did not finish." } });
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <Window title="integrations / new / custom-api / spec" padded={false} data-spec-import="closed">
        <div className="flex flex-col gap-3 p-5 max-sm:p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="type-callout text-fg">Have an API spec (Swagger or OpenAPI)?</p>
            <p className="type-caption text-glass-muted">Atrium reads every call, names and groups the reads, and checks them on your server.</p>
          </div>
          <Button variant="secondary" onClick={() => setOpen(true)} data-spec-open>Import from an API spec</Button>
        </div>
      </Window>
    );
  }

  const results = done?.check.results ? Object.values(done.check.results) : [];
  const works = results.filter((c) => c.status === "ok").length;
  return (
    <Window as="section" title="integrations / new / custom-api / spec" padded={false} aria-labelledby="spec-title" data-spec-import="open">
      <div className="flex flex-col gap-4 p-5 max-sm:p-4">
        <div>
          <h2 id="spec-title" className="type-title-3 text-fg">Import from an API spec</h2>
          <p className="type-body text-fg-2">Swagger 2 and OpenAPI 3, as JSON or YAML. Only reads are imported; anything that changes the service stays off unless you pick it.</p>
        </div>
        <form onSubmit={read} className="flex flex-col gap-3" aria-label="Read an API spec">
          <div role="radiogroup" aria-label="Where the spec is" className="flex flex-col gap-1 sm:flex-row sm:gap-4">
            {([["find", "Find it at the service's address"], ["url", "Paste the spec's address"], ["file", "Upload a spec file"]] as [Mode, string][]).map(([m, words]) => (
              <label key={m} className="flex min-h-11 cursor-pointer items-center gap-2 type-body text-fg">
                <input type="radio" name="spec-mode" className="h-5 w-5" checked={mode === m} onChange={() => setMode(m)} data-spec-mode={m} /> {words}
              </label>
            ))}
          </div>
          {(mode === "find" || !integrationId) && (
            <Field label={mode === "find" ? "Service address" : "Service address (where the reads go)"} htmlFor="spec-address" hint={mode === "find" ? "Atrium looks for the spec at the usual places, such as /openapi.json and /swagger.json." : undefined}>
              <Input id="spec-address" {...urlInputProps} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="http://10.0.0.9:8989" autoComplete="off" data-spec-address />
            </Field>
          )}
          {mode === "url" && (
            <Field label="Spec address" htmlFor="spec-url" hint="For example http://10.0.0.9:8989/api/v3/openapi.json, or a raw file on GitHub.">
              <Input id="spec-url" {...urlInputProps} value={specUrl} onChange={(e) => setSpecUrl(e.target.value)} placeholder="https://.../openapi.json" autoComplete="off" data-spec-url />
            </Field>
          )}
          {mode === "file" && (
            <Field label="Spec file" htmlFor="spec-file" hint="A .json, .yaml or .yml file, up to 10 MB.">
              <input id="spec-file" ref={fileRef} type="file" accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml" className={`${inputClass} h-auto py-2`} onChange={(e) => setFile(e.target.files?.[0] ?? null)} data-spec-file />
            </Field>
          )}
          <div><Button type="submit" variant="secondary" disabled={busy} aria-busy={busy} data-spec-read-button>{busy && <Spinner label="Reading the spec" />} Read the spec</Button></div>
        </form>
        {error && <ErrorCallout error={error} />}

        {preview && !done && (
          <div className="flex flex-col gap-4" data-spec-preview>
            <div className="flex flex-col gap-1" data-spec-summary>
              <p className="type-title-3 text-fg">{preview.title}{preview.version ? ` ${preview.version}` : ""}</p>
              <p className="type-body text-fg-2">{preview.specVersion}: {preview.totals.operations} calls. {preview.totals.reads} reads to import, {preview.totals.headline} shown first; {preview.totals.commands} could change things (off); {preview.totals.skipped} left out.</p>
            </div>

            {!integrationId && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Name" htmlFor="spec-name"><Input id="spec-name" value={name} onChange={(e) => setName(e.target.value)} data-spec-name /></Field>
                <Field label="Address the reads go to" htmlFor="spec-base" hint={preview.basePath ? `Paths start with ${preview.basePath}.` : undefined}>
                  <Input id="spec-base" {...urlInputProps} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://10.0.0.9:8989" data-spec-base />
                </Field>
              </div>
            )}

            {(preview.auth.length > 0 || preview.unsupportedAuth.length > 0) && (
              <div className="flex flex-col gap-2" data-spec-auth>
                {preview.auth.length > 0 && (
                  <Field label="How Atrium signs in" htmlFor="spec-auth">
                    <select id="spec-auth" className={inputClass} value={authKey} onChange={(e) => setAuthKey(e.target.value)} data-spec-auth-pick>
                      {preview.auth.map((a) => <option key={a.key} value={a.key}>{a.label}{a.name ? ` (${a.name})` : ""}</option>)}
                      <option value="">No sign-in</option>
                    </select>
                  </Field>
                )}
                {auth && !integrationId && (
                  <>
                    {auth.needsUser && <Field label="Username" htmlFor="spec-user"><Input id="spec-user" value={basicUser} onChange={(e) => setBasicUser(e.target.value)} autoComplete="off" /></Field>}
                    <Field label={auth.label} htmlFor="spec-secret" hint={`${auth.hint} Kept sealed on the server and never shown again.`}>
                      <Input id="spec-secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" data-spec-secret />
                    </Field>
                  </>
                )}
                {auth && integrationId && <p className="flex items-center gap-2 type-caption text-glass-muted"><LockIcon width={14} height={14} aria-hidden /> Reads use this integration&apos;s saved secret when it has one.</p>}
                {preview.unsupportedAuth.map((u) => <p key={u} className="type-caption text-glass-muted">{u}</p>)}
              </div>
            )}

            <section aria-labelledby="spec-headline" className="flex flex-col gap-1" data-spec-headline>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id="spec-headline" className="type-callout text-fg">Shown first ({headline.length})</h3>
                <span className="flex gap-2">
                  <Button variant="quiet" onClick={() => toggleMany(preview.reads.map((r) => r.id), true)} data-spec-all>Pick all</Button>
                  <Button variant="quiet" onClick={() => toggleMany(preview.reads.filter((r) => !r.headline).map((r) => r.id), false)} data-spec-headline-only>Only these</Button>
                </span>
              </div>
              <ul className="flex flex-col">{headline.map((r) => <ReadRow key={r.id} r={r} on={picked.has(r.id)} toggle={toggle} />)}</ul>
              {headline.length === 0 && <p className="type-caption text-glass-muted">No read looked like a summary; every read is under Advanced.</p>}
            </section>

            {groups.length > 0 && (
              <Fold title="Advanced reads" count={preview.reads.length - headline.length} data="advanced">
                {groups.map(([g, rs]) => (
                  <div key={g} className="flex flex-col" data-spec-group={g}>
                    <p className="px-2 pt-2 type-caption text-fg-2">{g}</p>
                    <ul className="flex flex-col">{rs.map((r) => <ReadRow key={r.id} r={r} on={picked.has(r.id)} toggle={toggle} />)}</ul>
                  </div>
                ))}
              </Fold>
            )}

            {preview.commands.length > 0 && (
              <Fold title="This service can also change things" count={preview.commands.length} data="commands">
                <p className="px-2 type-caption text-glass-muted">Off by default. Pick a change to add it as a command and set how risky it is; people still confirm it before it runs.</p>
                <ul className="flex flex-col">
                  {preview.commands.map((c) => (
                    <li key={c.id} className="flex flex-col gap-1 px-2 py-1" data-spec-command={c.id}>
                      <label className={`flex min-h-11 items-start gap-3 ${c.canAdd ? "cursor-pointer" : "opacity-70"}`}>
                        <input type="checkbox" className="mt-1 h-5 w-5 shrink-0" disabled={!c.canAdd} checked={!!changes[c.id]} onChange={(e) => setChanges((m) => { const n = { ...m }; if (e.target.checked) n[c.id] = "low"; else delete n[c.id]; return n; })} />
                        <span className="min-w-0">
                          <span className="block type-callout text-fg">{c.label}</span>
                          <span className="block break-all font-mono type-caption text-glass-muted">{c.method} {c.path}</span>
                          {c.why && <span className="block type-caption text-glass-muted">{c.why}</span>}
                        </span>
                      </label>
                      {changes[c.id] && (
                        <label className="ml-8 flex items-center gap-2 type-caption text-fg">
                          Risk
                          <select className={`${inputClass} w-32`} value={changes[c.id]} onChange={(e) => setChanges((m) => ({ ...m, [c.id]: e.target.value as "low" | "medium" }))} data-spec-risk={c.id}>
                            <option value="low">Low</option>
                            <option value="medium">Medium</option>
                          </select>
                        </label>
                      )}
                    </li>
                  ))}
                </ul>
              </Fold>
            )}

            {preview.skipped.length > 0 && (
              <Fold title="Left out" count={preview.totals.skipped} data="skipped">
                <ul className="flex flex-col gap-1 px-2">
                  {preview.skipped.map((s) => <li key={s.method + s.path} className="type-caption text-glass-muted"><span className="font-mono">{s.method} {s.path}</span>: {s.reason}</li>)}
                </ul>
              </Fold>
            )}

            {saveError && <ErrorCallout heading={saveError.heading} error={saveError.error} />}
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" disabled={saving || picked.size === 0 || (!integrationId && !baseUrl.trim())} aria-busy={saving} onClick={() => void doImport(false)} data-spec-import-button>
                {saving && <Spinner label="Importing" />} Import {picked.size} read{picked.size === 1 ? "" : "s"}
              </Button>
              {saveError && !integrationId && <Button variant="quiet" onClick={() => void doImport(true)} data-spec-untested>Import without testing</Button>}
            </div>
            {picked.size === 0 && <p className="type-caption text-glass-muted">Pick at least one read.</p>}
          </div>
        )}

        {done && (
          <div role="status" className="flex flex-col gap-2" data-spec-done>
            <p className="type-title-3 text-fg">Imported {done.added} read{done.added === 1 ? "" : "s"}</p>
            {done.check.results ? (
              <p className="type-body text-fg-2" data-spec-check>{works} of {results.length} reads work on this server{results.length > works ? `; ${results.length - works} ${results.length - works === 1 ? "is" : "are"} hidden until ${results.length - works === 1 ? "it works" : "they work"} (Show all reads lists ${results.length - works === 1 ? "it" : "them"})` : ""}.</p>
            ) : done.check.running ? (
              <p className="type-body text-fg-2" data-spec-check>Checking {done.check.total} reads on your server. The integration page shows the progress.</p>
            ) : null}
            {done.commands.added.length > 0 && <p className="type-body text-fg-2">{done.commands.added.length} change{done.commands.added.length === 1 ? "" : "s"} added as command{done.commands.added.length === 1 ? "" : "s"}{done.commands.drafts ? ", waiting for a person to publish" : ""}.</p>}
            {done.skipped.length > 0 && <p className="type-caption text-glass-muted">{done.skipped.length} could not be saved: {done.skipped.slice(0, 3).map((s) => `${s.id} (${s.reason})`).join(", ")}.</p>}
            {done.recipe && !done.recipe.saved && done.recipe.problem && <p className="type-caption text-glass-muted">Not saved as a recipe: {done.recipe.problem}</p>}
            <div><Button variant="primary" onClick={() => router.push(`/integrations/${done.integrationId}`)} data-spec-open-integration>Open the integration</Button></div>
          </div>
        )}
      </div>
    </Window>
  );
}
