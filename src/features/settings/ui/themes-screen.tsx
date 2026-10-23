"use client";
// The Themes sub-tab (settings spec 3.3): the four built-ins and this Atrium's saved themes, each a
// window with a live sample canvas, name, author, mode and "Used by"; theme drafts proposed by agents;
// Import, Export, Duplicate, Edit and Delete (owners and members; viewers read only).
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import type { Theme } from "@/core/contracts";
import { Button, Glow, SkeletonGrid, Tag, Window, buttonClass, toast } from "@/features/shell";
import { ThemeSample } from "@/features/themes/ui/theme-sample";
import { refreshThemePicker } from "@/features/themes/ui/theme-picker";
import { api, errorText } from "./client-api";
import { UsedBy } from "./used-by";
import { UseOnApp } from "./use-on-app";

// Settings r2 (gauntlet w2-r1 item 7): two or three cards per row, each sample at least 360px wide.
const CARD_GRID = "grid gap-6 [grid-template-columns:repeat(auto-fill,minmax(min(100%,380px),1fr))]";

type Use = { appId: string; slug: string; name: string; draft: boolean; published: boolean };
type Item = { id: string; name: string; author: string; mode: "light" | "dark" | "auto"; builtIn: boolean; rev: number; invalid: number; theme: Theme; usedBy: Use[]; warnings: number; sampleCss?: string };
type Draft = { id: string; targetId: string | null; proposedBy: string; createdAt: string; invalid: number; theme: Theme; warnings: { field: string; ratio: number; scheme: string }[]; sampleCss?: string };
type List = { themes: Item[]; drafts: Draft[]; canEdit: boolean };

const MODE: Record<Item["mode"], string> = { light: "light", dark: "dark", auto: "auto (follows the viewer)" };

