"use client";
// The invite and reset page body (Amendment 3, auth-spec-v3). The person sees their email (not
// editable), chooses a password twice, and is then signed in (invite, with an optional authenticator
// app) or sent to sign in (reset). Nothing is sent until both fields pass the password rules.
import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/features/shell";
import { CONTROL_TYPE, FormMessage, Spinner, TextField } from "./fields";
import { TwoFactorPanel } from "./account-security";
import { LINK_MESSAGES } from "../account-links/policy";

const MIN = 12;
const RULES = `At least ${MIN} characters, and not a common password.`;

type Props = { token: string; kind: "invite" | "reset"; email: string; role?: "member" | "viewer" };
type Problem = { field: "password" | "confirm" | "form"; message: string };

export function AccountLinkForm({ token, kind, email, role }: Props) {
  const [step, setStep] = useState<"form" | "invite_done" | "reset_done">("form");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  const fail = (p: Problem) => {
    setProblem(p);
    setTimeout(() => (p.field === "confirm" ? confirmRef : passwordRef).current?.focus(), 0);
  };

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const f = new FormData(e.currentTarget);
    const password = String(f.get("password") ?? "");
    const confirm = String(f.get("confirm") ?? "");
    if (!password) return fail({ field: "password", message: LINK_MESSAGES.enterPassword });
    if (password.length < MIN) return fail({ field: "password", message: `Use at least ${MIN} characters.` });
    if (confirm !== password) return fail({ field: "confirm", message: LINK_MESSAGES.passwordMismatch });
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch(`/invite/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password, confirm }),
      });
      const body = (await res.json().catch(() => ({}))) as { state?: string; field?: string; message?: string };
      if (body.state === "expired") return window.location.assign("/invite/expired");
      if (body.state === "signed_in") return window.location.assign("/invite/signed-in");
      if (res.status === 429) return fail({ field: "form", message: body.message ?? "Too many attempts. Try again in a minute." });
      if (body.state === "invalid") return fail({ field: body.field === "confirm" ? "confirm" : "password", message: body.message ?? RULES });
      if (body.state === "invite_done") return setStep("invite_done");
      if (body.state === "reset_done") return setStep("reset_done");
      fail({ field: "form", message: "Something went wrong. Try again." });
    } catch {
      fail({ field: "form", message: "Atrium could not be reached. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  if (step === "invite_done") {
    return (
      <div className="flex flex-col gap-6" data-account-link-done="invite">
        <div className="flex flex-col gap-3">
          <h1 className="type-title-2 text-fg">You are signed in</h1>
          <p className="type-body text-fg-2">
            Your account is ready. Next time, sign in with {email} and the password you just chose.
          </p>
        </div>
        <TwoFactorPanel enabled={false} hasPassword />
        <Button href="/" variant="secondary" className="h-11! self-start" data-continue>
          Continue to Atrium
        </Button>
      </div>
    );
  }

  if (step === "reset_done") {
    return (
      <div className="flex flex-col gap-5" data-account-link-done="reset">
        <h1 className="type-title-2 text-fg">Password changed</h1>
        <p className="type-body text-fg-2">Sign in with your new password. Every device that used the old one has been signed out.</p>
        <Button href="/sign-in" variant="primary" className="h-11! self-start">
          Sign in
        </Button>
      </div>
    );
  }

  const invite = kind === "invite";
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5" data-account-link-form={kind} aria-describedby={problem?.field === "form" ? "link-message" : undefined}>
      <div className="flex flex-col gap-3">
        <h1 className="type-title-2 text-fg">{invite ? "Join this Atrium" : "Choose a new password"}</h1>
        <p className="type-body text-fg-2">
          {invite
            ? `You were invited as a ${role === "member" ? "member: you can build and edit apps you are given" : "viewer: you can open the apps shared with you"}. Choose a password to finish.`
            : "Choose a new password for your account. Every device signed in with the old one will be signed out."}
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="link-email" className="type-callout text-fg">
          Email
        </label>
        <input
          id="link-email"
          name="email"
          type="email"
          value={email}
          readOnly
          autoComplete="username"
          aria-readonly="true"
          className={`h-11 w-full rounded-sm border border-line bg-bg-sunk px-3 ${CONTROL_TYPE} text-fg`}
          data-link-email
        />
      </div>
      <TextField
        ref={passwordRef}
        label={invite ? "Password" : "New password"}
        name="password"
        type="password"
        autoComplete="new-password"
        hint={RULES}
        required
        fieldError={problem?.field === "password" ? problem.message : null}
        onChange={() => problem?.field === "password" && setProblem(null)}
      />
      <TextField
        ref={confirmRef}
        label="Type it again"
        name="confirm"
        type="password"
        autoComplete="new-password"
        required
        fieldError={problem?.field === "confirm" ? problem.message : null}
        onChange={() => problem?.field === "confirm" && setProblem(null)}
      />
      <FormMessage id="link-message" message={problem?.field === "form" ? problem.message : null} />
      <Button type="submit" variant="primary" className="h-11! w-full" disabled={busy} aria-busy={busy || undefined}>
        {busy ? (
          <>
            <Spinner /> {invite ? "Creating your account" : "Saving"}
          </>
        ) : invite ? (
          "Create my account"
        ) : (
          "Save new password"
        )}
      </Button>
    </form>
  );
}
