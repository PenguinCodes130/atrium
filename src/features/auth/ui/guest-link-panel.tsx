"use client";
// GuestLinkPanel (architecture v3 section 2 export; app-builder mounts it on /build/<slug>/settings in
// Wave 2). Create a link with a label, an expiry and an optional PIN; the link is shown once, as text, a
// QR code and a copy button; list every link with its status; revoke active ones.
// Design v4: Windows, Buttons (Ink for Copy link, Destructive for Revoke), Toasts.
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { Button, toast } from "@/features/shell";
import { Window } from "@/features/shell/window";
import { TextField, CONTROL_TYPE } from "./fields";
import { QrCode } from "./qr-code";

export type PanelLink = {
  id: string;
  label: string;
  createdBy: { id: string; name: string };
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedCause: string | null;
  status: "active" | "expired" | "revoked" | "locked";
  requiresCode: boolean;
  canRevoke: boolean;
};
export type PanelData = { guestsOn: boolean; canCreate: boolean; links: PanelLink[] };

const CAUSE_TEXT: Record<string, string> = {
  manual: "revoked",
  guests_off: "revoked: guest links turned off",
  app_deleted: "revoked: app deleted",
  creator_demoted: "revoked: creator made a viewer",
  creator_removed: "revoked: creator removed",
  creator_lost_edit: "revoked: creator can no longer edit",
};

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");
const dateInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never");

/** The chosen day at the current time of day, so "90 days from today" is exactly 90 days. */
function expiryFrom(day: string): string | undefined {
  if (!day) return undefined;
  const now = new Date();
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y!, m! - 1, d!, now.getHours(), now.getMinutes(), now.getSeconds()).toISOString();
}

type ApiError = { error?: { code?: string; message?: string; field?: string } };

export function GuestLinkPanel({ appId, initial }: { appId: string; initial?: PanelData }) {
  const [data, setData] = useState<PanelData | null>(initial ?? null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [day, setDay] = useState(() => dateInput(new Date(Date.now() + 7 * DAY)));
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ field?: string; message: string } | null>(null);
  const [shown, setShown] = useState<{ url: string; label: string } | null>(null);
  const problemId = useId();

  const load = useCallback(async () => {
    const res = await fetch(`/api/auth/atrium/guest-links?appId=${encodeURIComponent(appId)}`, { cache: "no-store" });
    const body = (await res.json().catch(() => ({}))) as PanelData & ApiError;
    if (!res.ok) {
      setRefusal(body.error?.message ?? "Guest links could not be loaded.");
      return;
    }
    setRefusal(null);
    setData(body);
  }, [appId]);

  useEffect(() => {
    if (!initial) void load();
  }, [initial, load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch("/api/auth/atrium/guest-links", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId, label, expiresAt: expiryFrom(day), pin: pin || undefined }),
      });
      const body = (await res.json().catch(() => ({}))) as { url?: string; link?: PanelLink } & ApiError;
      if (!res.ok || !body.url) {
        setProblem({ field: body.error?.field, message: body.error?.message ?? "The link could not be created. Try again." });
        return;
      }
      setShown({ url: body.url, label: body.link?.label ?? label });
      setLabel("");
      setPin("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    const res = await fetch(`/api/auth/atrium/guest-links/${encodeURIComponent(id)}/revoke`, { method: "POST" });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as ApiError;
      toast.error(body.error?.message ?? "The link could not be revoked.");
      return;
    }
    toast.success("Link revoked");
    await load();
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch {
      toast.error("Copy failed. Select the link and copy it by hand.");
    }
  }

  return (
    <Window title="app / settings · guest links" data-guest-link-panel>
      <div className="flex flex-col gap-6">
        <p className="type-body text-fg-2">Let someone without an account open this app, and nothing else, until the link expires or you revoke it.</p>
        {refusal && (
          <p role="status" className="type-body text-fg">
            {refusal}
          </p>
        )}
        {data && !data.guestsOn && (
          <p role="status" className="type-body text-fg" data-guests-off>
            Guest links are off for this app
          </p>
        )}

        {shown && (
          <Window title="guest link · shown once" small data-one-time-link>
            <div className="flex flex-col items-start gap-4">
              <p className="type-body text-fg">This link is shown once. Copy it or scan the code now.</p>
              <QrCode value={shown.url} label={`QR code for the guest link ${shown.label}`} size={200} />
              <code className="block w-full break-all bg-bg-sunk p-3 font-mono text-[13px] text-fg" data-one-time-url>
                {shown.url}
              </code>
              <div className="flex flex-wrap gap-3">
                <Button variant="ink" onClick={() => copy(shown.url)}>
                  Copy link
                </Button>
                <Button variant="secondary" onClick={() => setShown(null)}>
                  Close
                </Button>
              </div>
            </div>
          </Window>
        )}

        {data?.guestsOn && data.canCreate && (
          <form onSubmit={create} noValidate className="flex flex-col gap-4" aria-describedby={problem ? problemId : undefined}>
            <TextField label="Label" placeholder="Guest room, Sam" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} required error={problem?.field === "label" ? problem.message : undefined} />
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${problemId}-expiry`} className="type-callout text-fg">
                Expires
              </label>
              <input
                id={`${problemId}-expiry`}
                type="date"
                value={day}
                min={dateInput(new Date(Date.now() + DAY))}
                max={dateInput(new Date(Date.now() + 90 * DAY))}
                onChange={(e) => setDay(e.target.value)}
                aria-invalid={problem?.field === "expiresAt" ? true : undefined}
                className={`h-11 w-full border border-line-strong bg-bg-hi px-3 ${CONTROL_TYPE} text-fg`}
              />
              <p className="type-caption text-fg-3">At most 90 days from today.</p>
            </div>
            <TextField
              label="PIN (optional)"
              hint="4 to 8 digits. The guest types it once on each new device."
              inputMode="numeric"
              autoComplete="off"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, "").slice(0, 8))}
              error={problem?.field === "pin" ? problem.message : undefined}
            />
            {problem && (
              <p id={problemId} role="alert" className="type-body text-bad">
                {problem.message}
              </p>
            )}
            <div>
              <Button type="submit" variant="primary" disabled={busy} aria-busy={busy || undefined}>
                {busy ? "Creating" : "Create guest link"}
              </Button>
            </div>
          </form>
        )}

        {data && data.links.length === 0 && data.guestsOn && <p className="type-body text-fg-2">No guest links yet</p>}
        {data && data.links.length > 0 && (
          <ul className="flex flex-col divide-y divide-line border-y border-line" data-guest-link-list>
            {data.links.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-x-6 gap-y-1 py-3" data-guest-link={l.status}>
                <div className="min-w-0 flex-1">
                  <p className="type-body font-medium text-fg">{l.label}</p>
                  <p className="type-caption text-fg-3">
                    by {l.createdBy.name} · created {when(l.createdAt)} · expires {when(l.expiresAt)} · last used {when(l.lastUsedAt)}
                    {l.requiresCode ? " · PIN" : ""}
                  </p>
                </div>
                <span className="type-label text-fg-2">{l.status === "revoked" ? (CAUSE_TEXT[l.revokedCause ?? "manual"] ?? "revoked") : l.status}</span>
                {l.canRevoke && (l.status === "active" || l.status === "locked") && (
                  <Button variant="destructive" onClick={() => revoke(l.id)} aria-label={`Revoke ${l.label}`}>
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Window>
  );
}