export function ThemesScreen() {
  const [data, setData] = useState<List | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ id: string; text: string } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<List>("/api/settings/themes?samples=1"));
      setError(null);
    } catch (x) {
      setError(errorText(x));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function duplicate(id: string) {
    setBusy(id);
    try {
      const t = await api<{ id: string; name: string }>(`/api/settings/themes/${id}/duplicate`, { method: "POST" });
      toast({ kind: "success", title: `Saved ${t.name}` });
      refreshThemePicker();
      window.location.assign(`/settings/themes/${t.id}`);
    } catch (x) {
      toast({ kind: "error", title: errorText(x) });
    } finally {
      setBusy(null);
    }
  }

  async function remove(item: Item) {
    setBusy(item.id);
    setRefusal(null);
    try {
      await api(`/api/settings/themes/${item.id}`, { method: "DELETE" });
      toast({ kind: "success", title: `Deleted ${item.name}` });
      refreshThemePicker();
      await load();
    } catch (x) {
      setRefusal({ id: item.id, text: errorText(x) });
    } finally {
      setBusy(null);
    }
  }

  async function importFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setBusy("import");
    try {
      const fd = new FormData();
      fd.set("file", f);
      const t = await api<{ name: string }>("/api/settings/themes/import", { form: fd });
      toast({ kind: "success", title: `Imported ${t.name}` });
      refreshThemePicker();
      await load();
    } catch (x) {
      toast({ kind: "error", title: "Import refused", description: errorText(x) });
    } finally {
      setBusy(null);
    }
  }

  async function decide(d: Draft, action: "publish" | "discard") {
    setBusy(d.id);
    try {
      const r = await api<{ id?: string; name?: string }>(`/api/settings/theme-drafts/${d.id}`, { body: { action } });
      toast({ kind: "success", title: action === "publish" ? `Published ${r.name ?? d.theme.name}` : `Discarded ${d.theme.name}` });
      if (action === "publish" && r.id) setFlash(r.id);
      refreshThemePicker();
      await load();
    } catch (x) {
      toast({ kind: "error", title: errorText(x) });
    } finally {
      setBusy(null);
    }
  }

  if (error) return <p role="alert" className="type-body text-bad">{error}</p>;
  if (!data) return <SkeletonGrid count={4} />;
  const builtIns = data.themes.filter((t) => t.builtIn);
  const saved = data.themes.filter((t) => !t.builtIn);

  return (
    <div className="flex flex-col gap-10" data-themes-screen>
      {data.canEdit ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" disabled={busy !== null} onClick={() => duplicate("control-room")} data-new-theme>New theme</Button>
          <input ref={fileRef} type="file" accept=".atrium-theme,.json,application/zip,application/json" className="sr-only" onChange={importFile} aria-label="Import a theme file" data-import-input />
          <Button variant="secondary" disabled={busy !== null} onClick={() => fileRef.current?.click()} data-import-theme>{busy === "import" ? "Importing" : "Import theme"}</Button>
        </div>
      ) : (
        <p className="type-body text-fg-2" data-viewer-note>You can see the themes on this Atrium. Owners and members can change them.</p>
      )}

      {data.drafts.length > 0 && (
        <section className="flex flex-col gap-4" aria-labelledby="theme-drafts-h" data-theme-drafts>
          <h2 id="theme-drafts-h" className="type-title-3 text-fg">Proposed by agents</h2>
          <div className={CARD_GRID}>
            {data.drafts.map((d) => (
              <Window key={d.id} title={`themes / draft · ${d.theme.name}`} status={<Tag tone="gold">draft</Tag>} data-theme-draft={d.id}>
                <ThemeSample theme={d.theme} scopedCss={d.sampleCss} scope={`d${d.id.slice(0, 12)}`} />
                <p className="mt-3 type-body text-fg" data-proposed-by>Proposed by {d.proposedBy}</p>
                {d.invalid > 0 && <p className="type-caption text-warning">{d.invalid} values were invalid and were replaced</p>}
                <ContrastList warnings={d.warnings} />
                {data.canEdit && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button variant="ink" disabled={busy !== null} onClick={() => decide(d, "publish")} data-publish-draft>Publish</Button>
                    <Button variant="destructive" disabled={busy !== null} onClick={() => decide(d, "discard")} data-discard-draft>Discard</Button>
                  </div>
                )}
              </Window>
            ))}
          </div>
        </section>
      )}

      <section className="flex flex-col gap-4" aria-labelledby="builtins-h">
        <h2 id="builtins-h" className="type-title-3 text-fg">Built in</h2>
        <div className={CARD_GRID}>
          {builtIns.map((t) => (
            <ThemeWindow key={t.id} t={t} canEdit={data.canEdit} busy={busy} onDuplicate={duplicate} onUsed={() => void load()} />
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-4" aria-labelledby="saved-h">
        <h2 id="saved-h" className="type-title-3 text-fg">Your themes</h2>
        {saved.length === 0 ? (
          <p className="type-body text-fg-2" data-themes-empty>No themes of your own yet. Duplicate a built-in to start.</p>
        ) : (
          <div className={CARD_GRID}>
            {saved.map((t) => (
              <Glow key={t.id} successKey={flash === t.id ? t.id : null}>
                <ThemeWindow t={t} canEdit={data.canEdit} busy={busy} onDuplicate={duplicate} onDelete={remove} refusal={refusal?.id === t.id ? refusal.text : null} onUsed={() => void load()} />
              </Glow>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ContrastList({ warnings }: { warnings: { field: string; ratio: number; scheme: string }[] }) {
  if (!warnings.length) return null;
  return (
    <ul className="mt-2 flex flex-col gap-1" data-contrast-warnings>
      {warnings.map((w) => (
        <li key={`${w.field}${w.scheme}`} className="type-caption text-fg">
          <span aria-hidden className="mr-1 text-warning">▲</span>
          {w.field.replace("color.", "")} {w.ratio.toFixed(2)}:1 ({w.scheme}), below 4.5:1
        </li>
      ))}
    </ul>
  );
}

function ThemeWindow({ t, canEdit, busy, onDuplicate, onDelete, refusal, onUsed }: { t: Item; canEdit: boolean; busy: string | null; onDuplicate(id: string): void; onDelete?(t: Item): void; refusal?: string | null; onUsed?(): void }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <Window title={`themes / ${t.name}`} status={t.builtIn ? <span>built in</span> : t.warnings ? <span>{t.warnings} contrast</span> : null} data-theme-window={t.id}>
      <ThemeSample theme={t.theme} scopedCss={t.sampleCss} scope={`s${t.id.replace(/[^a-z0-9]/g, "")}`} />
      <div className="mt-3 flex min-w-0 flex-col gap-0.5">
        <h3 className="truncate type-callout text-fg" data-theme-name>{t.name}</h3>
        <p className="type-caption text-fg-2">{t.author || "unknown author"} · {MODE[t.mode]}</p>
      </div>
      <UsedBy usedBy={t.usedBy} />
      {t.invalid > 0 && <p className="mt-2 type-caption text-fg" data-invalid-note><span aria-hidden className="mr-1 text-warning">▲</span>{t.invalid} values were invalid and were replaced</p>}
      {/* Settings r3 (gauntlet w2-r2 item 4): "Use on an app" joins the main actions, so the file and
          removal actions sit on their own quiet row; each row keeps one baseline at two cards per row. */}
      {canEdit && (
        <div className="mt-4 flex flex-wrap items-center gap-2" data-theme-actions>
          {!t.builtIn && <Button variant="ink" href={`/settings/themes/${t.id}`} data-edit-theme>Edit</Button>}
          <UseOnApp themeId={t.id} themeName={t.name} onUsed={onUsed} />
          <Button variant="secondary" disabled={busy !== null} onClick={() => onDuplicate(t.id)} data-duplicate-theme>Duplicate</Button>
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-line pt-2" data-theme-file-actions>
        <a className={buttonClass("quiet")} href={`/api/settings/themes/${t.id}/export`} download data-export-theme>Export</a>
        {canEdit && !t.builtIn && onDelete && !confirm && <Button variant="destructive" disabled={busy !== null} onClick={() => setConfirm(true)} data-delete-theme>Delete</Button>}
        {confirm && onDelete && (
          <>
            <Button variant="destructive-confirm" disabled={busy !== null} onClick={() => { setConfirm(false); onDelete(t); }} data-confirm-delete>Delete {t.name}</Button>
            <Button variant="quiet" onClick={() => setConfirm(false)}>Keep it</Button>
          </>
        )}
      </div>
      {refusal && <p role="alert" className="mt-3 type-body text-fg" data-delete-refused><span aria-hidden className="mr-1 text-bad">■</span>{refusal}</p>}
    </Window>
  );
}
