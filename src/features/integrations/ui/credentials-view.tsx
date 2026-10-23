"use client";
// The Credentials view of the Integrations tab (Amendment 2, integrations-spec-v3 section 3.1):
// one window per saved credential (kind, locked servers or "Locks on first use", used by, last used,
// Rotate and Delete) and a "New credential" form. Values are typed once and never shown again.
// Round 5 (Fix List r2 items 4, 5, 7, 11): Rename, and Remove for each locked server (a step-up when
// the credential is in use); Delete on a credential in use says so straight away, and an unused one
// is confirmed in the app's own dialog; title bars are readable paths; the screen uses the shared
// ScreenHeader with the Services and Credentials tabs.
// Round 6 (Fix List r3 items 1 and 5): removing a server always asks for a step-up; the remove
// confirm names only the integrations on that server; a credential with no server says plainly what
// happens next; the New credential sheet from a setup form names the package and fills in its server,
// and keeps Save credential in view above the keyboard.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import type { CredentialKind } from "@/core/contracts";
import { Button, PlusIcon, Screen, ScreenHeader, Sheet, Window, toast, usePageTitle } from "@/features/shell";
import { StepUpProvider, useStepUp } from "@/features/auth/components";
import { CREDENTIAL_KINDS, KIND_FIELDS, KIND_LABELS } from "../credentials/kinds";
import { withScheme } from "../address-input";
import { api, ApiFailure, ErrorCallout, Field, InfoNote, Input, inputClass, LockedNotice, slugOf, Spinner, urlInputProps, type ApiError } from "./common";
import { readJson, sendJson } from "./locked-save";
import { integrationsTabs } from "./view-tabs";

export type CredentialItem = {
  id: string; name: string; kind: CredentialKind; lockedOrigins: string[]; createdAt: string; updatedAt: string; lastUsedAt?: string | undefined;
  usedBy: { integrationId: string; name: string }[]; usedAt?: { integrationId: string; origin: string | null }[]; fields: { key: string; set: boolean; updatedAt?: string | undefined }[]; locked: boolean;
};

const secretInputProps = { autoComplete: "new-password", autoCapitalize: "off", autoCorrect: "off", spellCheck: false } as const;

function when(iso?: string): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

function errorOf(e: unknown, fallback: string): ApiError {
  return e instanceof ApiFailure ? e.error : { code: "internal", message: fallback };
}

/** The value fields of a kind, write-only. `keep` shows "Leave blank to keep it" (rotation). */
function ValueFields({ uid, kind, values, onChange, keep }: { uid: string; kind: CredentialKind; values: Record<string, string>; onChange: (v: Record<string, string>) => void; keep?: boolean }) {
  return (
    <>
      {KIND_FIELDS[kind].map((f) => (
        <Field key={f.key} label={f.label} hint={f.hint} htmlFor={`${uid}-${f.key}`}>
          <Input id={`${uid}-${f.key}`} type="password" {...secretInputProps} aria-describedby={`${uid}-${f.key}-hint`} placeholder={keep ? "Leave blank to keep it" : `Paste the ${f.label.toLowerCase()}`} value={values[f.key] ?? ""} onChange={(e) => onChange({ ...values, [f.key]: e.target.value })} data-credential-value={f.key} />
        </Field>
      ))}
    </>
  );
}

/**
 * The New credential form. On the Credentials view it is its own window; `inSheet` draws it bare
 * inside a sheet (the picker's "New <kind>"), with the kind chosen when `fixedKind` is set.
 */
