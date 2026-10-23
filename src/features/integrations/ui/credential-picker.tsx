"use client";
// One secret field on a setup form (Amendment 2): "Enter a value" (the write-only field) or "Use a
// saved credential" of the field's kind, with the server it is locked to. Values are never shown.
// Round 5 (usability r2): "New <kind>" opens the New credential form in a sheet over the setup form,
// with the kind chosen; after Save the new credential is picked in this field and the form keeps
// everything typed so far.
// Round 6 (Fix List r3 items 1 and 5): a credential with no lock yet is locked by the first test or
// save after a confirm and a step-up, and the lock line says so; each option names its lock, with the
// ones locked to this server first; the New credential sheet names the package and fills in the
// form's server; a Proxmox token typed in asks for Token ID and Secret, as a saved one does.
import { useState } from "react";
import type { CredentialKind } from "@/core/contracts";
import { Button, PlusIcon, Sheet } from "@/features/shell";
import { KIND_FIELDS, KIND_LABELS, kindForPlacement } from "../credentials/kinds";
import { Field, formatDate, Input, inputClass } from "./common";
import { NewCredentialForm, type CredentialItem } from "./credentials-view";

/** A kind in a sentence: "token", "username and password", but "Proxmox API token" keeps its capitals. */
export function kindNoun(kind: CredentialKind): string {
  const label = KIND_LABELS[kind];
  return kind === "proxmox-token" ? label : label.charAt(0).toLowerCase() + label.slice(1);
}

export type PickableCredential = { id: string; name: string; kind: CredentialKind; lockedOrigins: string[] };
export type SecretFieldState = { key: string; label: string; hint: string; auth: { as: string; name?: string; userKey?: string }; set: boolean; updatedAt?: string | undefined; viaCredential?: boolean; credential?: PickableCredential | { id: string; name: string; kind: string; lockedOrigins: string[] } | undefined };
export type FieldChoice = { mode: "value" | "saved"; value: string; credentialId: string };

export function initialChoice(f: SecretFieldState): FieldChoice {
  return { mode: f.viaCredential && f.credential ? "saved" : "value", value: "", credentialId: f.credential?.id ?? "" };
}

/** Where the picked credential stands for this form's server: locked here, needs a lock, or none. */
export function lockState(c: PickableCredential | undefined, origin: string | undefined): "here" | "first-use" | "elsewhere" | "none" {
  if (!c) return "none";
  if (origin && c.lockedOrigins.includes(origin)) return "here";
  return c.lockedOrigins.length === 0 ? "first-use" : "elsewhere";
}

