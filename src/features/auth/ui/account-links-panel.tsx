"use client";
// Invite and reset links on the users and security screen (Amendment 3, auth-spec-v3). The owner
// invites a person by exact email and role; the link is shown once (text, QR code, copy); every link
// is listed with its status, and waiting ones can be revoked. The server checks the owner every time.
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button, Window, toast } from "@/features/shell";
import type { AccountLinkView } from "../account-links/service";
import { DEFAULT_DAYS } from "../account-links/policy";
import { createInviteAction, revokeLinkAction } from "../actions";
// Settings r3 shared file request (gauntlet w2-r2): the shell's square menu instead of native selects.
import { SelectMenu } from "@/features/settings/ui/controls";
import { FormMessage, TextField } from "./fields";
import { QrCode } from "./qr-code";

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");
const DAY_CHOICES = [1, 3, 7, 14, 30];
const DAY_OPTIONS = DAY_CHOICES.map((d) => ({ value: String(d), label: d === 1 ? "1 day" : `${d} days` }));
const ROLE_OPTIONS = [
  { value: "viewer", label: "Viewer" },
  { value: "member", label: "Member" },
] as const;

export type ShownLink = { url: string; kind: "invite" | "reset"; email: string; expiresAt: string };

/** How people the owner adds sign in on this instance (usability r3). */
export function signInMethodsLine(providers: string[]): string {
  const extra = providers.length ? `, or with ${providers.join(" or ")} using the same email` : "";
  return `People you add sign in with a password they choose from an invite link${extra}.`;
}

/** The link, shown once. Closing it removes the link from the page for good. */
export function OneTimeLinkWindow({ shown, onClose }: { shown: ShownLink; onClose: () => void }) {
  const headingRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, [shown.url]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(shown.url);
      toast.success("Link copied");
    } catch {
      toast.error("Copy failed. Select the link and copy it by hand.");
    }
  }
  const what = shown.kind === "invite" ? `Invite for ${shown.email}` : `Password reset for ${shown.email}`;
  return (
    <Window title={`${shown.kind === "invite" ? "invite" : "reset"} link · shown once`} small data-one-time-link={shown.kind}>
      <div className="flex flex-col items-start gap-4">
        <p ref={headingRef} tabIndex={-1} className="type-body font-medium text-fg outline-none">
          {what}
        </p>
        <p className="type-body text-fg-2">
          This link is shown once. Send it to them or let them scan the code now. It works once, until {when(shown.expiresAt)}.
        </p>
        <QrCode value={shown.url} label={`QR code for the ${shown.kind} link for ${shown.email}`} size={200} />
        <code className="block w-full break-all bg-bg-sunk p-3 font-mono text-[13px] text-fg" data-one-time-url>
          {shown.url}
        </code>
        <div className="flex flex-wrap gap-3">
          <Button variant="ink" className="h-11!" onClick={copy}>
            Copy link
          </Button>
          <Button variant="secondary" className="h-11!" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Window>
  );
}

