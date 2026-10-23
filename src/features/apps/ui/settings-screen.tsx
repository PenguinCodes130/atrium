"use client";
// App settings at /build/<slug>/settings (spec "App settings", criteria 31 to 35): name, icon, who may
// view and edit, the guest link switch (with auth's guest links panel), export, discard, and delete.
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { UserSet } from "@/core/contracts";
import { Button, Screen, ScreenHeader, Switch, toast, Window } from "@/features/shell";
import { GuestLinkPanel, StepUpProvider, useStepUp } from "@/features/auth/components";
import type { GuestLinkPanelData } from "@/features/auth/components";
import { UploadField } from "@/features/builder/components-client";
import { Checkbox, ChoiceGroup } from "@/features/settings/ui/controls";
import { apiJson, inputClass } from "./fields";

/**
 * One disabled look on this screen (gauntlet w2-r1 item 22): a disabled button always takes the Secondary
 * variant, which Button draws at 40% opacity with no shadow, whatever it becomes when enabled.
 */
const DISABLED = "secondary" as const;

type Person = { id: string; name: string; role: "owner" | "member" | "viewer" };
export type SettingsProps = {
  app: { id: string; slug: string; name: string; icon?: string; publishedVersion: number | null; createdBy: string };
  access: { view: UserSet; edit: UserSet; guests: boolean };
  people: Person[];
  liveLinks: number;
  canDelete: boolean;
  rev: number;
  guestPanel?: GuestLinkPanelData;
};

