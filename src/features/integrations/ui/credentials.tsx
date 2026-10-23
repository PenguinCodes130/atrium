"use client";
// The credentials page an agent's link opens (architecture v2 section 9b): the draft's secret
// fields only, a test, and publish. Values go to the server once and are never shown again.
// Round 4 (Amendment 2): each field can use a saved credential, already chosen when the agent
// proposed one; publishing locks it to this server, or asks to allow a new server with a step-up.
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Button, Glow, Screen, ScreenHeader, StatusCheck, usePageTitle, Window } from "@/features/shell";
import { StepUpProvider } from "@/features/auth/components";
import type { IntegrationView } from "../service";
import { ApiFailure, ErrorCallout, HealthLine, InfoNote, integrationPath, Spinner, type ApiError } from "./common";
import { CanChangeList, type CommandsData } from "./commands";
import { initialChoice, SecretFieldInput, type FieldChoice, type PickableCredential } from "./credential-picker";
import { SaveCancelled, sendJson, useLockedSave } from "./locked-save";

type TestResult = { ok: true; health: { status: "ok" | "degraded" | "down"; latencyMs: number; version?: string } } | { ok: false; heading: string; error: ApiError };

type Props = { integration: IntegrationView; token: string; canChange?: CommandsData["pending"]; credentials?: PickableCredential[]; origin?: string | undefined };

export function CredentialsForm(props: Props) {
  return <StepUpProvider><CredentialsFormInner {...props} /></StepUpProvider>;
}

function CredentialsFormInner({ integration, token, canChange = [], credentials: credentials0 = [], origin }: Props) {
  const [credentials, setCredentials] = useState(credentials0);
  usePageTitle("Credentials");
  const router = useRouter();
  const uid = useId();
  const locked$ = useLockedSave();
  const [choices, setChoices] = useState<Record<string, FieldChoice>>(() => Object.fromEntries(integration.secretFields.map((f) => [f.key, initialChoice(f)])));
  const [busy, setBusy] = useState<"test" | "publish" | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [key, setKey] = useState(0);
  const [error, setError] = useState<ApiError | null>(null);
  const choiceOf = (k: string) => choices[k] ?? { mode: "value" as const, value: "", credentialId: "" };
  const values = Object.fromEntries(integration.secretFields.flatMap((f) => { const c = choiceOf(f.key); return c.mode === "value" && c.value ? [[f.key, c.value]] : []; }));
  const picks = Object.fromEntries(integration.secretFields.flatMap((f) => { const c = choiceOf(f.key); return c.mode === "saved" && c.credentialId ? [[f.key, c.credentialId]] : []; }));
  const complete = integration.secretFields.every((f) => {
    if (!f.required) return true;
    const c = choiceOf(f.key);
    if (c.mode === "saved") return !!c.credentialId;
    return !!c.value || (f.set && !f.viaCredential);
  });

  async function runTest() {
    setBusy("test");
    setError(null);
    try {
      // A picked credential with no lock yet is locked to this server first (confirm and step-up, r6).
      const r = await locked$.save<TestResult>((confirmOrigins) => sendJson(`/api/integrations/${integration.id}/test`, "POST", { secrets: values, ...(Object.keys(picks).length ? { credentials: picks } : {}), ...(confirmOrigins ? { confirmOrigins: true } : {}) }), { verb: "tested" });
      const picked = new Set(Object.values(picks));
      if (origin && picked.size) setCredentials((list) => list.map((c) => (picked.has(c.id) && c.lockedOrigins.length === 0 ? { ...c, lockedOrigins: [origin] } : c)));
      setTest(r);
      if (r.ok) setKey((n) => n + 1);
    } catch (e) {
      if (e instanceof SaveCancelled) setError({ code: "credential_origin_confirm", message: e.message });
      else setError(e instanceof ApiFailure ? e.error : { code: "internal", message: "The test did not finish." });
    }
    finally { setBusy(null); }
  }

  async function publish() {
    setBusy("publish");
    setError(null);
    try {
      await locked$.save((confirmOrigins) => sendJson(`/api/integrations/${integration.id}/publish`, "POST", { token, secrets: values, ...(Object.keys(picks).length ? { credentials: picks } : {}), ...(confirmOrigins ? { confirmOrigins: true } : {}) }));
      router.push(`/integrations/${integration.id}`);
    } catch (e) {
      if (e instanceof SaveCancelled) setError({ code: "credential_origin_confirm", message: e.message });
      else setError(e instanceof ApiFailure ? e.error : { code: "internal", message: "Publishing failed." });
    }
    finally { setBusy(null); }
  }

  return (
    <Screen data-credentials-page>
      <ScreenHeader title={`Credentials for ${integration.name}`} lead="Your agent set this up as a draft. Paste the key here, or use a saved credential; the agent never sees it." />
      <div className="flex max-w-2xl flex-col gap-6">
      <Glow successKey={key || null}>
        <Window as="section" title={integrationPath(integration, "credentials")} status="draft" padded={false}>
          <div className="flex flex-col gap-4 p-6 max-sm:p-4">
          {integration.secretFields.length === 0 && <p className="type-body text-fg">This integration needs no credentials.</p>}
          {integration.secretFields.map((f) => (
            <SecretFieldInput key={f.key} uid={uid} field={f} choice={choiceOf(f.key)} credentials={credentials} origin={origin} packageName={integration.packageName} onChange={(c) => setChoices((s) => ({ ...s, [f.key]: c }))} onCreated={(c) => setCredentials((list) => (list.some((x) => x.id === c.id) ? list : [...list, c]))} />
          ))}
          {test?.ok && <p className="flex items-center gap-3" data-test-success><StatusCheck /><HealthLine {...test.health} /></p>}
          {test && !test.ok && <ErrorCallout heading={test.heading} error={test.error} />}
          {error && (error.code === "credential_origin_confirm" ? <InfoNote>{error.message}</InfoNote> : <ErrorCallout error={error} />)}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => void runTest()} disabled={busy !== null} aria-busy={busy === "test"} data-test-button>{busy === "test" && <Spinner />} Test connection</Button>
            <Button variant="primary" onClick={() => void publish()} disabled={busy !== null || !complete} data-publish>{busy === "publish" && <Spinner />} Save and publish</Button>
          </div>
        </div></Window>
      </Glow>
      {locked$.dialog}
      <CanChangeList items={canChange} intro="Publishing lets controls on published apps run these commands. Every run is recorded in the audit log." />
      </div>
    </Screen>
  );
}
