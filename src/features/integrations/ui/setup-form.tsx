"use client";
// The setup screen (spec 3.4): config fields, then write-only secret fields with plain-English
// hints, "Test connection" on the server with the green tick and glow, Save or Save without testing.
// Round 2: choice fields (Prometheus "Login") show only the fields and secrets that choice needs,
// URL fields fill in http:// and use the URL keyboard, inputs are 16px or more on touch, a field
// focused on a phone scrolls above the keyboard, and moving a saved integration to a new address
// asks before its pinned credentials are deleted.
// Round 4 (Amendment 2): every secret field offers "Enter a value" or "Use a saved credential";
// picking one that is not locked to this server turns Save into "Save and test", and a server the
// credential is locked away from asks "Also allow <credential> on <server>?" and a step-up first.
// Round 5 (Fix List r2 items 4, 7, 8): Test connection works before the first save with a credential
// that has no lock yet (test only, nothing locked), so "Save and test" is only for one locked to
// another server; Test connection is the primary until a test passes, then Save is (swapped with
// pop); the title bar names the saved integration; a cancelled confirm is a neutral note.
// Round 6 (Fix List r3 item 1): Test connection with a credential not locked to any server yet asks
// "Lock <credential> to <server>?" and a step-up, then tests (the server locks it first). Item 5:
// moving the address of an integration with a typed-in token warns under the field as soon as the
// address changes, and the confirm is the app's own sheet instead of the browser's.
import { useRouter } from "next/navigation";
import { useId, useState, type FocusEvent, type ReactNode } from "react";
import { motion } from "motion/react";
import { Button, Window, Glow, Sheet, StatusCheck, toast, transitionFor, useReducedMotion } from "@/features/shell";
import { StepUpProvider } from "@/features/auth/components";
import type { AddressEntry, IntegrationView, PackageCard } from "../service";
import { withScheme } from "../address-input";
import { isShown, originOf, propsOf, secretKeysFor } from "../config-ui";
import { api, ApiFailure, ErrorCallout, Field, HealthLine, HealthStatus, InfoNote, Input, inputClass, integrationPath, LockedNotice, packageSegment, Spinner, urlInputProps, type ApiError } from "./common";
import { PackageIcon } from "./package-icon";
import { initialChoice, lockState, SecretFieldInput, type FieldChoice, type PickableCredential } from "./credential-picker";
import { SaveCancelled, sendJson, useLockedSave } from "./locked-save";
import { builderReturnFor } from "./return-to-builder";

type ServiceKindValue = "containers" | "media" | "monitoring" | "network" | "smart-home" | "storage" | "other";
/** A10.5 kinds, in start page order, in words. */
const SERVICE_KIND_OPTIONS: [ServiceKindValue, string][] = [["containers", "Containers"], ["media", "Media"], ["monitoring", "Monitoring"], ["network", "Network"], ["smart-home", "Smart home"], ["storage", "Storage"], ["other", "Other"]];

type TestResult = { ok: true; health: { status: "ok" | "degraded" | "down"; latencyMs: number; version?: string; message?: string }; passId?: string } | { ok: false; heading: string; error: ApiError; latencyMs: number };

const PINNED_CONFIRM = "Changing the address removes the saved credentials, because Atrium only sends them to the address they were saved for. You can enter them again right after.";

/** On a phone, keeps a focused field and the next button above the on-screen keyboard. */
export function keepFocusedInView(e: FocusEvent<HTMLElement>) {
  const el = e.target as HTMLElement;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return;
  if (typeof window === "undefined" || !window.matchMedia("(pointer: coarse)").matches) return;
  // Wait for the keyboard to open and the visual viewport to shrink, then centre the field in it.
  window.setTimeout(() => el.scrollIntoView({ block: "center", inline: "nearest" }), 300);
}

type FormProps = { pkg: PackageCard; integration?: IntegrationView; prefill?: Record<string, string>; canEdit: boolean; existing?: AddressEntry[]; credentials?: PickableCredential[] };

export function ConnectionForm(props: FormProps) {
  return <StepUpProvider><ConnectionFormInner {...props} /></StepUpProvider>;
}

/** The one primary button of the form; when the primary moves to another button it arrives with `pop`. */
function PrimarySwap({ active, children }: { active: boolean; children: ReactNode }) {
  const reduced = useReducedMotion();
  return (
    <motion.span key={active ? "primary" : "other"} className="inline-flex" initial={active && !reduced ? { scale: 0.94 } : false} animate={{ scale: 1 }} transition={transitionFor("pop", reduced)}>
      {children}
    </motion.span>
  );
}

