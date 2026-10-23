"use client";
// Sign-in screen (auth spec "States"): email and password, then a TOTP or backup code when
// enrolled, plus one button per configured provider. No sign-up option exists.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/features/shell";
import { FormMessage, Spinner, TextField } from "./fields";
import { MESSAGES, messageFor, providerErrorMessage } from "./messages";
import { safeNext } from "../safe-next";

export type ProviderButton = { id: string; name: string };

type Step = "password" | "totp" | "backup";

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
}

type SignInProps = {
  providers: ProviderButton[];
  next: string;
  initialError?: string | null;
  /** The signed authorization request when an MCP client sent the user here (OAuth provider). */
  oauthQuery?: string | null;
};

export function SignInForm({ providers, next, initialError, oauthQuery }: SignInProps) {
  const [step, setStep] = useState<Step>("password");
  const [busy, setBusy] = useState<null | "form" | string>(null);
  const [error, setError] = useState<string | null>(providerErrorMessage(initialError));
  const [code, setCode] = useState("");
  const codeRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  // Empty fields are named next to the field before anything is sent (usability r2: an empty form
  // must not say "not on the allowlist").
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});

  useEffect(() => {
    if (step !== "password") codeRef.current?.focus();
  }, [step]);

  // Sends the user on: back into the OAuth flow (consent or the agent's redirect) when one is running.
  const done = (body?: { redirect?: boolean; url?: string }) => window.location.assign(body?.redirect && body.url ? body.url : safeNext(next));
  const withOAuth = <T extends Record<string, unknown>>(b: T) => (oauthQuery ? { ...b, oauth_query: oauthQuery } : b);

  async function onPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const data = new FormData(e.currentTarget);
    const email = String(data.get("email") ?? "").trim();
    const password = String(data.get("password") ?? "");
    const missing = { email: email ? undefined : MESSAGES.enterEmail, password: password ? undefined : MESSAGES.enterPassword };
    setFieldErrors(missing);
    if (missing.email || missing.password) {
      setError(null);
      (missing.email ? emailRef : passwordRef).current?.focus();
      return;
    }
    setBusy("form");
    setError(null);
    try {
      const res = await post("/sign-in/email", withOAuth({ email, password, rememberMe: true }));
      if (!res.ok) {
        const message = await messageFor(res, "password");
        setError(message);
        // A refused attempt: the password is cleared and focused, ready to type again. When the email
        // itself was the problem, focus goes to the email instead.
        if (passwordRef.current) passwordRef.current.value = "";
        const emailProblem = message === MESSAGES.notAllowlisted || message === MESSAGES.enterEmail || message.includes("no password");
        setTimeout(() => (emailProblem ? emailRef : passwordRef).current?.focus(), 0);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { twoFactorRedirect?: boolean; redirect?: boolean; url?: string };
      if (body.twoFactorRedirect) {
        setStep("totp");
        setCode("");
        return;
      }
      done(body);
    } catch {
      setError(MESSAGES.network);
    } finally {
      setBusy(null);
    }
  }

  async function onCode(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy("form");
    setError(null);
    try {
      const res = step === "totp" ? await post("/two-factor/verify-totp", withOAuth({ code: code.trim() })) : await post("/two-factor/verify-backup-code", withOAuth({ code: code.trim() }));
      if (!res.ok) {
        setError(await messageFor(res, step === "totp" ? "totp" : "backup"));
        return;
      }
      done((await res.json().catch(() => ({}))) as { redirect?: boolean; url?: string });
    } catch {
      setError(MESSAGES.network);
    } finally {
      setBusy(null);
    }
  }

  async function onProvider(id: string) {
    if (busy) return;
    setBusy(id);
    setError(null);
    try {
      const res = await post("/sign-in/social", withOAuth({ provider: id, callbackURL: safeNext(next), errorCallbackURL: "/sign-in" }));
      const body = (await res.json().catch(() => ({}))) as { url?: string };
      if (!res.ok || !body.url) {
        setError(res.status === 429 ? await messageFor(res, "password") : MESSAGES.providerFailed);
        setBusy(null);
        return;
      }
      window.location.assign(body.url); // keeps the "Signing you in" state until the provider loads
    } catch {
      setError(MESSAGES.network);
      setBusy(null);
    }
  }

  if (step !== "password") {
    const totpStep = step === "totp";
    return (
      <form onSubmit={onCode} noValidate aria-describedby="signin-message" className="flex flex-col gap-5" data-step={step}>
        <div className="flex flex-col gap-1">
          <h1 className="type-title-1 text-fg">{totpStep ? "Enter your code" : "Use a backup code"}</h1>
          <p className="type-body text-fg-muted">
            {totpStep ? "Open your authenticator app and enter the 6-digit code for Atrium." : "Enter one of the backup codes you saved. Each code works once."}
          </p>
        </div>
        <TextField
          ref={codeRef}
          label={totpStep ? "6-digit code" : "Backup code"}
          name="code"
          inputMode={totpStep ? "numeric" : "text"}
          autoComplete="one-time-code"
          pattern={totpStep ? "[0-9]{6}" : undefined}
          maxLength={totpStep ? 6 : 32}
          required
          value={code}
          onChange={(e) => setCode(totpStep ? e.target.value.replace(/\D/g, "") : e.target.value)}
          error={error ?? undefined}
        />
        <FormMessage id="signin-message" message={error} />
        <Button type="submit" variant="primary" className="h-11! w-full" disabled={busy !== null || code.trim().length < (totpStep ? 6 : 8)} aria-busy={busy === "form"}>
          {busy === "form" ? (
            <>
              <Spinner /> Checking
            </>
          ) : (
            "Continue"
          )}
        </Button>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            variant="quiet"
            className="h-11! px-3"
            onClick={() => {
              setStep(totpStep ? "backup" : "totp");
              setCode("");
              setError(null);
            }}
          >
            {totpStep ? "Use a backup code instead" : "Use my authenticator app"}
          </Button>
          <Button
            variant="quiet"
            className="h-11! px-3"
            onClick={() => {
              setStep("password");
              setError(null);
              setTimeout(() => emailRef.current?.focus(), 0);
            }}
          >
            Back
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <h1 className="type-title-1 text-fg">Sign in to Atrium</h1>
        <p className="type-body text-fg-muted">Your homelab, in one bright room.</p>
      </div>
      <form onSubmit={onPassword} noValidate aria-describedby="signin-message" className="flex flex-col gap-4" data-step="password">
        <TextField
          ref={emailRef}
          label="Email"
          name="email"
          type="email"
          autoComplete="username"
          required
          autoFocus
          fieldError={fieldErrors.email}
          onChange={() => fieldErrors.email && setFieldErrors((f) => ({ ...f, email: undefined }))}
        />
        <TextField
          ref={passwordRef}
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          fieldError={fieldErrors.password}
          onChange={() => fieldErrors.password && setFieldErrors((f) => ({ ...f, password: undefined }))}
        />
        <FormMessage id="signin-message" message={error} />
        <Button type="submit" variant="primary" className="h-11! w-full" disabled={busy !== null} aria-busy={busy === "form"}>
          {busy === "form" ? (
            <>
              <Spinner /> Signing in
            </>
          ) : (
            "Sign in"
          )}
        </Button>
      </form>
      {providers.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3 type-caption text-fg-muted" aria-hidden>
            <span className="h-px flex-1 bg-line" />
            or
            <span className="h-px flex-1 bg-line" />
          </div>
          {providers.map((p) => (
            <Button key={p.id} variant="secondary" className="h-11! w-full" disabled={busy !== null} aria-busy={busy === p.id} onClick={() => onProvider(p.id)} data-provider={p.id}>
              {busy === p.id ? (
                <>
                  <Spinner /> Signing you in
                </>
              ) : (
                `Continue with ${p.name}`
              )}
            </Button>
          ))}
        </div>
      )}
      <details className="group" data-recovery-hint>
        <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-sm type-callout text-fg-muted marker:content-none hover:text-fg">Forgot your password?</summary>
        <div className="flex flex-col gap-2 pt-1 type-body text-fg-muted" data-recovery-steps>
          <p>Members and viewers: ask the owner of this Atrium for a reset link. You choose the new password yourself.</p>
          <p>
            Owner: reset yours on the server Atrium runs on. In the Atrium folder, run the command below. It asks for a new password twice, then signs out every
            device.
          </p>
          <code className="block w-full overflow-x-auto border border-line-strong bg-bg px-3 py-2 font-mono type-label text-fg select-all" data-recovery-command>
            pnpm atrium:reset-owner
          </code>
          <p>
            In Docker, run it inside the container: <code className="font-mono type-label text-fg select-all">docker exec -it &lt;container&gt; pnpm atrium:reset-owner</code>.
            Or set <code className="font-mono type-label text-fg">ATRIUM_RESET_OWNER_PASSWORD</code> to the new password and restart Atrium once, then remove it.
          </p>
        </div>
      </details>
    </div>
  );
}
