"use client";
// MCP OAuth consent screen (architecture section 9b): the client name and every requested scope.
// Allow and Deny post to Better Auth's /oauth2/consent with the signed request. Granting
// atrium:propose needs step-up: the server answers 403 step_up_required and the sheet opens, then the
// grant is retried once. Cancelling the step-up grants nothing.
import { useState } from "react";
import { Button } from "@/features/shell";
import { FormMessage, Spinner } from "./fields";
import { MESSAGES } from "./messages";
import { StepUpProvider, useStepUp } from "./step-up";

export const SCOPE_TEXT: Record<string, { title: string; detail: string }> = {
  "atrium:read": { title: "Read your dashboards", detail: "See pages, widgets, integrations and their data. Never secrets." },
  "atrium:edit": { title: "Draft changes", detail: "Propose new pages, widgets and integrations as drafts you publish." },
  "atrium:propose": { title: "Propose actions", detail: "Ask to run actions. Each one waits for your approval. Needs you to confirm it is you." },
  offline_access: { title: "Stay connected", detail: "Keep access after this hour by refreshing its token, until you revoke it." },
};

function scopeText(s: string) {
  return SCOPE_TEXT[s] ?? { title: s, detail: "A permission Atrium does not describe." };
}

export type ConsentRequest = { clientName: string; clientUri?: string | null; scopes: string[]; busy?: boolean; onAllow: () => void; onDeny: () => void };

/** The consent view itself (presentational). */
export function ConsentScreen({ clientName, clientUri, scopes, busy = false, onAllow, onDeny }: ConsentRequest) {
  let host: string | null = null;
  try {
    host = clientUri ? new URL(clientUri).host : null;
  } catch {
    host = null;
  }
  return (
    <div className="flex flex-col gap-6" data-consent>
      <div className="flex flex-col gap-1">
        <h1 className="type-title-2 text-fg">Allow {clientName}?</h1>
        <p className="type-body text-fg-muted">
          This agent will act as you, within your role, and only with what you allow here.{host ? ` It says it is from ${host}.` : ""}
        </p>
      </div>
      <ul className="flex flex-col gap-3" aria-label="Permissions asked for">
        {scopes.map((s) => (
          <li key={s} className="rounded-md border border-line bg-bg-raised p-3" data-scope={s}>
            <p className="type-body text-fg">{scopeText(s).title}</p>
            <p className="type-caption text-fg-muted">
              <span className="font-mono">{s}</span> · {scopeText(s).detail}
            </p>
          </li>
        ))}
      </ul>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="secondary" className="h-11!" onClick={onDeny} disabled={busy}>
          Deny
        </Button>
        <Button variant="primary" className="h-11!" onClick={onAllow} disabled={busy} aria-busy={busy}>
          {busy ? (
            <>
              <Spinner /> Allowing
            </>
          ) : (
            "Allow"
          )}
        </Button>
      </div>
    </div>
  );
}

type FlowProps = { clientName: string; clientUri?: string | null; scopes: string[]; oauthQuery: string };

function Flow({ clientName, clientUri, scopes, oauthQuery }: FlowProps) {
  const run = useStepUp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(accept: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const send = () =>
        fetch("/api/auth/oauth2/consent", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ accept, oauth_query: oauthQuery }),
        });
      const res = accept ? await run(send, { reason: `Confirm it is you to give ${clientName} the access listed here.` }) : await send();
      if (!res) return; // step-up cancelled: nothing was granted
      const body = (await res.json().catch(() => ({}))) as { url?: string; redirect_uri?: string; error?: { message?: string } };
      const to = body.url ?? body.redirect_uri;
      if (!res.ok || !to) {
        setError(body.error?.message ?? "The request has expired. Start the connection again from your agent.");
        return;
      }
      window.location.assign(to);
    } catch {
      setError(MESSAGES.network);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <ConsentScreen clientName={clientName} clientUri={clientUri} scopes={scopes} busy={busy} onAllow={() => void decide(true)} onDeny={() => void decide(false)} />
      <FormMessage message={error} />
    </div>
  );
}

/** The live consent flow for a signed authorization request. */
export function ConsentFlow(props: FlowProps) {
  return (
    <StepUpProvider>
      <Flow {...props} />
    </StepUpProvider>
  );
}
