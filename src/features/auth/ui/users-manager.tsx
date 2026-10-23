"use client";
// Users and allowlist management (architecture section 5, Amendment 3). Settings mounts this at
// /settings/users. Only the owner can change anything; the server refuses everyone else with 403.
// Round 5: invite and reset links, a role control per allowlist entry (Add never rewrites one), named
// Remove buttons with Undo, and the owner's own entry with no controls at all.
// Settings r3 shared file request (gauntlet w2-r2, "For other subsystems"): the invite form comes first,
// above the user list (it started 844px down), and every role choice is the shell's square menu
// (settings' SelectMenu) instead of a native select.
import { useRef, useState, useTransition, type FormEvent } from "react";
import type { Role } from "@/core/contracts";
import { Button, toast } from "@/features/shell";
import {
  addPatternAction,
  changeRoleAction,
  createInviteAction,
  createResetAction,
  loadUsersAction,
  removePatternAction,
  removeUserAction,
  setPatternRoleAction,
  transferOwnershipAction,
  type ActionResult,
} from "../actions";
import type { UsersPageData } from "../server/manage";
import { AccountLinksList, InviteForm, OneTimeLinkWindow, signInMethodsLine, type ShownLink } from "./account-links-panel";
import { SelectMenu } from "@/features/settings/ui/controls";
import { FormMessage, TextField } from "./fields";
import { StepUpSheet } from "./step-up";

const ROLE_LABEL: Record<Role, string> = { owner: "Owner", member: "Member", viewer: "Viewer" };
const ROLE_OPTIONS = [
  { value: "member", label: "Member" },
  { value: "viewer", label: "Viewer" },
] as const;
const NEW_ROLE_OPTIONS = [
  { value: "viewer", label: "Viewer" },
  { value: "member", label: "Member" },
] as const;

