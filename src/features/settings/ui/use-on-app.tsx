"use client";
// "Use on an app" (settings gauntlet w2-r2 item 4): from a theme card or the theme editor, pick one of
// the apps you can edit; the theme goes onto that app's draft (nothing goes live), and the sheet then
// links to the app's review and publish and to its Look. Two actions from Themes to a themed draft.
import { useState } from "react";
import { Button, Sheet, toast } from "@/features/shell";
import { refreshThemePicker } from "@/features/themes/ui/theme-picker";
import { api, errorText } from "./client-api";
import { ChoiceGroup } from "./controls";

type Choice = { appId: string; slug: string; name: string; currentThemeId: string | null; currentThemeName: string | null; published: boolean };
type Done = { appId: string; slug: string; name: string; reviewHref: string; lookHref: string };

export function UseOnApp({ themeId, themeName, className, onUsed, variant = "secondary", note }: { themeId: string; themeName: string; className?: string; onUsed?(d: Done): void; variant?: "secondary" | "quiet"; note?: string }) {
  const [open, setOpen] = useState(false);
  const [apps, setApps] = useState<Choice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);

  async function start() {
    setOpen(true);
    setDone(null);
    setError(null);
    setApps(null);
    try {
      const r = await api<{ apps: Choice[] }>("/api/settings/theme-apps");
      setApps(r.apps);
      setPick(r.apps.find((a) => a.currentThemeId !== themeId)?.appId ?? r.apps[0]?.appId ?? "");
    } catch (x) {
      setError(errorText(x));
    }
  }

  async function use() {
    if (!pick) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<Done>(`/api/settings/themes/${encodeURIComponent(themeId)}/use`, { body: { appId: pick } });
      setDone(r);
      refreshThemePicker();
      toast({ kind: "success", title: `${themeName} is on ${r.name}'s draft` });
      onUsed?.(r);
    } catch (x) {
      setError(errorText(x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={className}>
      <Button variant={variant} onClick={start} data-use-on-app={themeId}>Use on an app</Button>
      <Sheet open={open} onOpenChange={setOpen} title={`Use ${themeName} on an app`} path="themes / use on an app" name="use-on-app" width={440}>
        <div className="flex flex-col gap-5" data-use-on-app-sheet>
          {!apps && !error && <p className="type-body text-fg-2">Loading your apps</p>}
          {apps && apps.length === 0 && <p className="type-body text-fg" data-no-apps>There are no apps you can edit yet. Make one from Apps first.</p>}
          {apps && apps.length > 0 && !done && (
            <>
              <ChoiceGroup<string>
                label="Which app"
                look="rows"
                name="use-on-app"
                value={pick}
                onChange={setPick}
                options={apps.map((a) => ({
                  value: a.appId,
                  data: { app: a.slug },
                  label: a.name,
                  description: a.currentThemeId === themeId ? "Uses this theme already" : `Now ${a.currentThemeName ?? "the default theme"}${a.published ? " · published" : " · not published yet"}`,
                }))}
              />
              <p className="type-caption text-fg-2">This changes the app&apos;s draft only. The live app keeps its look until you publish.{note ? ` ${note}` : ""}</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" disabled={busy || !pick} onClick={use} data-confirm-use-on-app>{busy ? "Applying" : "Use on this app"}</Button>
                <Button variant="quiet" onClick={() => setOpen(false)}>Cancel</Button>
              </div>
            </>
          )}
          {done && (
            <div className="flex flex-col gap-4" data-use-on-app-done={done.slug}>
              <p className="type-body text-fg"><span aria-hidden className="mr-1 text-ok">■</span>{themeName} is on {done.name}&apos;s draft. Publish the app to make it live.</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" href={done.reviewHref} data-review-publish>Review and publish</Button>
                <Button variant="secondary" href={done.lookHref} data-open-look>Open its look</Button>
              </div>
            </div>
          )}
          {error && <p role="alert" className="type-body text-bad" data-use-on-app-error>{error}</p>}
        </div>
      </Sheet>
    </div>
  );
}
