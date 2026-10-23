"use client";
// Commands, the Shared switch and "This integration can change" (architecture v3 section 3.1,
// amendment A1.1, design v4 section 1: windows, buttons and switches). Every value shown here
// comes from Atrium's own API; nothing calls an integration from the browser.
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { Button, Sheet, Switch, toast, Window } from "@/features/shell";
import { api, ApiFailure, ErrorCallout, Field, Input, inputClass, Spinner, type ApiError } from "./common";

export type CommandRow = { id: string; label: string; description?: string; risk: "low" | "medium"; ownerOnly: boolean; target?: { endpointId: string; field: string }; method?: string; path?: string };
export type CommandsData = { commands: CommandRow[]; pending: (CommandRow & { change: "added" | "changed" })[]; canChange: boolean; customCommands: boolean };
export type SharingData = { shared: boolean; canChange: boolean; affectedApps: { id: string; name: string; slug: string }[]; appsKnown: boolean };

function RiskTag({ risk }: { risk: "low" | "medium" }) {
  return <span className={`border px-1.5 font-mono type-caption ${risk === "medium" ? "border-warning text-fg" : "border-line text-fg-muted"}`} data-risk={risk}>{risk} risk</span>;
}

function CommandLine({ c, change }: { c: CommandRow; change?: "added" | "changed" }) {
  return (
    <li className="flex flex-col gap-1 border-b border-line py-3 last:border-b-0 touch:min-h-11" data-command={c.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="type-callout text-fg">{c.label}</span>
        <code className="font-mono type-caption text-fg-muted" data-command-id>{c.id}</code>
        <RiskTag risk={c.risk} />
        {c.ownerOnly && <span className="bg-fg px-1.5 font-mono type-caption text-bg" data-owner-only>owner only</span>}
        {change && <span className="border border-line px-1.5 font-mono type-caption text-fg" data-change={change}>{change}</span>}
      </div>
      {(c.method || c.target) && (
        <p className="font-mono type-caption text-fg-muted">
          {c.method && <span data-command-request>{c.method} {c.path}</span>}
          {c.target && <span data-command-target>targets from {c.target.endpointId} ({c.target.field})</span>}
        </p>
      )}
    </li>
  );
}

/** The list a person reads before publishing: everything this integration or package will be able to change. */
export function CanChangeList({ items, title = "This integration can change", intro }: { items: (CommandRow & { change?: "added" | "changed" })[]; title?: string; intro?: string }) {
  const id = useId();
  if (items.length === 0) return null;
  return (
    <Window title={title.toLowerCase()} aria-labelledby={`${id}-t`} status={`${items.length} ${items.length === 1 ? "command" : "commands"}`} bodyClassName="flex flex-col gap-3" data-can-change>
      <h2 id={`${id}-t`} className="type-title-3 text-fg">{title}</h2>
      <p className="type-body text-fg-muted">{intro ?? "Controls on published apps will be able to run these. Every run is recorded in the audit log."}</p>
      <ul className="flex flex-col">{items.map((c) => <CommandLine key={c.id} c={c} {...(c.change ? { change: c.change } : {})} />)}</ul>
    </Window>
  );
}

/** Server field names whose input id differs from `cmd-<field>`. */
const FIELD_INPUT: Record<string, string> = { description: "desc" };

const EXAMPLE_PARAMS = '{\n  "type": "object",\n  "properties": { "on": { "type": "boolean" } },\n  "required": ["on"]\n}';
// The body that goes with the example parameters (app-builder final r4 SFR, gauntlet w2-r3 item 3): a
// declared parameter reaches the device only through a "{{ params.<name> }}" in the body (path and
// query are literal), so the example sends `on` instead of an empty body.
const EXAMPLE_BODY = '{\n  "on": "{{ params.on }}"\n}';

/** Declared parameters the body never sends; empty when either box is not valid JSON yet. */
export function unsentDeclared(paramsText: string, bodyText: string): string[] {
  let schema: { properties?: Record<string, unknown> };
  try { schema = JSON.parse(paramsText) as typeof schema; } catch { return []; }
  const declared = Object.keys(schema?.properties ?? {});
  let body: unknown;
  if (bodyText.trim()) { try { body = JSON.parse(bodyText); } catch { return []; } }
  const sent = new Set([...JSON.stringify(body ?? null).matchAll(/\{\{\s*params\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map((m) => m[1]));
  return declared.filter((n) => !sent.has(n));
}

function AddCommandForm({ integrationId, onDone }: { integrationId: string; onDone: (d: CommandsData) => void }) {
  const [f, setF] = useState({ id: "", label: "", description: "", method: "POST", path: "/", body: EXAMPLE_BODY, params: EXAMPLE_PARAMS, risk: "low" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    // Editing the field a message was about clears that message and its mark.
    if (err?.field === k) setErr(null);
  };
  const unsent = unsentDeclared(f.params, f.body);
  // Round 8: a server message about one field marks that field invalid and points it at the message.
  const errId = "cmd-error";
  const tie = (field: string) => (err?.field === field ? { "aria-invalid": true as const, "aria-describedby": errId } : {});
  async function submit() {
    setErr(null);
    let params: unknown;
    let bodyJson: unknown;
    try { params = JSON.parse(f.params); } catch { setErr({ code: "config", message: "The parameters are not valid JSON." }); return; }
    if (f.body.trim()) { try { bodyJson = JSON.parse(f.body); } catch { setErr({ code: "config", message: "The body is not valid JSON." }); return; } }
    setBusy(true);
    try {
      const d = await api<CommandsData>(`/api/integrations/${integrationId}/commands`, { body: { id: f.id.trim(), label: f.label.trim(), description: f.description.trim() || f.label.trim(), method: f.method, path: f.path.trim(), params, risk: f.risk, ...(bodyJson !== undefined ? { body: bodyJson } : {}) } });
      onDone(d);
      toast({ kind: "success", title: "Command added as a draft" });
    } catch (e) {
      const error = e instanceof ApiFailure ? e.error : { code: "internal", message: "The command was not saved." };
      setErr(error);
      if (error.field) requestAnimationFrame(() => document.getElementById(`cmd-${FIELD_INPUT[error.field!] ?? error.field}`)?.focus());
    }
    finally { setBusy(false); }
  }
  return (
    <form className="flex flex-col gap-3 border-t border-line pt-4" onSubmit={(e) => { e.preventDefault(); void submit(); }} data-add-command>
      <h3 className="type-callout text-fg">Add a command</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Id" htmlFor="cmd-id" hint="Lowercase words joined by dots, such as lamp.toggle."><Input id="cmd-id" {...tie("id")} value={f.id} onChange={set("id")} className="font-mono" autoCapitalize="off" autoCorrect="off" spellCheck={false} required /></Field>
        <Field label="Label" htmlFor="cmd-label"><Input id="cmd-label" {...tie("label")} value={f.label} onChange={set("label")} required /></Field>
        <Field label="Method" htmlFor="cmd-method"><select id="cmd-method" className={inputClass} value={f.method} onChange={set("method")}>{["POST", "PUT", "PATCH", "DELETE"].map((m) => <option key={m}>{m}</option>)}</select></Field>
        <Field label="Path" htmlFor="cmd-path"><Input id="cmd-path" {...tie("path")} value={f.path} onChange={set("path")} className="font-mono" autoCapitalize="off" autoCorrect="off" spellCheck={false} required /></Field>
        <Field label="Risk" htmlFor="cmd-risk" hint="Higher-risk changes are actions with an approval, not commands."><select id="cmd-risk" className={inputClass} value={f.risk} onChange={set("risk")}><option value="low">Low</option><option value="medium">Medium</option></select></Field>
        <Field label="Description" htmlFor="cmd-desc"><Input id="cmd-desc" {...tie("description")} value={f.description} onChange={set("description")} /></Field>
      </div>
      <Field label="Body (JSON, optional)" htmlFor="cmd-body" hint='Use "{{ params.on }}" where a parameter goes. Credentials belong in a secret field, never here.'>
        <textarea id="cmd-body" {...tie("body")} className={`${inputClass} h-24 py-2 font-mono`} value={f.body} onChange={set("body")} spellCheck={false} />
      </Field>
      <Field label="Parameters (JSON Schema)" htmlFor="cmd-params"><textarea id="cmd-params" {...tie("params")} className={`${inputClass} h-32 py-2 font-mono`} value={f.params} onChange={set("params")} spellCheck={false} /></Field>
      {unsent.length > 0 && (
        <p role="status" className="border-l-2 border-warning pl-2 type-caption text-fg" data-unsent-params={unsent.join(" ")}>
          {unsent.map((n) => `"${n}"`).join(", ")} {unsent.length === 1 ? "is" : "are"} declared but never sent: put {unsent.map((n) => `"{{ params.${n} }}"`).join(", ")} in the body, or a control's value for {unsent.length === 1 ? "it" : "them"} is dropped on every run.
        </p>
      )}
      {err && <ErrorCallout error={err} id={errId} />}
      <div><Button type="submit" variant="secondary" disabled={busy} aria-busy={busy}>{busy && <Spinner />} Add as draft</Button></div>
    </form>
  );
}

/** The integration's Commands window, with its pending changes and publish button. */
export function CommandsPanel({ integrationId, initial, signedIn = true, titleSlug }: { integrationId: string; initial: CommandsData; signedIn?: boolean; titleSlug?: string }) {
  const router = useRouter();
  const [d, setD] = useState(initial);
  const [busy, setBusy] = useState<"publish" | "discard" | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const id = useId();
  async function act(kind: "publish" | "discard") {
    setBusy(kind);
    setErr(null);
    try {
      setD(await api<CommandsData>(kind === "publish" ? `/api/integrations/${integrationId}/commands/publish` : `/api/integrations/${integrationId}/commands`, kind === "publish" ? { body: {} } : { method: "DELETE" }));
      toast({ kind: "success", title: kind === "publish" ? "Published" : "Changes discarded" });
      router.refresh();
    } catch (e) { setErr(e instanceof ApiFailure ? e.error : { code: "internal", message: "That did not work." }); }
    finally { setBusy(null); }
  }
  return (
    <div className="flex flex-col gap-6" data-commands-panel>
      <Window title={`integrations / ${titleSlug ?? "integration"} / commands`} aria-labelledby={`${id}-t`} status={d.commands.length ? `${d.commands.length} live` : "reads only"} bodyClassName="flex flex-col gap-3" data-commands={String(d.commands.length)}>
        <h2 id={`${id}-t`} className="type-title-3 text-fg">Commands</h2>
        {d.commands.length === 0 ? <p className="type-body text-fg-muted" data-only-reads>This integration only reads</p> : <ul className="flex flex-col">{d.commands.map((c) => <CommandLine key={c.id} c={c} />)}</ul>}
        {!d.canChange && <p className="type-caption text-fg-muted" data-commands-readonly>Only the owner or the person who added this integration can change its commands.</p>}
        {d.canChange && d.customCommands && <AddCommandForm integrationId={integrationId} onDone={setD} />}
      </Window>
      {d.pending.length > 0 && (
        <div className="flex flex-col gap-3" data-pending-commands>
          <CanChangeList items={d.pending} intro="These changes are a draft. Nothing can run them until a signed-in owner or the integration's creator publishes them." />
          {err && <ErrorCallout error={err} />}
          {d.canChange && signedIn && (
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => void act("publish")} disabled={busy !== null} aria-busy={busy === "publish"} data-publish-commands>{busy === "publish" && <Spinner />} Publish changes</Button>
              <Button variant="quiet" onClick={() => void act("discard")} disabled={busy !== null} data-discard-commands>Discard</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The Shared setting (A1.1). Switching it off first shows the apps that will stop showing this integration's data. */
export function SharingPanel({ integrationId, initial, titleSlug }: { integrationId: string; initial: SharingData; titleSlug?: string }) {
  const router = useRouter();
  const [s, setS] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [asking, setAsking] = useState(false);
  const id = useId();
  useEffect(() => setS(initial), [initial]);
  async function save(shared: boolean) {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/integrations/${integrationId}`, { method: "PATCH", body: { shared } });
      setS((x) => ({ ...x, shared }));
      toast({ kind: "success", title: shared ? "Shared with app editors" : "No longer shared" });
      router.refresh();
    } catch (e) { setErr(e instanceof ApiFailure ? e.error : { code: "internal", message: "That did not save." }); }
    finally { setBusy(false); }
  }
  async function change(next: boolean) {
    if (next) return void save(true);
    // Refresh the affected list right before asking.
    try { setS(await api<SharingData>(`/api/integrations/${integrationId}/sharing`)); } catch { /* keep the list we have */ }
    setAsking(true);
  }
  return (
    <Window title={`integrations / ${titleSlug ?? "integration"} / sharing`} aria-labelledby={`${id}-t`} status={s.shared ? "shared" : "not shared"} bodyClassName="flex flex-col gap-3" data-sharing={s.shared ? "on" : "off"}>
      <h2 id={`${id}-t`} className="sr-only">Sharing</h2>
      {/* The shell's Switch with its label: the whole row is one 44px tap target (mobile r2 finding). */}
      <div className="-mx-2" data-shared-switch={s.shared ? "on" : "off"}>
        <Switch
          checked={s.shared}
          disabled={!s.canChange || busy}
          onCheckedChange={(v) => void change(v)}
          label={<span className="type-title-3">Shared</span>}
          description={<span className="font-sans type-body text-fg-2">{s.shared ? "Anyone who can edit an app may show this integration's data in it." : "Only the owner and the person who added it may use it in apps."} Its commands are only ever placed by the owner and the person who added it.</span>}
        />
      </div>
      {!s.canChange && <p className="type-caption text-fg-3" data-sharing-readonly>Only the owner or the person who added this integration can change this.</p>}
      {err && <ErrorCallout error={err} />}
      <Sheet open={asking} onOpenChange={setAsking} title="Stop sharing this integration?" path="integrations / sharing / confirm" name="unshare" width={460}>
        <div className="flex flex-col gap-3" data-unshare-dialog>
          {s.affectedApps.length > 0 ? (
            <>
              <p className="type-body">These apps will show &ldquo;No data: this integration is no longer shared&rdquo;, and their controls that use it will stop working:</p>
              <ul className="flex flex-col gap-1" data-affected-apps>{s.affectedApps.map((a) => <li key={a.id} className="font-mono type-label">{a.name} <span className="text-fg-3">/a/{a.slug}</span></li>)}</ul>
            </>
          ) : (
            <p className="type-body" data-affected-apps="none">{s.appsKnown ? "No apps that others can edit use it." : "No apps use it yet."} Apps whose editors are not you or the owner will stop showing its data.</p>
          )}
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setAsking(false)} data-unshare-cancel>Keep sharing</Button>
            <Button variant="destructive-confirm" onClick={() => { setAsking(false); void save(false); }} data-unshare-confirm>Stop sharing</Button>
          </div>
        </div>
      </Sheet>
    </Window>
  );
}