/** The invite form. `onCreated` gets the one-time link; `onChanged` reloads the page data. */
export function InviteForm({ providers, disabled, onCreated, onChanged }: { providers: string[]; disabled: boolean; onCreated: (s: ShownLink) => void; onChanged: () => Promise<void> }) {
  const id = useId();
  const emailRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ field?: string; message: string } | null>(null);
  const [role, setRole] = useState<"viewer" | "member">("viewer");
  const [days, setDays] = useState(String(DEFAULT_DAYS));

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const form = e.currentTarget;
    const f = new FormData(form);
    const email = String(f.get("email") ?? "").trim();
    if (!email) {
      setProblem({ field: "email", message: "Enter the email of the person you are inviting." });
      emailRef.current?.focus();
      return;
    }
    setBusy(true);
    setProblem(null);
    const r = await createInviteAction(email, role, Number(days));
    setBusy(false);
    if (!r.ok) {
      setProblem({ field: r.field, message: r.message });
      if (r.field !== "role") emailRef.current?.focus();
      return;
    }
    form.reset();
    setRole("viewer");
    setDays(String(DEFAULT_DAYS));
    onCreated({ url: r.data.url, kind: "invite", email: r.data.link.email, expiresAt: r.data.link.expiresAt });
    await onChanged();
  }

  return (
    <section aria-labelledby={`${id}-h`} className="flex flex-col gap-4" data-invite-form>
      <div>
        <h2 id={`${id}-h`} className="type-title-3 text-fg">
          Invite someone
        </h2>
        <p className="type-body text-fg-muted">
          {signInMethodsLine(providers)} New people are viewers unless you pick Member. You never see their password.
        </p>
      </div>
      <form onSubmit={submit} noValidate className="flex flex-col gap-3">
        <TextField
          ref={emailRef}
          label="Their email"
          name="email"
          type="email"
          placeholder="ana@example.com"
          autoComplete="off"
          disabled={disabled}
          fieldError={problem && problem.field !== "role" && problem.field !== "days" ? problem.message : null}
        />
        <div className="flex flex-wrap items-end gap-3">
          <SelectMenu<"viewer" | "member"> label="Role" labelClassName="type-callout text-fg" size="large" className="w-32" name="invite-role" value={role} options={ROLE_OPTIONS} disabled={disabled} invalid={problem?.field === "role"} onChange={setRole} />
          <SelectMenu label="Link works for" labelClassName="type-callout text-fg" size="large" className="w-36" name="invite-days" value={days} options={DAY_OPTIONS} disabled={disabled} onChange={setDays} />
          <Button type="submit" variant="primary" className="h-11!" disabled={disabled || busy} aria-busy={busy || undefined}>
            {busy ? "Creating" : "Create invite link"}
          </Button>
        </div>
        <FormMessage message={problem && (problem.field === "role" || problem.field === "days") ? problem.message : null} />
      </form>
    </section>
  );
}

const STATUS_TEXT: Record<AccountLinkView["status"], string> = { waiting: "waiting", used: "used", expired: "expired", revoked: "revoked" };

/** Every invite and reset link, waiting ones first, with Revoke on waiting ones. */
export function AccountLinksList({ links, disabled, onChanged }: { links: AccountLinkView[]; disabled: boolean; onChanged: () => Promise<void> }) {
  const id = useId();
  async function revoke(l: AccountLinkView) {
    const r = await revokeLinkAction(l.id);
    if (!r.ok) {
      toast.error(r.message);
      return;
    }
    toast.success(`${l.kind === "invite" ? "Invite" : "Reset link"} for ${l.email} revoked`);
    await onChanged();
  }
  return (
    <section aria-labelledby={`${id}-h`} className="flex flex-col gap-4" data-account-links>
      <h2 id={`${id}-h`} className="type-title-3 text-fg">
        Invite and reset links
      </h2>
      {links.length === 0 ? (
        <p className="type-body text-fg-muted">No invite or reset links yet</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-bg-raised">
          {links.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4" data-account-link={l.status} data-link-email={l.email}>
              <div className="min-w-0 flex-1">
                <p className="truncate type-body text-fg">
                  {l.kind === "invite" ? "Invite" : "Password reset"} · {l.email}
                </p>
                <p className="type-caption text-fg-muted">
                  {l.role ? `${l.role === "member" ? "Member" : "Viewer"} · ` : ""}by {l.createdBy} · created {when(l.createdAt)} · {l.status === "waiting" ? `works until ${when(l.expiresAt)}` : l.status === "used" ? `used ${when(l.usedAt)}` : l.status === "expired" ? `expired ${when(l.expiresAt)}` : `revoked ${when(l.revokedAt)}`}
                </p>
              </div>
              <span className="type-label text-fg-2">{STATUS_TEXT[l.status]}</span>
              {l.status === "waiting" && (
                <Button variant="destructive" className="h-11!" disabled={disabled} onClick={() => revoke(l)} aria-label={`Revoke the ${l.kind} link for ${l.email}`}>
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
