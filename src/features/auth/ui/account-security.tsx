"use client";
// The signed-in user's own security: password change, sessions with "Sign out all other devices", and
// TOTP with backup codes (shown once). Settings mounts these through SecuritySettingsPanel
// (`@/features/auth/settings-panels`) at /settings/security.
import { useEffect, useState, useTransition, type FormEvent } from "react";
import { Button } from "@/features/shell";
import { listMySessionsAction, signOutOthersAction } from "../actions";
import type { MySession } from "../server/manage";
import { FormMessage, TextField } from "./fields";
import { QrCode } from "./qr-code";
import { MESSAGES } from "./messages";

function device(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function SessionsPanel() {
  const [list, setList] = useState<MySession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const load = () =>
    start(async () => {
      const r = await listMySessionsAction();
      if (r.ok) setList(r.data);
      else setError(r.message);
    });
  useEffect(load, []);

  const others = (list ?? []).filter((s) => !s.current).length;
  return (
    <section aria-labelledby="sessions-heading" className="flex flex-col gap-4" data-sessions-panel>
      <div>
        <h2 id="sessions-heading" className="type-title-3 text-fg">
          Sessions
        </h2>
        <p className="type-body text-fg-muted">Devices signed in to your account. A session ends after 30 days without use.</p>
      </div>
      <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-bg-raised" aria-busy={list === null}>
        {(list ?? []).map((s) => (
          <li key={s.id} className="flex items-center gap-3 p-4">
            <div className="min-w-0 flex-1">
              <p className="type-body text-fg">
                {device(s.userAgent)}
                {s.current && <span className="ml-2 type-caption text-accent-ink">This device</span>}
              </p>
              <p className="type-caption text-fg-muted tabular">Last used {when(s.lastUsedAt)}</p>
            </div>
          </li>
        ))}
        {list === null && <li className="p-4 type-body text-fg-muted">Loading sessions</li>}
      </ul>
      <div>
        <Button
          variant="secondary"
          className="h-11!"
          disabled={pending || others === 0}
          onClick={() =>
            start(async () => {
              setError(null);
              const r = await signOutOthersAction();
              if (!r.ok) setError(r.message);
              else {
                setNotice(r.data === 1 ? "Signed out 1 other device." : `Signed out ${r.data} other devices.`);
                const again = await listMySessionsAction();
                if (again.ok) setList(again.data);
              }
            })
          }
        >
          Sign out all other devices
        </Button>
      </div>
      <FormMessage message={error} />
      <FormMessage message={notice} tone="info" />
    </section>
  );
}

type Enrol = { totpURI: string; backupCodes: string[] };

// Round 6 (architecture v3 A4.4: Security holds the password). The server checks the new password
// (length, common list) and ends every other session of the user; this device gets a fresh session.
export function PasswordPanel({ hasPassword }: { hasPassword: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const currentPassword = String(data.get("currentPassword") ?? "");
    const newPassword = String(data.get("newPassword") ?? "");
    const confirm = String(data.get("confirmPassword") ?? "");
    setError(null);
    setNotice(null);
    if (newPassword !== confirm) {
      setMismatch("The two new passwords do not match.");
      return;
    }
    setMismatch(undefined);
    setBusy(true);
    void call("/change-password", { currentPassword, newPassword })
      .then(() => {
        form.reset();
        setNotice("Password changed. Every other device was signed out.");
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  return (
    <section aria-labelledby="password-heading" className="flex flex-col gap-4" data-password-panel>
      <div>
        <h2 id="password-heading" className="type-title-3 text-fg">
          Password
        </h2>
        <p className="type-body text-fg-muted">
          {hasPassword
            ? "Changing it signs out every other device. Use at least 12 characters."
            : "You sign in with Google or your identity provider, so there is no Atrium password to change. The owner can send you a reset link to add one."}
        </p>
      </div>
      {hasPassword && (
        <form onSubmit={submit} className="flex flex-col gap-3 sm:max-w-md">
          <TextField label="Current password" name="currentPassword" type="password" autoComplete="current-password" required />
          <TextField label="New password" name="newPassword" type="password" autoComplete="new-password" minLength={12} required />
          <TextField label="New password again" name="confirmPassword" type="password" autoComplete="new-password" minLength={12} required fieldError={mismatch} />
          {/* Secondary: the screen keeps one gold primary (authenticator setup, design v4). */}
          <Button type="submit" variant="secondary" className="h-11! self-start" disabled={busy}>
            Change password
          </Button>
        </form>
      )}
      <FormMessage message={error} />
      <FormMessage message={notice} tone="info" />
    </section>
  );
}

async function call(path: string, body: unknown) {
  const r = await fetch(`/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await r.json().catch(() => ({}))) as Record<string, unknown> & { message?: string; error?: { message?: string } };
  if (!r.ok) throw new Error(json.error?.message ?? (r.status === 429 ? String(json.message ?? MESSAGES.generic) : r.status === 400 || r.status === 401 ? "That password or code is not right. Try again." : MESSAGES.generic));
  return json;
}

export function TwoFactorPanel({ enabled: initiallyEnabled, hasPassword }: { enabled: boolean; hasPassword: boolean }) {
  const [enabled, setEnabled] = useState(initiallyEnabled);
  const [enrol, setEnrol] = useState<Enrol | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function guard(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const start = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get("password") ?? "");
    void guard(async () => {
      const r = (await call("/two-factor/enable", hasPassword ? { password } : {})) as unknown as Enrol;
      setEnrol(r);
      setCodes(null);
    });
  };
  const confirm = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code") ?? "");
    void guard(async () => {
      await call("/two-factor/verify-totp", { code });
      setCodes(enrol?.backupCodes ?? null);
      setEnrol(null);
      setEnabled(true);
    });
  };
  const regenerate = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get("password") ?? "");
    void guard(async () => {
      const r = (await call("/two-factor/generate-backup-codes", hasPassword ? { password } : {})) as unknown as { backupCodes: string[] };
      setCodes(r.backupCodes);
    });
  };

  const secret = enrol ? new URL(enrol.totpURI).searchParams.get("secret") : null;
  return (
    <section aria-labelledby="totp-heading" className="flex flex-col gap-4" data-two-factor-panel>
      <div>
        <h2 id="totp-heading" className="type-title-3 text-fg">
          Authenticator app
        </h2>
        <p className="type-body text-fg-muted">
          {enabled ? "On. Sign-in asks for a 6-digit code after your password." : "Recommended. Sign-in will also ask for a 6-digit code from an app on your phone."}
        </p>
      </div>
      {!enabled && !enrol && (
        <form onSubmit={start} className="flex flex-col gap-3 sm:max-w-md">
          {hasPassword && (
            <div className="flex-1">
              <TextField label="Your password" hint="Enter your password to start setup." name="password" type="password" autoComplete="current-password" required />
            </div>
          )}
          <Button type="submit" variant="primary" className="h-11! self-start" disabled={busy}>
            Set up authenticator app
          </Button>
        </form>
      )}
      {enrol && (
        <form onSubmit={confirm} className="flex flex-col gap-3">
          <p className="type-body text-fg">Scan this code with your authenticator app, or type the key, then enter the code it shows.</p>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <QrCode value={enrol.totpURI} label="QR code to add Atrium to your authenticator app" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="type-callout text-fg-muted">Or type this key</p>
              <p className="break-all rounded-sm border border-line bg-bg-raised p-3 font-mono type-body text-fg" data-totp-key>
                {secret}
              </p>
            </div>
          </div>
          <TextField label="6-digit code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required />
          <Button type="submit" variant="primary" className="h-11! self-start" disabled={busy}>
            Turn on
          </Button>
        </form>
      )}
      {codes && (
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-bg-raised p-4" data-backup-codes>
          <p className="type-body text-fg">Your 10 backup codes. Save them now: they are shown only once, and each works once.</p>
          <ol className="grid grid-cols-2 gap-2 font-mono type-body text-fg tabular">
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ol>
        </div>
      )}
      {enabled && (
        <form onSubmit={regenerate} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          {hasPassword && (
            <div className="flex-1">
              <TextField label="Your password" name="password" type="password" autoComplete="current-password" required />
            </div>
          )}
          <Button type="submit" variant="secondary" className="h-11!" disabled={busy}>
            New backup codes
          </Button>
        </form>
      )}
      <FormMessage message={error} />
    </section>
  );
}
