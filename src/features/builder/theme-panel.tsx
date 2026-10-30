"use client";
// Theme in the builder bar (Wave 2.10b F9; spec 4 F9, criterion 16). A panel docked on the right, so the
// canvas stays in view and undimmed: every theme as a swatch row; pointing at one (hover or focus)
// previews it on this app's real page with nothing written; Use puts it on the app (one undoable edit);
// Edit opens settings' full theme editor on a saved theme; New theme copies the current one and opens
// the editor on it. Settings > Themes stays where it is. The editor is settings' own export, embedded
// as is (not forked): it keeps its own draft and Save (A11.1), and the canvas follows each save.
import { useCallback, useEffect, useRef, useState } from "react";
import type { DraftOp, Theme, ThemeRef } from "@/core/contracts";
import { Button, toast } from "@/features/shell";
import { ThemeEditor, type EditorProps } from "@/features/settings/ui/theme-editor";
import { refreshThemePicker, type ThemeOption } from "@/features/themes/client";

type Saved = { id: string; name: string; rev: number; builtIn: boolean; invalid: number; theme: Theme; usedBy: EditorProps["usedBy"] };

async function getJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  const r = await fetch(url, { credentials: "same-origin", ...(init ?? {}), headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}) } }).catch(() => null);
  if (!r?.ok) return null;
  return (await r.json().catch(() => null)) as T | null;
}

export type ThemePanelProps = {
  current: ThemeRef;
  /** Puts a theme on the app (the builder's undoable apply). */
  apply(ops: DraftOp[]): void;
  /** Shows a theme on the canvas without writing it (null: back to the app's own). */
  preview(theme: Theme | null, id: string | null): void;
  /** A theme this app uses was saved in the editor: draw the canvas again. */
  saved(id: string): void;
  onClose(): void;
};