function ConnectionFormInner({ pkg, integration, prefill = {}, canEdit, existing = [], credentials: credentials0 = [] }: FormProps) {
  const router = useRouter();
  // Credentials saved from the picker's sheet join the list before they are picked (usability r2).
  const [credentials, setCredentials] = useState(credentials0);
  const locked$ = useLockedSave();
  const uid = useId();
  const props = propsOf(pkg.config);
  const initial: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(props)) initial[k] = integration?.config[k] ?? prefill[k] ?? p.default ?? (p.type === "boolean" ? false : "");
  const [config, setConfig] = useState(initial);
  const [name, setName] = useState(integration?.name ?? pkg.name);
  // A10.5: the service's own address for tiles and its kind (start page groups). Not config, not secret.
  const pkgKind = (pkg.service?.kind ?? "other") as ServiceKindValue;
  const [openUrl, setOpenUrl] = useState(integration?.openUrl ?? "");
  const [kind, setKind] = useState<ServiceKindValue>((integration?.kind as ServiceKindValue | undefined) ?? pkgKind);
  const serviceFieldsSaved = integration ? integration.serviceSaved !== false : true;
  const serviceBody = () => (serviceFieldsSaved ? { openUrl: openUrl.trim(), kind } : {});
  const allFields0 = integration?.secretFields ?? pkg.secrets.map((s) => ({ ...s, set: false as boolean, updatedAt: undefined as string | undefined, required: true, viaCredential: false }));
  const [choices, setChoices] = useState<Record<string, FieldChoice>>(() => Object.fromEntries(allFields0.map((f) => [f.key, initialChoice(f)])));
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [successKey, setSuccessKey] = useState(0);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [pinAsk, setPinAsk] = useState<null | ((ok: boolean) => void)>(null);
  const askPinned = () => new Promise<boolean>((resolve) => setPinAsk(() => resolve));
  const allFields = allFields0;
  const applies = secretKeysFor(pkg.config, config, allFields.map((f) => f.key));
  const fields = allFields.filter((f) => applies.has(f.key));
  const locked = integration?.locked ?? false;
  const passed = result?.ok && result.health.status !== "down" ? result : null;
  const addressKey = Object.entries(props).find(([, p]) => p.format === "uri")?.[0];
  const origin = addressKey ? originOf(withScheme(String(config[addressKey] ?? ""))) : undefined;
  const savedOrigin = integration && addressKey ? originOf(withScheme(String(integration.config[addressKey] ?? ""))) : undefined;
  const movingAddress = !!integration && !!origin && !!savedOrigin && origin !== savedOrigin;
  const sameAddress = origin ? existing.filter((e) => e.origin === origin && e.id !== integration?.id) : [];
  const choiceOf = (k: string) => choices[k] ?? { mode: "value" as const, value: "", credentialId: "" };
  // Saved credential picks and typed values, for the fields that apply.
  const picks = Object.fromEntries(fields.flatMap((f) => { const c = choiceOf(f.key); return c.mode === "saved" && c.credentialId ? [[f.key, c.credentialId]] : []; }));
  const typedValues = Object.fromEntries(fields.flatMap((f) => { const c = choiceOf(f.key); return c.mode === "value" && c.value ? [[f.key, c.value]] : []; }));
  // A Basic auth field filled from a saved credential brings its own username: do not ask for one.
  const credentialUserKeys = new Set(fields.flatMap((f) => (f.auth.as === "basic" && choiceOf(f.key).mode === "saved" && f.auth.userKey ? [f.auth.userKey] : [])));
  // Picks to send on save: changed ones, and kept ones whose credential no longer lists this server
  // (a removed server is allowed again here, under the same confirm and step-up).
  const changedPicks = Object.entries(picks).filter(([k, id]) => integration?.secretFields.find((f) => f.key === k)?.credential?.id !== id || lockState(credentials.find((c) => c.id === id), origin) !== "here");
  // A credential with no lock yet is tested on this server without locking (Fix List r2 item 4). One
  // locked to another server cannot be tested here before "Also allow": Save asks first, then tests.
  const elsewherePick = Object.values(picks).find((id) => lockState(credentials.find((c) => c.id === id), origin) === "elsewhere");
  const saveAndTest = !!elsewherePick;
  const elsewhereName = elsewherePick ? credentials.find((c) => c.id === elsewherePick)?.name : undefined;

  // Any change to the form clears the last test result and any earlier note (usability r2 low).
  const change = (fn: () => void) => { fn(); if (result) setResult(null); if (saveError?.code === "credential_origin_confirm") setSaveError(null); };
  // Only the settings that apply are sent; a hidden choice's fields are left out.
  const shownConfig = () => Object.fromEntries(Object.entries(config).filter(([k]) => { const p = props[k]; return (!p || isShown(p, config, props)) && !credentialUserKeys.has(k); }));

  async function test() {
    setTesting(true);
    setSaveError(null);
    try {
      const body = { config: shownConfig(), secrets: typedValues, ...(Object.keys(picks).length ? { credentials: picks } : {}) };
      const url = integration ? `/api/integrations/${integration.id}/test` : "/api/integrations/test";
      const payload = integration ? body : { packageId: pkg.id, ...body };
      // Round 6 (Fix List r3 item 1): a picked credential not locked to any server yet is locked to
      // this one first, after "Lock <credential> to <server>?" and a step-up; cancelling tests nothing.
      const r = await locked$.save<TestResult>((confirmOrigins) => sendJson(url, "POST", { ...payload, ...(confirmOrigins ? { confirmOrigins: true } : {}) }), { verb: "tested" });
      const picked = new Set(Object.values(picks));
      if (origin && picked.size) setCredentials((list) => list.map((c) => (picked.has(c.id) && c.lockedOrigins.length === 0 ? { ...c, lockedOrigins: [origin] } : c)));
      setResult(r);
      if (r.ok) setSuccessKey((n) => n + 1);
    } catch (e) {
      if (e instanceof SaveCancelled) { setResult(null); setSaveError({ code: "credential_origin_confirm", message: e.message }); }
      else setResult({ ok: false, heading: "Not permitted", error: e instanceof ApiFailure ? e.error : { code: "unreachable", message: "The test did not finish." }, latencyMs: 0 });
    } finally {
      setTesting(false);
    }
  }

  /** After saving with a credential that was not locked here: the test runs on the saved integration. */
  async function testSaved(id: string): Promise<void> {
    const r = await api<TestResult>(`/api/integrations/${id}/test`, { body: { secrets: {} } });
    if (r.ok) toast({ kind: "success", title: "Connection works" });
    else toast({ kind: "error", title: r.heading, description: r.error.message });
  }

  async function save(untested: boolean) {
    setSaving(true);
    setSaveError(null);
    const typed = typedValues;
    try {
      if (integration) {
        const patch = (extra: Record<string, unknown>) => locked$.save((confirmOrigins) => sendJson(`/api/integrations/${integration.id}`, "PATCH", { name, config: shownConfig(), ...serviceBody(), ...extra, ...(confirmOrigins ? { confirmOrigins: true } : {}) }));
        try {
          await patch({});
        } catch (e) {
          if (!(e instanceof ApiFailure && e.error.code === "secrets_pinned")) throw e;
          const ok = await askPinned();
          setPinAsk(null);
          if (!ok) { setSaveError({ code: "secrets_pinned", message: "Not saved. The address and the saved credentials are unchanged." }); return; }
          await patch({ clearSecrets: true });
        }
        const credentialChanges = Object.fromEntries(changedPicks);
        if (Object.keys(typed).length || Object.keys(credentialChanges).length) {
          await locked$.save((confirmOrigins) => sendJson(`/api/integrations/${integration.id}/secrets`, "PUT", { secrets: typed, ...(Object.keys(credentialChanges).length ? { credentials: credentialChanges } : {}), ...(confirmOrigins ? { confirmOrigins: true } : {}) }));
        }
        if (saveAndTest) await testSaved(integration.id);
        else if (!untested && passed) await api(`/api/integrations/${integration.id}/test`, { body: { config: shownConfig(), secrets: {} } });
        setChoices((c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, { ...v, value: "" }])));
        toast({ kind: "success", title: "Saved" });
        router.refresh();
      } else {
        const created = await locked$.save<IntegrationView>((confirmOrigins) => sendJson("/api/integrations", "POST", {
          packageId: pkg.id, name, config: shownConfig(), secrets: typed, ...serviceBody(),
          ...(Object.keys(picks).length ? { credentials: picks } : {}),
          ...(untested || saveAndTest || !passed ? { untested: true } : { passId: passed.passId }),
          ...(confirmOrigins ? { confirmOrigins: true } : {}),
        }));
        toast({ kind: "success", title: `${created.name} saved` });
        if (saveAndTest) await testSaved(created.id);
        router.push(builderReturnFor(created.id) ?? `/integrations/${created.id}`);
      }
    } catch (e) {
      if (e instanceof SaveCancelled) { setResult(null); setSaveError({ code: "credential_origin_confirm", message: e.message }); }
      else setSaveError(e instanceof ApiFailure ? e.error : { code: "internal", message: "Saving failed." });
    } finally {
      setSaving(false);
    }
  }

  const errorId = `${uid}-err`;
  const saveBlocked = !integration && !passed && !saveAndTest ? (result && !result.ok ? "The last test failed. Fix the settings and test again, or use Save without testing." : "") : null;
  return (
    <Glow successKey={successKey || null} className="w-full">
      <Window
        as="section"
        title={integration ? integrationPath(integration, "connection") : `integrations / new / ${packageSegment(pkg.id)}`}
        status={integration ? <HealthStatus i={integration} /> : undefined}
        padded={false}
        aria-labelledby={`${uid}-title`}
        data-setup-form={pkg.id}
        onFocus={keepFocusedInView}
      >
        <div className="flex flex-col gap-5 p-6 max-sm:p-4">
        <header className="flex items-center gap-3">
          <span className="flex size-12 flex-none items-center justify-center bg-bg-sunk"><PackageIcon id={pkg.id} size={28} /></span>
          <div>
            <h2 id={`${uid}-title`} className="type-title-3 text-fg">Connection</h2>
            <p className="type-body text-fg-2">{integration ? pkg.name : "Where it is, and how Atrium signs in."}</p>
          </div>
        </header>
        {locked && <LockedNotice />}

        <fieldset className="flex flex-col gap-4" disabled={!canEdit}>
          <legend className="sr-only">Settings</legend>
          <Field label="Name" htmlFor={`${uid}-name`}>
            <Input id={`${uid}-name`} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </Field>
          {Object.entries(props).filter(([k, p]) => isShown(p, config, props) && !credentialUserKeys.has(k)).map(([key, p]) =>
            p.type === "boolean" ? (
              <label key={key} className="flex min-h-8 cursor-pointer items-center gap-3 touch:min-h-11" data-config-row={key}>
                <input type="checkbox" className="h-5 w-5 shrink-0 accent-accent" checked={config[key] === true} onChange={(e) => change(() => setConfig((c) => ({ ...c, [key]: e.target.checked })))} data-config={key} />
                <span><span className="block type-callout text-fg">{p.title ?? key}</span>{p.description && <span className="block type-caption text-glass-muted">{p.description}</span>}</span>
              </label>
            ) : Array.isArray(p.enum) ? (
              <Field key={key} label={p.title ?? key} hint={p.description} htmlFor={`${uid}-${key}`}>
                <select id={`${uid}-${key}`} className={inputClass} value={String(config[key] ?? "")} onChange={(e) => change(() => setConfig((c) => ({ ...c, [key]: e.target.value })))} aria-describedby={p.description ? `${uid}-${key}-hint` : undefined} data-config={key}>
                  {p.enum.map((v) => <option key={String(v)} value={String(v)}>{p["x-atrium-labels"]?.[String(v)] ?? String(v)}</option>)}
                </select>
              </Field>
            ) : (
              <Field key={key} label={p.title ?? key} hint={p.description} htmlFor={`${uid}-${key}`}>
                <Input
                  id={`${uid}-${key}`}
                  aria-describedby={p.description ? `${uid}-${key}-hint` : undefined}
                  type={p.type === "number" ? "number" : "text"}
                  value={String(config[key] ?? "")}
                  onChange={(e) => change(() => setConfig((c) => ({ ...c, [key]: e.target.value })))}
                  // A bare LAN address gets http:// the same way detection treats it, and is shown back.
                  onBlur={p.format === "uri" ? (e) => { const v = withScheme(e.target.value); if (v !== e.target.value) change(() => setConfig((c) => ({ ...c, [key]: v }))); } : undefined}
                  autoComplete="off"
                  {...(p.format === "uri" ? urlInputProps : {})}
                  data-config={key}
                />
              </Field>
            ),
          )}
          <Field label="Open address" hint={integration ? "Where a service tile takes you. Leave it empty for no link." : "Where a service tile takes you. Leave it empty to use the address above."} htmlFor={`${uid}-open-url`}>
            <Input
              id={`${uid}-open-url`}
              aria-describedby={`${uid}-open-url-hint`}
              value={openUrl}
              onChange={(e) => setOpenUrl(e.target.value)}
              onBlur={(e) => { const v = e.target.value.trim() ? withScheme(e.target.value) : ""; if (v !== e.target.value) setOpenUrl(v); }}
              placeholder={addressKey ? withScheme(String(config[addressKey] ?? "")) || "http://10.0.0.5:8096" : "http://10.0.0.5:8096"}
              autoComplete="off"
              {...urlInputProps}
              data-open-url
            />
          </Field>
          <Field label="Kind" hint="Groups this service on a start page." htmlFor={`${uid}-kind`}>
            <select id={`${uid}-kind`} className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as ServiceKindValue)} aria-describedby={`${uid}-kind-hint`} data-service-kind>
              {SERVICE_KIND_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </Field>
          {!serviceFieldsSaved && <p role="status" className="type-caption text-glass-muted" data-service-unsaved>Atrium needs a database update before it can keep the Open address and kind. They show their defaults until then.</p>}
          {sameAddress.length > 0 && (
            <p role="status" className="type-caption text-glass-muted" data-same-address>
              Already set up at this address: {sameAddress.map((e) => e.name).join(", ")}. Saving adds another integration.
            </p>
          )}
        </fieldset>

        {fields.length > 0 && (
          <fieldset className="flex flex-col gap-4" disabled={!canEdit}>
            <legend className="mb-1 type-callout text-fg">Credentials</legend>
            {fields.map((f) => (
              <SecretFieldInput key={f.key} uid={uid} field={f} choice={choiceOf(f.key)} credentials={credentials} origin={origin} packageName={pkg.name} movingAddress={movingAddress} onChange={(c) => change(() => setChoices((s) => ({ ...s, [f.key]: c })))} onCreated={(c) => setCredentials((list) => (list.some((x) => x.id === c.id) ? list : [...list, c]))} />
            ))}
          </fieldset>
        )}

        <div className="flex flex-col gap-3" aria-live="polite">
          {result?.ok && (
            <p className="flex flex-wrap items-center gap-3" data-test-success>
              <StatusCheck label="Connection works" />
              <span className="type-callout text-fg">{result.health.status === "ok" ? "Connected" : result.health.status === "degraded" ? "Connected, degraded" : "Down"}</span>
              <HealthLine {...result.health} />
            </p>
          )}
          {result && !result.ok && <ErrorCallout id={errorId} heading={result.heading} error={result.error} />}
          {saveError && (saveError.code === "credential_origin_confirm" || saveError.code === "secrets_pinned"
            ? <InfoNote>{saveError.message}</InfoNote>
            : <ErrorCallout error={saveError} heading={saveError.code === "untested" ? "Test first" : undefined} />)}
        </div>

        {canEdit && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              {/* One primary per view: Test connection until a test passes, then Save (design v4). */}
              {!saveAndTest && (
                <PrimarySwap active={!passed && !integration}>
                  <Button variant={!passed && !integration ? "primary" : "secondary"} onClick={() => void test()} disabled={testing || saving} aria-busy={testing} data-test-button>
                    {testing && <Spinner label="Testing" />} Test connection
                  </Button>
                </PrimarySwap>
              )}
              {/* Premium r3: no disabled Save before a test; Test connection and Save without testing only. */}
              {saveBlocked === null && (
                <PrimarySwap active={!!passed || saveAndTest || !!integration}>
                  <Button variant={passed || saveAndTest || integration ? "primary" : "secondary"} onClick={() => void save(false)} disabled={saving || testing} aria-describedby={saveAndTest ? `${uid}-save-test-why` : undefined} data-save-button>
                    {saving && <Spinner label="Saving" />} {saveAndTest ? "Save and test" : "Save"}
                  </Button>
                </PrimarySwap>
              )}
              {!integration && !saveAndTest && (
                <Button variant="quiet" onClick={() => void save(true)} disabled={saving || testing} data-save-untested>Save without testing</Button>
              )}
            </div>
            {!!saveBlocked && <p id={`${uid}-save-why`} className="type-caption text-fg-2" data-save-why>{saveBlocked}</p>}
            {saveAndTest && <p id={`${uid}-save-test-why`} className="type-caption text-fg-2" data-save-test-why>{elsewhereName ?? "The saved credential"} is locked to another server, so it cannot be tested here yet. Save and test asks you to allow {origin ?? "this server"} first, then tests it.</p>}
          </div>
        )}
      </div></Window>
      {locked$.dialog}
      <Sheet
        open={!!pinAsk}
        onOpenChange={(o) => { if (!o) pinAsk?.(false); }}
        title="Remove the saved credentials and move?"
        path={integration ? integrationPath(integration, "new address") : "integrations / new address"}
        name="pinned-move-confirm"
        width={460}
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="quiet" onClick={() => pinAsk?.(false)} data-pinned-cancel>Keep the old address</Button>
            <Button variant="destructive-confirm" onClick={() => pinAsk?.(true)} data-pinned-confirm>Remove and save</Button>
          </div>
        }
      >
        <p className="type-body text-fg" data-pinned-question>{PINNED_CONFIRM} New address: <span className="font-mono">{origin}</span>.</p>
      </Sheet>
    </Glow>
  );
}