export function NewCredentialForm({ onDone, onCancel, kind: initialKind = "token", fixedKind = false, inSheet = false, namePlaceholder, suggestedServer }: {
  onDone: (c: CredentialItem) => void; onCancel: () => void; kind?: CredentialKind; fixedKind?: boolean; inSheet?: boolean;
  /** From a setup form: "Prometheus token". */
  namePlaceholder?: string | undefined;
  /** From a setup form: its address, so the credential is locked there from the start. */
  suggestedServer?: string | undefined;
}) {
  const uid = useId();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<CredentialKind>(initialKind);
  const [values, setValues] = useState<Record<string, string>>({});
  const [server, setServer] = useState(suggestedServer ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    e.stopPropagation(); // inside a sheet over a setup form, never submit the form underneath
    setBusy(true);
    setError(null);
    try {
      const keys = KIND_FIELDS[kind].map((f) => f.key);
      const c = await api<CredentialItem>("/api/integrations/credentials", { body: { name, kind, values: Object.fromEntries(Object.entries(values).filter(([k]) => keys.includes(k))), ...(server.trim() ? { server } : {}) } });
      setValues({});
      toast({ kind: "success", title: `Saved ${c.name}` });
      onDone(c);
    } catch (x) {
      setError(errorOf(x, "Saving failed."));
    } finally {
      setBusy(false);
    }
  }

  const form = (
    <form className={`flex flex-col gap-4 ${inSheet ? "" : "p-5 max-sm:p-4"}`} onSubmit={(e) => void submit(e)} noValidate data-new-credential-form>
      {!inSheet && <h2 id={`${uid}-t`} className="type-title-3 text-fg">New credential</h2>}
      <p className="type-body text-fg-2">Save a token or password once, then pick it when you add an integration. Atrium never shows the value again.</p>
      <Field label="Name" hint="Only you and the owner of this Atrium can see it." htmlFor={`${uid}-name`}>
        <Input id={`${uid}-name`} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-describedby={`${uid}-name-hint`} placeholder={namePlaceholder ?? "My token"} data-credential-name />
      </Field>
      {fixedKind ? (
        <p className="type-body text-fg" data-credential-kind-fixed={kind}>Kind: <span className="type-callout">{KIND_LABELS[kind]}</span></p>
      ) : (
        <Field label="Kind" htmlFor={`${uid}-kind`}>
          <select id={`${uid}-kind`} className={inputClass} value={kind} onChange={(e) => { setKind(e.target.value as CredentialKind); setValues({}); }} data-credential-kind>
            {CREDENTIAL_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
          </select>
        </Field>
      )}
      <ValueFields uid={uid} kind={kind} values={values} onChange={setValues} />
      <Field label="Server (optional)" hint={suggestedServer ? "Filled in from the form. Atrium sends it only to this server; change it if the token is for another." : "Lock it to one server now, for example https://ha.local:8123 or 10.0.0.7:9090. Left empty, the first test or save locks it, after you confirm it is you."} htmlFor={`${uid}-server`}>
        <Input id={`${uid}-server`} value={server} onChange={(e) => setServer(e.target.value)} onBlur={(e) => { const v = withScheme(e.target.value); if (v !== e.target.value) setServer(v); }} {...urlInputProps} aria-describedby={`${uid}-server-hint`} placeholder="https://" data-credential-server />
      </Field>
      {error && <ErrorCallout error={error} heading="Not saved" />}
      {/* In a sheet on a phone the actions stay at the bottom of the sheet's scroll area, above the keyboard (mobile r3). */}
      <div className={`flex flex-wrap gap-2 ${inSheet ? "touch:sticky touch:bottom-0 touch:z-10 touch:-mx-(--window-pad) touch:border-t touch:border-line touch:bg-bg-hi touch:px-(--window-pad) touch:py-3" : ""}`} data-credential-actions>
        <Button variant="primary" type="submit" disabled={busy} aria-busy={busy} data-credential-save>{busy && <Spinner label="Saving" />} Save credential</Button>
        <Button variant="quiet" type="button" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
  if (inSheet) return <div data-new-credential>{form}</div>;
  return (
    <Window as="section" title="integrations / credentials / new" padded={false} aria-labelledby={`${uid}-t`} data-new-credential>
      {form}
    </Window>
  );
}

function CredentialWindow({ c, onChanged }: { c: CredentialItem; onChanged: () => void }) {
  const uid = useId();
  const runStepUp = useStepUp();
  const [mode, setMode] = useState<"view" | "rotate" | "rename">("view");
  const [values, setValues] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState(c.name);
  const [busy, setBusy] = useState<"rotate" | "delete" | "rename" | "remove" | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const inUse = c.usedBy.length > 0;

  async function rotate(e: FormEvent) {
    e.preventDefault();
    setBusy("rotate");
    setError(null);
    try {
      await api(`/api/integrations/credentials/${c.id}`, { method: "PUT", body: { values } });
      setValues({});
      setMode("view");
      toast({ kind: "success", title: `Rotated ${c.name}` });
      onChanged();
    } catch (x) { setError(errorOf(x, "Rotating failed.")); }
    finally { setBusy(null); }
  }

  async function rename(e: FormEvent) {
    e.preventDefault();
    setBusy("rename");
    setError(null);
    try {
      const v = await api<CredentialItem>(`/api/integrations/credentials/${c.id}`, { method: "PATCH", body: { name: newName } });
      setMode("view");
      toast({ kind: "success", title: `Renamed to ${v.name}` });
      onChanged();
    } catch (x) { setError(errorOf(x, "Renaming failed.")); }
    finally { setBusy(null); }
  }

  async function removeOrigin(origin: string) {
    setRemoving(null);
    setBusy("remove");
    setError(null);
    setNote(null);
    try {
      // Removing a server always needs a fresh step-up (r6): auth's prompt opens and the request is retried.
      const res = await runStepUp(() => sendJson(`/api/integrations/credentials/${c.id}`, "PATCH", { removeOrigins: [origin] }));
      if (!res) { setNote(`Not changed. ${c.name} is still locked to ${c.lockedOrigins.join(", ")}.`); return; }
      await readJson(res);
      toast({ kind: "success", title: `Removed ${origin}`, description: `${c.name} is no longer sent there.` });
      onChanged();
    } catch (x) { setError(errorOf(x, "Removing the server failed.")); }
    finally { setBusy(null); }
  }

  function askDelete() {
    setError(null);
    // In use: say so straight away, never ask to confirm a deletion that would be refused.
    if (inUse) {
      setError({ code: "credential_in_use", message: `${c.name} is used by ${c.usedBy.map((u) => u.name).join(", ")}. Switch them to another credential first.` });
      return;
    }
    setConfirmDelete(true);
  }

  async function remove() {
    setConfirmDelete(false);
    setBusy("delete");
    setError(null);
    try {
      await api(`/api/integrations/credentials/${c.id}`, { method: "DELETE" });
      toast({ kind: "success", title: `Deleted ${c.name}` });
      onChanged();
    } catch (x) { setError(errorOf(x, "Deleting failed.")); }
    finally { setBusy(null); }
  }

  const users = c.usedBy.map((u) => u.name);
  // Only the integrations that point at the server being removed stop reading (usability r3).
  const onRemoved = removing ? c.usedBy.filter((u) => c.usedAt?.find((x) => x.integrationId === u.integrationId)?.origin === removing).map((u) => u.name) : [];
  return (
    <Window as="li" title={`integrations / credentials / ${slugOf(c.name)}`} status={<span data-credential-kind-label>{KIND_LABELS[c.kind].toLowerCase()}</span>} live={inUse} padded={false} data-credential={c.id} data-credential-name-label={c.name}>
      <div className="flex flex-col gap-4 p-5 max-sm:p-4">
        <h3 className="type-title-3 text-fg break-words">{c.name}</h3>
        {c.locked && <LockedNotice />}
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-[max-content_1fr]">
          <dt className="type-label text-fg-3">Locked to</dt>
          <dd className="min-w-0 type-body text-fg" data-credential-origins>
            {c.lockedOrigins.length ? (
              <ul className="flex flex-col">
                {c.lockedOrigins.map((o) => (
                  <li key={o} className="flex min-h-9 flex-wrap items-center justify-between gap-2 touch:min-h-11" data-locked-origin={o}>
                    <span className="min-w-0 font-mono text-[13px] break-all">{o}</span>
                    <button type="button" className="inline-flex min-h-8 items-center px-1 type-label text-bad hover:bg-bg-sunk touch:min-h-11" onClick={() => setRemoving(o)} disabled={busy !== null} aria-label={`Remove ${o} from ${c.name}`} data-remove-origin={o}>Remove</button>
                  </li>
                ))}
              </ul>
            ) : inUse ? (
              <span data-credential-unlocked="in-use">Not locked to any server. {users.join(", ")} will ask you to allow its server, and to confirm it is you, on the next save.</span>
            ) : (
              <span data-credential-unlocked="unused">Locks on first use. The first test or save locks it to that server, after you confirm it is you.</span>
            )}
          </dd>
          <dt className="type-label text-fg-3">Used by</dt>
          <dd className="min-w-0 type-body text-fg" data-credential-used-by>
            {inUse ? (
              <ul className="flex flex-col">
                {c.usedBy.map((u) => (
                  <li key={u.integrationId}><Link href={`/integrations/${u.integrationId}`} className="inline-flex min-h-8 items-center text-accent-ink underline underline-offset-2 touch:min-h-11" data-used-by-link>{u.name}</Link></li>
                ))}
              </ul>
            ) : (
              <span className="flex flex-col gap-1">
                <span>Not used yet</span>
                <span className="type-caption text-fg-2" data-next-step>Pick it when you add an integration. <Link href="/integrations/new" className="inline-flex min-h-8 items-center text-accent-ink underline underline-offset-2 touch:min-h-11">Add an integration</Link></span>
              </span>
            )}
          </dd>
          <dt className="type-label text-fg-3">Last used</dt>
          <dd className="type-body text-fg tabular-nums" data-credential-last-used>{when(c.lastUsedAt)}</dd>
        </dl>
        {mode === "rotate" && (
          <form className="flex flex-col gap-4 bg-bg-sunk p-4" onSubmit={(e) => void rotate(e)} noValidate data-rotate-form>
            <p className="type-body text-fg">New values for {c.name}. Every integration that uses it switches at once.</p>
            <ValueFields uid={uid} kind={c.kind} values={values} onChange={setValues} keep />
            <div className="flex flex-wrap gap-2">
              <Button variant="ink" type="submit" disabled={busy !== null} aria-busy={busy === "rotate"} data-rotate-save>{busy === "rotate" && <Spinner />} Save new value</Button>
              <Button variant="quiet" type="button" onClick={() => { setMode("view"); setValues({}); }}>Cancel</Button>
            </div>
          </form>
        )}
        {mode === "rename" && (
          <form className="flex flex-col gap-4 bg-bg-sunk p-4" onSubmit={(e) => void rename(e)} noValidate data-rename-form>
            <Field label="Name" htmlFor={`${uid}-rename`}>
              <Input id={`${uid}-rename`} value={newName} maxLength={80} onChange={(e) => setNewName(e.target.value)} data-rename-input />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button variant="ink" type="submit" disabled={busy !== null} aria-busy={busy === "rename"} data-rename-save>{busy === "rename" && <Spinner />} Save name</Button>
              <Button variant="quiet" type="button" onClick={() => { setMode("view"); setNewName(c.name); }}>Cancel</Button>
            </div>
          </form>
        )}
        {note && <InfoNote>{note}</InfoNote>}
        {error && <ErrorCallout error={error} heading={error.code === "credential_in_use" ? "Still in use" : undefined} />}
        {mode === "view" && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setMode("rotate")} disabled={busy !== null} data-rotate>Rotate</Button>
            <Button variant="quiet" onClick={() => { setMode("rename"); setNewName(c.name); }} disabled={busy !== null} data-rename>Rename</Button>
            <Button variant="destructive" onClick={askDelete} disabled={busy !== null} aria-busy={busy === "delete"} data-delete-credential>{busy === "delete" && <Spinner />} Delete</Button>
          </div>
        )}
      </div>
      <Sheet open={confirmDelete} onOpenChange={setConfirmDelete} title={`Delete ${c.name}?`} path="integrations / credentials / delete" name="credential-delete" width={440}>
        <div className="flex flex-col gap-4" data-delete-confirm>
          <p className="type-body text-fg">Its values are removed for good. No integration uses it.</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="quiet" onClick={() => setConfirmDelete(false)} data-delete-cancel>Keep it</Button>
            <Button variant="destructive-confirm" onClick={() => void remove()} data-delete-confirm-button>Delete</Button>
          </div>
        </div>
      </Sheet>
      <Sheet open={removing !== null} onOpenChange={(o) => { if (!o) setRemoving(null); }} title={`Remove ${removing ?? ""} from ${c.name}?`} path="integrations / credentials / remove server" name="credential-remove-origin" width={460}>
        <div className="flex flex-col gap-4" data-remove-confirm>
          <p className="type-body text-fg">Atrium stops sending <strong>{c.name}</strong> to <span className="font-mono">{removing}</span>.</p>
          {onRemoved.length > 0 ? (
            <p className="type-body text-fg" data-remove-affects>{onRemoved.join(", ")} {onRemoved.length === 1 ? "uses" : "use"} it on that server and will stop reading with &ldquo;Not permitted&rdquo; until you allow the server again on its connection form.</p>
          ) : (
            <p className="type-body text-fg-2" data-remove-affects-none>No integration uses it on this server now. Using it there later asks you to allow the server again.</p>
          )}
          <p className="type-caption text-fg-2">You will be asked to confirm it is you.</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="quiet" onClick={() => setRemoving(null)} data-remove-cancel>Keep it</Button>
            <Button variant="destructive-confirm" onClick={() => removing && void removeOrigin(removing)} data-remove-confirm-button>Remove server</Button>
          </div>
        </div>
      </Sheet>
    </Window>
  );
}