export function ThemePanel({ current, apply, preview, saved, onClose }: ThemePanelProps) {
  const [options, setOptions] = useState<ThemeOption[] | null>(null);
  const [editing, setEditing] = useState<Saved | null>(null);
  const [busy, setBusy] = useState(false);
  const full = useRef(new Map<string, Theme>());
  const currentId = "themeId" in current ? current.themeId : null;

  const load = useCallback(async () => {
    const j = await getJson<{ options: ThemeOption[] }>("/api/settings/themes?picker=1");
    setOptions(j?.options ?? []);
  }, []);
  useEffect(() => { void load(); }, [load]);
  // Esc closes the panel (the editor's own fields keep their Esc).
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !(e.target as HTMLElement | null)?.closest("input, textarea, select, [role=listbox], [role=menu]")) onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  useEffect(() => () => preview(null, null), [preview]);

  const themeOf = async (id: string): Promise<Theme | null> => {
    const hit = full.current.get(id);
    if (hit) return hit;
    const j = await getJson<Saved>(`/api/settings/themes/${encodeURIComponent(id)}`);
    if (!j) return null;
    full.current.set(id, j.theme);
    return j.theme;
  };
  const pointAt = async (id: string) => {
    const t = await themeOf(id);
    if (t) preview(t, id);
  };
  const use = (o: { id: string; name: string }) => {
    preview(null, null);
    if (currentId !== o.id) apply([{ op: "theme.set", theme: { themeId: o.id } }]);
    toast({ kind: "success", title: `${o.name} is this app's theme`, description: "In the draft. Publish to show it to viewers." });
  };
  const openEditor = async (id: string) => {
    const j = await getJson<Saved>(`/api/settings/themes/${encodeURIComponent(id)}`);
    if (!j) { toast({ kind: "error", title: "That theme could not be opened" }); return; }
    preview(null, null);
    setEditing({ ...j, id });
  };
  // New theme: a saved copy of this app's theme (or Control Room), put on the app and opened in the editor.
  const create = async () => {
    setBusy(true);
    const base = currentId ?? "control-room";
    const j = await getJson<{ id: string; name: string }>(`/api/settings/themes/${encodeURIComponent(base)}/duplicate`, { method: "POST" });
    setBusy(false);
    if (!j?.id) { toast({ kind: "error", title: "The theme could not be made", description: "Owners and members can make themes." }); return; }
    refreshThemePicker();
    apply([{ op: "theme.set", theme: { themeId: j.id } }]);
    await load();
    await openEditor(j.id);
  };

  // While the editor is open, follow its saves: the saved rev changes, the canvas is drawn again.
  const rev = useRef<number | null>(null);
  useEffect(() => {
    if (!editing) return;
    rev.current = editing.rev;
    let live = true;
    const t = window.setInterval(async () => {
      const j = await getJson<Saved>(`/api/settings/themes/${encodeURIComponent(editing.id)}`);
      if (!live || !j) return;
      if (rev.current !== null && j.rev !== rev.current) {
        rev.current = j.rev;
        full.current.set(editing.id, j.theme);
        saved(editing.id);
        void load();
      }
    }, 700);
    return () => { live = false; window.clearInterval(t); };
  }, [editing, saved, load]);

  return (
    <aside
      role="dialog"
      aria-label="Theme"
      className={`fixed top-12 right-0 bottom-0 z-30 flex w-full max-w-[100vw] flex-col border-l border-line-strong bg-bg shadow-[var(--shadow-2,0_8px_24px_rgb(0_0_0/0.18))] ${editing ? "min-[900px]:w-[min(780px,calc(100vw-380px))]" : "min-[900px]:w-[min(460px,calc(100vw-380px))]"}`}
      data-theme-sheet
    >
      <header className="flex h-12 flex-none items-center gap-2 border-b border-line px-3">
        {editing && <button type="button" className="inline-flex min-h-9 items-center px-1 type-label underline underline-offset-2 touch:min-h-11" onClick={() => { setEditing(null); void load(); }} data-theme-back>All themes</button>}
        <h2 className="m-0 min-w-0 flex-1 truncate type-title-3">{editing ? `Edit ${editing.name}` : "Theme"}</h2>
        <Button variant="quiet" onClick={onClose} data-theme-close>Close</Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
        {editing ? (
          <div className="flex flex-col gap-3" data-theme-editing={editing.id}>
            <p className="m-0 type-caption text-fg-2">Every app that uses {editing.name} changes when you save. Save, and this page shows it at once. Settings &gt; Themes has the same editor.</p>
            <ThemeEditor key={editing.id} id={editing.id} rev={editing.rev} theme={editing.theme} invalid={editing.invalid} usedBy={editing.usedBy} />
          </div>
        ) : (
          <div className="flex flex-col gap-4" data-theme-list>
            <p className="m-0 type-caption text-fg-2">Point at a theme to see it on this page; nothing changes until you press Use. Edit and New theme open the full theme editor here.</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => void create()} disabled={busy} data-theme-new>{busy ? "Making" : "New theme from this one"}</Button>
              <Button variant="quiet" href="/settings/themes" data-theme-settings>Settings &gt; Themes</Button>
            </div>
            {options === null ? <p className="m-0 type-caption text-fg-2">Loading themes…</p> : (
              <ul className="m-0 flex list-none flex-col p-0" onMouseLeave={() => preview(null, null)} data-theme-options>
                {options.map((o) => {
                  const on = o.id === currentId;
                  return (
                    <li key={o.id} className="flex min-h-14 items-center gap-3 border-b border-line py-2 last:border-b-0" onMouseEnter={() => void pointAt(o.id)} onFocus={() => void pointAt(o.id)} data-theme-option={o.id}>
                      <span aria-hidden className="relative inline-block size-10 flex-none border border-line-strong" style={{ background: o.swatch.wallpaper }}>
                        <span className="absolute inset-x-1.5 top-1.5 bottom-3.5 border border-[color:var(--line-strong)]" style={{ background: o.swatch.surface }} />
                        <span className="absolute right-1.5 bottom-1.5 left-1.5 h-1" style={{ background: o.swatch.accent }} />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="type-body truncate">{o.name}</span>
                        <span className="type-caption text-fg-2">{o.builtIn ? "Built in" : "Yours"} · {o.mode === "auto" ? "Light and dark" : o.mode === "dark" ? "Dark" : "Light"}{on ? " · this app uses it" : ""}</span>
                      </span>
                      {!o.builtIn && <Button variant="quiet" onClick={() => void openEditor(o.id)} data-theme-edit={o.id}>Edit</Button>}
                      <Button variant={on ? "quiet" : "secondary"} disabled={on} onClick={() => use(o)} data-theme-use={o.id}>{on ? "In use" : "Use"}</Button>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="m-0 type-caption text-fg-2">Built-in themes cannot be edited: New theme from this one makes your own copy.</p>
          </div>
        )}
      </div>
    </aside>
  );
}