function SetPicker({ label, value, onChange, people, editList }: { label: string; value: UserSet; onChange(v: UserSet): void; people: Person[]; editList?: boolean }) {
  const mode = value === "owner" ? "owner" : value === "everyone" ? "everyone" : "chosen";
  const ids = typeof value === "object" ? new Set(value.userIds) : new Set<string>();
  return (
    <div className="flex flex-col gap-1" data-access-set={editList ? "edit" : "view"}>
      {/* The shared square controls (gauntlet w2-r2 item 6); each row is 44px tall. */}
      <ChoiceGroup<"owner" | "everyone" | "chosen">
        label={label}
        look="rows"
        name={editList ? "access-edit" : "access-view"}
        value={mode}
        onChange={(m) => onChange(m === "chosen" ? { userIds: [] } : m)}
        options={(["owner", "everyone", "chosen"] as const).map((m) => ({ value: m, label: m === "owner" ? "Only the owner" : m === "everyone" ? (editList ? "Every member" : "Everyone who signs in") : "Chosen people", data: { "access-option": m, "access-mode": m } }))}
      />
      {mode === "chosen" && (
        <ul className="ml-7 flex flex-col">
          {people.filter((p) => p.role !== "owner").map((p) => (
            <li key={p.id}>
              <Checkbox
                checked={ids.has(p.id)}
                onCheckedChange={(on) => { const next = new Set(ids); if (on) next.add(p.id); else next.delete(p.id); onChange({ userIds: [...next] }); }}
                label={<>{p.name} <span className="font-mono text-[11px] text-fg-2">{p.role}</span></>}
                description={editList && p.role === "viewer" ? "Viewers can only view." : undefined}
                data-access-person={p.id}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Inner(p: SettingsProps) {
  const router = useRouter();
  const stepUp = useStepUp();
  const [view, setView] = useState<UserSet>(p.access.view);
  const [edit, setEdit] = useState<UserSet>(p.access.edit);
  const [guests, setGuests] = useState(p.access.guests);
  const [savedGuests, setSavedGuests] = useState(p.access.guests);
  // Remounts the guest links panel after an audience save, so it reads the new state (gauntlet w2-r1 item 16).
  const [panelKey, setPanelKey] = useState(0);
  const [name, setName] = useState(p.app.name);
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = useMemo(() => JSON.stringify([view, edit, guests]) !== JSON.stringify([p.access.view, p.access.edit, savedGuests]), [view, edit, guests, p.access, savedGuests]);

  async function saveAccess() {
    if (savedGuests && !guests && p.liveLinks > 0 && !window.confirm(`Turning guest links off ends ${p.liveLinks} live ${p.liveLinks === 1 ? "link" : "links"} for good. Turning them back on later does not revive them.`)) return;
    setBusy(true);
    setError(null);
    const r = await apiJson<{ revokedLinks: number }>(`/api/apps/${p.app.id}/access`, { method: "PUT", body: JSON.stringify({ view, edit, guests }) });
    setBusy(false);
    if (!r.ok) return setError(r.error.message ?? "Not saved.");
    setSavedGuests(guests);
    setPanelKey((k) => k + 1);
    toast({ kind: "success", title: "Audience saved", ...(r.data.revokedLinks ? { description: `${r.data.revokedLinks} guest ${r.data.revokedLinks === 1 ? "link" : "links"} ended.` } : {}) });
    router.refresh();
  }

  async function rename(next: { name?: string; icon?: string }) {
    const r = await apiJson<{ rev: number }>(`/api/apps/${p.app.id}/ops`, { method: "POST", body: JSON.stringify({ ops: [{ op: "app.update", patch: next }] }) });
    if (!r.ok) return toast({ kind: "error", title: r.error.message ?? "Not saved" });
    toast({ kind: "success", title: "Saved to the draft", description: p.app.publishedVersion ? "Publish to show it on the launcher." : undefined });
    router.refresh();
  }

  async function discard() {
    if (!window.confirm("Discard every unpublished change and go back to the live version?")) return;
    const r = await apiJson(`/api/apps/${p.app.id}/discard`, { method: "POST" });
    if (!r.ok) return toast({ kind: "error", title: r.error.message ?? "Not discarded" });
    toast({ kind: "success", title: "Draft reset to the live version" });
  }

  async function remove() {
    setBusy(true);
    const res = await stepUp(() => fetch(`/api/apps/${p.app.id}/delete`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: confirmName }) }), { reason: `Confirm it is you to delete ${p.app.name}.` });
    setBusy(false);
    if (!res) return;
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!res.ok) return setError(body.error?.message ?? "Not deleted.");
    router.push("/");
  }

  return (
    <Screen>
      <ScreenHeader title="App settings" lead={p.app.name} action={<Button variant="secondary" href={`/build/${p.app.slug}`}>Back to the builder</Button>} />
      <div className="mt-8 flex flex-col gap-8 pb-16">
        <Window title={`apps / ${p.app.slug} / name`}>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <label className="flex flex-1 flex-col gap-1.5 type-label">Name<input className={inputClass} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} data-settings-name /></label>
            <Button variant={!name.trim() || name === p.app.name ? DISABLED : "ink"} disabled={!name.trim() || name === p.app.name} onClick={() => rename({ name: name.trim() })} data-save-name>Save name</Button>
          </div>
          <div className="mt-4 flex flex-col gap-1.5 type-label">Icon<UploadField value={p.app.icon} accept="image" onChange={(path: string) => rename({ icon: path })} /></div>
        </Window>
        <Window title={`apps / ${p.app.slug} / audience`} data-settings-audience>
          <div className="grid gap-6 md:grid-cols-2">
            <SetPicker label="Who can open it" value={view} onChange={setView} people={p.people} />
            <SetPicker label="Who can edit it" value={edit} onChange={setEdit} people={p.people.filter((x) => x.role !== "owner")} editList />
          </div>
          <div className="mt-6 border-t border-line pt-4">
            <Switch checked={guests} onCheckedChange={setGuests} label="Guest links" description="People without an account can open the published version through a link you make." data-guests-switch />
          </div>
          {error && <p role="alert" className="mt-3 type-body text-bad" data-settings-error>{error}</p>}
          <div className="mt-4"><Button variant={!dirty || busy ? DISABLED : "primary"} disabled={!dirty || busy} onClick={saveAccess} data-save-access>Save audience</Button></div>
        </Window>
        {savedGuests && (
          <Window title={`apps / ${p.app.slug} / guest links`} data-settings-guests>
            <GuestLinkPanel key={panelKey} appId={p.app.id} {...(p.guestPanel && panelKey === 0 ? { initial: p.guestPanel } : {})} />
          </Window>
        )}
        <Window title={`apps / ${p.app.slug} / file`}>
          <p className="type-body text-fg-2">Download this app as an Atrium app file. It never holds secrets, people or guest links.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" href={`/api/apps/${p.app.id}/export`} prefetch={false} data-export>Export the published version</Button>
            <Button variant="quiet" href={`/api/apps/${p.app.id}/export?draft=1`} prefetch={false} data-export-draft>Export the draft</Button>
            {p.app.publishedVersion != null && <Button variant="quiet" onClick={discard} data-discard>Discard draft changes</Button>}
          </div>
        </Window>
        {p.canDelete && (
          <Window title={`apps / ${p.app.slug} / delete`} data-settings-delete>
            <p className="type-body">Deleting removes {p.app.name} from every launcher and ends its guest links. Type its name to confirm.</p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <input className={inputClass} value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={p.app.name} aria-label="Type the app's name" data-delete-confirm />
              <Button variant={confirmName.trim() !== p.app.name || busy ? DISABLED : "destructive"} disabled={confirmName.trim() !== p.app.name || busy} onClick={remove} data-delete-app>Delete app</Button>
            </div>
          </Window>
        )}
      </div>
    </Screen>
  );
}

export function SettingsScreen(p: SettingsProps) {
  return (
    <StepUpProvider>
      <Inner {...p} />
    </StepUpProvider>
  );
}
