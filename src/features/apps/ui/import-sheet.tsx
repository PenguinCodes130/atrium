"use client";
// Import an Atrium app file (spec "Atrium app file", criterion 45): check the file, map each named
// integration or skip it, then create a new app with a draft only.
import { useState } from "react";
import { Button, Sheet, toast } from "@/features/shell";
import { CONTAINS_CODE_NOTICE as CONTAINS_CODE } from "@/features/library";
import { FileField, SelectMenu } from "@/features/settings/ui/controls";
import { Field } from "./fields";

type LibraryLine = { id: string; name: string; version: number; containsCode: boolean; outcome?: "reused" | "imported" | "restored" };
type Done = { imported: number; reused: number; restored: number; names: { name: string; outcome: "reused" | "imported" | "restored" }[] };

/** What import does with a library component, in the sheet and the toast after (gauntlet w2-r2 item 14). */
export const OUTCOME_TEXT: Record<"reused" | "imported" | "restored", string> = {
  reused: "already in your library",
  imported: "will be added to your library",
  restored: "was deleted here: it comes back as a new library component",
};

type Mapping = { key: string; packageId: string; name: string; options: { id: string; name: string }[] };

export function ImportSheet({ open, onClose, onImported }: { open: boolean; onClose(): void; onImported(slug: string): void }) {
  const [file, setFile] = useState<File | null>(null);
  const [step, setStep] = useState<null | { name: string; integrations: Mapping[]; libraryComponents: LibraryLine[] }>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(withMappings: boolean) {
    if (!file) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set("file", file);
    if (withMappings && step) {
      const m: Record<string, string | null> = {};
      for (const i of step.integrations) m[i.key] = choice[i.key] && choice[i.key] !== "skip" ? choice[i.key]! : i.options[0]?.id && choice[i.key] !== "skip" ? i.options[0].id : null;
      form.set("mappings", JSON.stringify(m));
    }
    const res = await fetch("/api/apps/import", { method: "POST", body: form, credentials: "same-origin" }).catch(() => null);
    const body = (await res?.json().catch(() => ({}))) as { step?: string; name?: string; integrations?: Mapping[]; libraryComponents?: LibraryLine[]; app?: { slug: string }; library?: Done; error?: { message?: string } };
    setBusy(false);
    if (!res || !res.ok) return setError(body?.error?.message ?? "The file could not be imported.");
    if (body.step === "map") setStep({ name: body.name ?? "", integrations: body.integrations ?? [], libraryComponents: body.libraryComponents ?? [] });
    else if (body.app) {
      const restored = body.library?.names.filter((n) => n.outcome === "restored").map((n) => n.name) ?? [];
      if (restored.length) toast({ kind: "info", title: `Brought back ${restored.join(", ")}`, description: "It was deleted from this library, so the app file added it again as a new library component." });
      onImported(body.app.slug);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()} title="Import an app" path="apps / import" name="import-app" width={480}
      footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button>{step ? <Button variant="primary" disabled={busy} onClick={() => send(true)} data-import-confirm>Import as a draft</Button> : <Button variant="primary" disabled={busy || !file} onClick={() => send(false)} data-import-check>Check the file</Button>}</div>}>
      <div className="flex flex-col gap-5" data-import-form>
        <FileField label="Atrium app file" accept=".zip,application/zip" file={file} onFile={(f: File | null) => { setFile(f); setStep(null); setError(null); }} buttonLabel="Choose app file" data-import-file />
        <p className="-mt-3 type-caption text-fg-2">A .atrium-app.zip exported from Atrium.</p>
        {step && (
          <div className="flex flex-col gap-3" data-import-mapping>
            <p className="type-body text-fg">{step.name}: choose which of your integrations each part uses, or skip it.</p>
            {step.integrations.length === 0 && <p className="type-body text-fg-2">This app uses no integrations.</p>}
            {step.libraryComponents.length > 0 && (
              <div className="flex flex-col gap-1 border border-line bg-bg-sunk p-2" data-import-library>
                <p className="type-label">Library components it brings</p>
                <ul className="flex flex-col gap-0.5">
                  {step.libraryComponents.map((c) => <li key={`${c.id}@${c.version}`} className="type-body" data-import-library-item={c.outcome ?? "imported"}>{c.name} <span className="font-mono text-[11px] text-fg-2">v{c.version}</span>{c.containsCode && <span className="ml-1 font-mono text-[11px] text-fg-2">contains code</span>}{c.outcome && <span className={`block type-caption ${c.outcome === "restored" ? "text-warn" : "text-fg-2"}`}>{OUTCOME_TEXT[c.outcome]}</span>}</li>)}
                </ul>
                {step.libraryComponents.some((c) => c.containsCode) && <p className="border-l-4 border-l-warn pl-2 type-caption" data-import-code-notice>{CONTAINS_CODE}</p>}
              </div>
            )}
            {step.integrations.map((i) => (
              <Field key={i.key} label={`${i.name} (${i.packageId})`}>
                {() => (
                  <div data-import-map={i.key}>
                    <SelectMenu label={`${i.name} (${i.packageId})`} hideLabel name={`import-map-${i.key}`} value={choice[i.key] ?? i.options[0]?.id ?? "skip"} onChange={(v: string) => setChoice((c) => ({ ...c, [i.key]: v }))} options={[...i.options.map((o) => ({ value: o.id, label: o.name })), { value: "skip", label: "Skip" }]} />
                  </div>
                )}
              </Field>
            ))}
          </div>
        )}
        {error && <p role="alert" className="type-body text-bad" data-import-error>{error}</p>}
      </div>
    </Sheet>
  );
}