export function CredentialsView(props: { credentials: CredentialItem[]; canSave: boolean; startOpen?: boolean }) {
  return <StepUpProvider><CredentialsViewInner {...props} /></StepUpProvider>;
}

function CredentialsViewInner({ credentials, canSave, startOpen = false }: { credentials: CredentialItem[]; canSave: boolean; startOpen?: boolean }) {
  usePageTitle("Credentials");
  const router = useRouter();
  const [creating, setCreating] = useState(startOpen && canSave);

  return (
    <Screen data-credentials-view>
      <ScreenHeader
        title="Integrations"
        lead="Tokens and passwords saved on their own. Each is sent only to the servers it is locked to."
        action={canSave && !creating ? <Button variant="primary" onClick={() => setCreating(true)} data-new-credential-button><PlusIcon width={16} height={16} aria-hidden /> New credential</Button> : undefined}
        tabs={integrationsTabs("credentials")}
      />
      <h2 className="sr-only">Credentials</h2>
      {!canSave && (
        <Window title="integrations / credentials / role" padded={false} data-credentials-denied>
          <p className="p-5 type-body text-fg">Your role can view integrations but not save credentials.</p>
        </Window>
      )}
      {creating && <NewCredentialForm onCancel={() => setCreating(false)} onDone={() => { setCreating(false); router.refresh(); }} />}
      {canSave && credentials.length === 0 && !creating && (
        <Window title="integrations / credentials / none" padded={false} data-credentials-empty>
          <div className="flex flex-col items-start gap-4 p-5">
            <p className="type-body-lg text-fg">No saved credentials yet. Save a token or password once, then pick it when you add an integration.</p>
            <Button variant="secondary" onClick={() => setCreating(true)}><PlusIcon width={16} height={16} aria-hidden /> New credential</Button>
          </div>
        </Window>
      )}
      {credentials.length > 0 && (
        <ul className="grid grid-cols-1 gap-6 md:grid-cols-2" data-credentials-list>
          {credentials.map((c) => <CredentialWindow key={c.id} c={c} onChanged={() => router.refresh()} />)}
        </ul>
      )}
    </Screen>
  );
}