/** "Prom token (10.77.99.7:9090)", or "(not locked yet)": the lock is visible before picking (usability r3). */
export function optionLabel(c: PickableCredential): string {
  const where = c.lockedOrigins.map((o) => o.replace(/^https?:\/\//, "")).join(", ");
  return `${c.name} (${where || "not locked yet"})`;
}

/** Credentials locked to this server first, then unlocked ones, then the rest; by name within each. */
export function pickOrder(list: PickableCredential[], origin: string | undefined): PickableCredential[] {
  const rank = (c: PickableCredential) => (origin && c.lockedOrigins.includes(origin) ? 0 : c.lockedOrigins.length === 0 ? 1 : 2);
  return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** Proxmox: Token ID and Secret typed separately, sent as the one ID=SECRET value the API takes. */
function ProxmoxValueInputs({ id, field, value, disabled, onChange }: { id: string; field: SecretFieldState; value: string; disabled?: boolean | undefined; onChange: (v: string) => void }) {
  const [parts, setParts] = useState(() => { const i = value.indexOf("="); return i < 0 ? { tokenId: value, secret: "" } : { tokenId: value.slice(0, i), secret: value.slice(i + 1) }; });
  const update = (next: typeof parts) => {
    // A whole USER@REALM!TOKENID=SECRET pasted into Token ID is split, so the secret lands in the masked field.
    const eq = next.tokenId.indexOf("=");
    if (eq > 0 && !next.secret) next = { tokenId: next.tokenId.slice(0, eq), secret: next.tokenId.slice(eq + 1) };
    setParts(next);
    onChange(next.tokenId.trim() && next.secret.trim() ? `${next.tokenId.trim()}=${next.secret.trim()}` : "");
  };
  const kept = field.set && !field.viaCredential;
  return (
    <div className="flex flex-col gap-3" data-proxmox-value={field.key}>
      {KIND_FIELDS["proxmox-token"].map((f) => (
        <label key={f.key} className="flex flex-col gap-1" htmlFor={f.key === "tokenId" ? id : `${id}-${f.key}`}>
          <span className="type-label text-fg-2">{f.label}</span>
          <Input
            id={f.key === "tokenId" ? id : `${id}-${f.key}`}
            type={f.secret ? "password" : "text"}
            autoComplete={f.secret ? "new-password" : "off"}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder={kept ? "Leave blank to keep the saved token" : f.key === "tokenId" ? "atrium@pve!dashboard" : "Paste the secret"}
            value={parts[f.key as "tokenId" | "secret"]}
            disabled={disabled}
            onChange={(e) => update({ ...parts, [f.key]: e.target.value })}
            aria-describedby={`${id}-hint`}
            data-secret={f.key === "tokenId" ? field.key : undefined}
            data-secret-part={f.key}
          />
        </label>
      ))}
    </div>
  );
}

const seg = "inline-flex h-8 touch:h-11 items-center border border-line-strong px-3 type-label cursor-pointer";

export function SecretFieldInput({ uid, field, choice, onChange, credentials, origin, disabled, onCreated, packageName, movingAddress }: {
  uid: string; field: SecretFieldState; choice: FieldChoice; onChange: (c: FieldChoice) => void;
  credentials: PickableCredential[]; origin: string | undefined; disabled?: boolean;
  /** The package being set up, for the New credential sheet's name placeholder. */
  packageName?: string | undefined;
  /** The address differs from the saved one: a typed-in saved value will be cleared on save. */
  movingAddress?: boolean | undefined;
  /** Called with a credential saved from the sheet, so the form's list has it before it is picked. */
  onCreated?: (c: PickableCredential) => void;
}) {
  const [creating, setCreating] = useState(false);
  const kind = kindForPlacement(field.auth);
  const fits = kind ? pickOrder(credentials.filter((c) => c.kind === kind), origin) : [];
  // A field filled from a credential this person may not see shows only "Saved" (spec 3.6).
  const hiddenCredential = field.viaCredential && !field.credential;
  const picked = fits.find((c) => c.id === choice.credentialId);
  const id = `${uid}-s-${field.key}`;
  const lock = lockState(picked, origin);
  return (
    <div className="flex flex-col gap-2" data-secret-field={field.key}>
      <Field label={field.label} hint={field.hint} htmlFor={choice.mode === "value" ? id : `${id}-pick`}>
        {kind && !hiddenCredential && (
          <div role="radiogroup" aria-label={`${field.label}: where the value comes from`} className="flex flex-wrap gap-1" data-secret-mode={field.key}>
            {(["value", "saved"] as const).map((m) => (
              <label key={m} className={`${seg} ${choice.mode === m ? "bg-fg text-bg" : "bg-bg-hi text-fg hover:bg-bg-sunk"} has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-3 has-[:focus-visible]:outline-accent-ink`}>
                <input type="radio" className="sr-only text-[16px]" name={`${id}-mode`} value={m} checked={choice.mode === m} disabled={disabled} onChange={() => onChange({ ...choice, mode: m })} data-mode={m} />
                {m === "value" ? "Enter a value" : "Use a saved credential"}
              </label>
            ))}
          </div>
        )}
        {choice.mode === "value" && kind === "proxmox-token" ? (
          <>
            <ProxmoxValueInputs id={id} field={field} value={choice.value} disabled={disabled} onChange={(v) => onChange({ ...choice, value: v })} />
            {field.set && !movingAddress && <span className="type-caption text-glass-muted" data-secret-saved={field.key}>Saved {field.updatedAt ? formatDate(field.updatedAt) : ""}</span>}
            {field.set && !field.viaCredential && movingAddress && <span className="type-caption text-fg-2" data-secret-moving={field.key}>Moving to a new address clears this token; you can paste it again.</span>}
          </>
        ) : choice.mode === "value" || !kind ? (
          <>
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-describedby={`${id}-hint`}
              placeholder={field.set && !field.viaCredential ? `Saved ${field.updatedAt ? formatDate(field.updatedAt) : ""}. Leave blank to keep it.` : hiddenCredential ? "Saved. Type a value to replace it." : `Paste the ${field.label.toLowerCase()}`}
              value={choice.value}
              disabled={disabled}
              onChange={(e) => onChange({ ...choice, value: e.target.value })}
              data-secret={field.key}
            />
            {field.set && !(movingAddress && !field.viaCredential) && <span className="type-caption text-glass-muted" data-secret-saved={field.key}>Saved {field.updatedAt ? formatDate(field.updatedAt) : ""}</span>}
            {field.set && !field.viaCredential && movingAddress && <span className="type-caption text-fg-2" data-secret-moving={field.key}>Moving to a new address clears this {field.label.toLowerCase()}; you can paste it again.</span>}
          </>
        ) : fits.length === 0 ? (
          <div className="flex flex-col items-start gap-2" data-no-saved={field.key}>
            <p className="type-body text-fg">No saved {kindNoun(kind)} yet. Save one here and it is picked for this field; nothing you typed is lost.</p>
            <Button variant="secondary" onClick={() => setCreating(true)} disabled={disabled} data-new-credential-inline={field.key}><PlusIcon width={16} height={16} aria-hidden /> New {kindNoun(kind)}</Button>
          </div>
        ) : (
          <>
            <select id={`${id}-pick`} className={inputClass} value={choice.credentialId} disabled={disabled} onChange={(e) => onChange({ ...choice, credentialId: e.target.value })} data-credential-pick={field.key} aria-describedby={`${id}-lock`}>
              <option value="">Pick a saved {kindNoun(kind)}</option>
              {fits.map((c) => <option key={c.id} value={c.id}>{optionLabel(c)}</option>)}
            </select>
            <p id={`${id}-lock`} className="type-caption text-fg-2" data-credential-lock={lock}>
              {lock === "here" && <>Locked to <span className="font-mono">{picked!.lockedOrigins.join(", ")}</span></>}
              {lock === "first-use" && <>Locks to <span className="font-mono">{origin ?? "this server"}</span> when you save or test here, after you confirm it is you.</>}
              {lock === "elsewhere" && <>Locked to <span className="font-mono">{picked!.lockedOrigins.join(", ")}</span>. Saving here asks you to allow <span className="font-mono">{origin ?? "this server"}</span> too.</>}
              {lock === "none" && <>Atrium sends a saved credential only to the servers it is locked to.</>}
            </p>
            <button type="button" className="inline-flex min-h-8 w-fit items-center type-caption text-accent-ink underline underline-offset-2 touch:min-h-11" onClick={() => setCreating(true)} disabled={disabled} data-new-credential-inline={field.key}>Save a new {kindNoun(kind)}</button>
          </>
        )}
      </Field>
      {kind && (
        <Sheet open={creating} onOpenChange={setCreating} title={`New ${kindNoun(kind)}`} path={`integrations / credentials / new ${kindNoun(kind).toLowerCase()}`} name="new-credential-sheet" width={480}>
          <NewCredentialForm
            kind={kind}
            fixedKind
            inSheet
            namePlaceholder={packageName ? `${packageName} ${kind === "username-password" ? "login" : "token"}` : undefined}
            suggestedServer={origin}
            onCancel={() => setCreating(false)}
            onDone={(c: CredentialItem) => {
              setCreating(false);
              onCreated?.({ id: c.id, name: c.name, kind: c.kind, lockedOrigins: c.lockedOrigins });
              onChange({ ...choice, mode: "saved", credentialId: c.id });
            }}
          />
        </Sheet>
      )}
    </div>
  );
}