export function UsersManager({ initial }: { initial: UsersPageData }) {
  const [data, setData] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [stepUpFor, setStepUpFor] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [shown, setShown] = useState<ShownLink | null>(null);
  const [patternError, setPatternError] = useState<string | null>(null);
  const [newRole, setNewRole] = useState<"viewer" | "member">("viewer");
  const patternRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    const r = await loadUsersAction();
    if (r.ok) setData(r.data);
  };

  const act = <T,>(fn: () => Promise<ActionResult<T>>, done?: string) =>
    start(async () => {
      setError(null);
      setNotice(null);
      const r = await fn();
      if (!r.ok) {
        setError(r.message);
        return;
      }
      await refresh();
      if (done) setNotice(done);
    });

  const transfer = (userId: string) =>
    start(async () => {
      setError(null);
      const r = await transferOwnershipAction(userId);
      if (!r.ok && r.code === "step_up_required") {
        setStepUpFor(userId);
        return;
      }
      if (!r.ok) {
        setError(r.message);
        return;
      }
      // The previous owner is now a member and their sessions ended: sign in again.
      window.location.assign("/sign-in");
    });

  function addPattern(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const pattern = String(f.get("pattern") ?? "").trim();
    setPatternError(null);
    if (!pattern) {
      // Usability r3 (low): an empty Add says what to type and moves focus there; nothing is sent.
      setPatternError("Enter an email or *@domain.");
      setError(null);
      setNotice(null);
      patternRef.current?.focus();
      return;
    }
    start(async () => {
      setError(null);
      setNotice(null);
      const r = await addPatternAction(pattern, newRole);
      if (!r.ok) {
        setPatternError(r.message);
        patternRef.current?.focus();
        return;
      }
      form.reset();
      setNewRole("viewer");
      await refresh();
      setNotice(`${r.data.pattern} was added as a ${r.data.role}.`);
    });
  }

  /** Remove now, with Undo in the message (usability r3, low). Undo puts the entry back with its role. */
  const removePattern = (entryId: string, pattern: string) =>
    start(async () => {
      setError(null);
      setNotice(null);
      const r = await removePatternAction(entryId);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      await refresh();
      const removed = r.data;
      setNotice(`${pattern} was removed.`);
      if (removed) {
        toast.info(`${pattern} was removed from the allowlist`, {
          action: {
            label: "Undo",
            onClick: () =>
              start(async () => {
                const back = await addPatternAction(removed.pattern, removed.role);
                if (!back.ok) {
                  setError(back.message);
                  return;
                }
                await refresh();
                setNotice(`${removed.pattern} is back on the allowlist as a ${removed.role}.`);
              }),
          },
        });
      }
    });

  const issueReset = (userId: string) =>
    start(async () => {
      setError(null);
      setNotice(null);
      const r = await createResetAction(userId);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      setShown({ url: r.data.url, kind: "reset", email: r.data.link.email, expiresAt: r.data.link.expiresAt });
      await refresh();
    });

  const inviteEntry = (pattern: string, role: Role) =>
    start(async () => {
      setError(null);
      setNotice(null);
      const r = await createInviteAction(pattern, role);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      setShown({ url: r.data.url, kind: "invite", email: r.data.link.email, expiresAt: r.data.link.expiresAt });
      await refresh();
    });

  const userEmails = new Set(data.users.map((u) => u.email.toLowerCase()));

  const isOwner = data.me.role === "owner";

  return (
    <div className="flex flex-col gap-10" data-users-manager>
      <InviteForm providers={data.providers} disabled={!isOwner} onCreated={setShown} onChanged={refresh} />

      {shown && <OneTimeLinkWindow shown={shown} onClose={() => setShown(null)} />}

      <section aria-labelledby="users-heading" className="flex flex-col gap-4">
        <div>
          <h2 id="users-heading" className="type-title-3 text-fg">
            Users
          </h2>
          <p className="type-body text-fg-muted">Members can edit pages and approve actions. Viewers can only read. There is always exactly one owner.</p>
        </div>
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-bg-raised">
          {data.users.map((u) => (
            <li key={u.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center" data-user={u.email}>
              <div className="min-w-0 flex-1">
                <p className="truncate type-body text-fg">{u.email}</p>
                <p className="type-caption text-fg-muted">
                  {ROLE_LABEL[u.role]}
                  {u.id === data.me.id ? " (you)" : ""}
                  {u.twoFactorEnabled ? " · authenticator app on" : ""}
                </p>
              </div>
              {u.role === "owner" ? (
                <span className="type-callout text-fg-muted">Owner</span>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <SelectMenu
                    label={`Role for ${u.email}`}
                    hideLabel
                    size="large"
                    className="w-32"
                    name={`role-${u.email}`}
                    value={u.role as "member" | "viewer"}
                    options={ROLE_OPTIONS}
                    disabled={!isOwner || pending}
                    onChange={(v) => act(() => changeRoleAction(u.id, v), `${u.email} is now a ${v}.`)}
                  />
                  <Button variant="secondary" className="h-11!" disabled={!isOwner || pending} onClick={() => issueReset(u.id)} aria-label={`Reset password for ${u.email}`} data-reset-user={u.email}>
                    Reset password
                  </Button>
                  <Button variant="secondary" className="h-11!" disabled={!isOwner || pending} onClick={() => transfer(u.id)}>
                    Make owner
                  </Button>
                  {confirmRemove === u.id ? (
                    <>
                      <Button variant="destructive-confirm" className="h-11!" disabled={pending} onClick={() => act(() => removeUserAction(u.id), `${u.email} was removed.`)}>
                        Remove {u.email}
                      </Button>
                      <Button variant="quiet" className="h-11!" onClick={() => setConfirmRemove(null)}>
                        Keep
                      </Button>
                    </>
                  ) : (
                    <Button variant="destructive" className="h-11!" disabled={!isOwner || pending} onClick={() => setConfirmRemove(u.id)}>
                      Remove
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <AccountLinksList links={data.links} disabled={!isOwner || pending} onChanged={refresh} />

      <section aria-labelledby="allow-heading" className="flex flex-col gap-4">
        <div>
          <h2 id="allow-heading" className="type-title-3 text-fg">
            Allowlist
          </h2>
          <p className="type-body text-fg-muted">
            Only these emails can sign in, by any method. Use an exact email or *@domain. New entries are viewers unless you pick Member. The role applies at a
            person&apos;s first sign-in; change it on the user later.
          </p>
          <p className="mt-2 type-body text-fg-muted" data-sign-in-methods>
            {signInMethodsLine(data.providers)}
          </p>
        </div>
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-bg-raised">
          {data.allowlist.map((a) => {
            const exact = !a.pattern.startsWith("*@");
            const hasUser = userEmails.has(a.pattern);
            return (
              <li key={a.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center" data-pattern={a.pattern}>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono type-body text-fg">{a.pattern}</p>
                  <p className="type-caption text-fg-muted">
                    {a.role === "owner" ? "Owner. Always allowed; this entry cannot be changed." : `${ROLE_LABEL[a.role]} at first sign-in${exact && hasUser ? " · has an account" : ""}`}
                  </p>
                </div>
                {a.role === "owner" ? (
                  <span className="type-callout text-fg-muted">Owner</span>
                ) : (
                  <div className="flex flex-wrap items-center gap-2" data-entry-role>
                    <SelectMenu
                      label={`Role for ${a.pattern}`}
                      hideLabel
                      size="large"
                      className="w-32"
                      name={`entry-role-${a.pattern}`}
                      value={a.role as "member" | "viewer"}
                      options={ROLE_OPTIONS}
                      disabled={!isOwner || pending}
                      onChange={(v) => act(() => setPatternRoleAction(a.id, v), `${a.pattern} is now a ${v} at first sign-in.`)}
                    />
                    {exact && !hasUser && (
                      <Button variant="secondary" className="h-11!" disabled={!isOwner || pending} onClick={() => inviteEntry(a.pattern, a.role)} aria-label={`Invite ${a.pattern}`}>
                        Invite
                      </Button>
                    )}
                    <Button variant="destructive" className="h-11!" disabled={!isOwner || pending} onClick={() => removePattern(a.id, a.pattern)} aria-label={`Remove ${a.pattern}`}>
                      Remove
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <form onSubmit={addPattern} noValidate className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="flex-1">
            <TextField
              ref={patternRef}
              label="Email or *@domain"
              name="pattern"
              placeholder="*@example.com"
              autoComplete="off"
              disabled={!isOwner}
              fieldError={patternError}
              onChange={() => patternError && setPatternError(null)}
            />
          </div>
          <SelectMenu<"viewer" | "member"> label="Role" labelClassName="type-callout text-fg" size="large" className="sm:w-32" name="new-pattern-role" value={newRole} options={NEW_ROLE_OPTIONS} disabled={!isOwner} onChange={setNewRole} />
          <div className="flex flex-col gap-1.5">
            <span aria-hidden className="invisible type-callout max-sm:hidden">
              Add
            </span>
            <Button type="submit" variant="secondary" className="h-11!" disabled={!isOwner || pending}>
              Add
            </Button>
          </div>
        </form>
        <FormMessage message={error} />
        <FormMessage message={notice} tone="info" />
      </section>

      <StepUpSheet
        open={stepUpFor !== null}
        onCancel={() => setStepUpFor(null)}
        reason={stepUpFor ? `Confirm it is you to make ${data.users.find((u) => u.id === stepUpFor)?.email ?? "this person"} the owner of this Atrium.` : null}
        onDone={() => {
          const target = stepUpFor;
          setStepUpFor(null);
          if (target) transfer(target);
        }}
      />
    </div>
  );
}
