"use client";
// "New app" (spec section 3 "Creating an app", criteria 4 and 5): name, URL slug, template, and a mapping
// for each integration the template needs (or skip it: its components show "No data").
import { useMemo, useState } from "react";
import { Button, Sheet } from "@/features/shell";
import { slugify } from "@/features/apps/doc";
import { ChoiceGroup, SelectMenu } from "@/features/settings/ui/controls";
import { apiJson, Field, inputClass } from "./fields";
import { StartPageForm, type StartChoice } from "@/features/builder/service-sheets";

/** Wave 2.9 (spec 3.7, A10.8): a new app can start as a page made from your services. */
const START_PAGE: TemplateOption = { id: "start-page", title: "Start page from your services", description: "A resource bar, then your services in groups by kind, each a tile with its live status and numbers. Like Homepage, and all of it editable.", integrations: [] };

export type TemplateOption = { id: string; title: string; description: string; integrations: { key: string; packageId: string; name: string; why: string }[] };
export type IntegrationOption = { id: string; name: string; packageId: string };

/** " Needs Prometheus (connected)." (Wave 2.7 spec 3.7): which integrations a template reads, and whether you have them. */
export function needsWords(t: TemplateOption, integrations: IntegrationOption[]): string {
  if (!t.integrations.length) return "";
  const parts = t.integrations.map((i) => `${i.name} (${integrations.some((x) => x.packageId === i.packageId) ? "connected" : "not connected yet"})`);
  return ` Needs ${parts.join(" and ")}.`;
}

export function NewAppSheet({ open, onClose, onCreated, templates, integrations, initialTemplate }: { open: boolean; onClose(): void; onCreated(slug: string): void; templates: TemplateOption[]; integrations: IntegrationOption[]; initialTemplate?: string }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [template, setTemplate] = useState(initialTemplate ?? "blank");
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const all = useMemo(() => [START_PAGE, ...templates.filter((x) => x.id !== START_PAGE.id)], [templates]);
  const t = useMemo(() => all.find((x) => x.id === template), [all, template]);
  const [start, setStart] = useState<StartChoice | null>(null);
  const shownSlug = slugTouched ? slug : slugify(name);

  async function submit() {
    setBusy(true);
    setErrors({});
    const map: Record<string, string | null> = {};
    // The choice shown is the choice sent: an untouched mapping is the first integration listed (Wave 2.7 spec 3.7).
    for (const i of t?.integrations ?? []) {
      const chosen = mappings[i.key] ?? integrations.find((x) => x.packageId === i.packageId)?.id ?? "skip";
      map[i.key] = chosen !== "skip" ? chosen : null;
    }
    const startPage = template === START_PAGE.id;
    if (startPage && !start) { setBusy(false); setErrors({ form: "Tick at least one service, or add a link." }); return; }
    const r = await apiJson<{ app: { id: string; slug: string } }>("/api/apps", { method: "POST", body: JSON.stringify({ name, slug: shownSlug, template: startPage ? "blank" : template, mappings: map }) });
    if (r.ok && startPage && start) {
      // The app exists; its first page is made from the services in one change (A10.8).
      const made = await apiJson<{ rev: number }>(`/api/apps/${encodeURIComponent(r.data.app.id)}/start-page`, { method: "POST", body: JSON.stringify(start) });
      setBusy(false);
      if (!made.ok) setErrors({ form: `The app was made, but its start page was not: ${made.error.message ?? "try Insert > Start page in the builder."}` });
      return onCreated(r.data.app.slug);
    }
    setBusy(false);
    if (r.ok) return onCreated(r.data.app.slug);
    setErrors({ [r.error.field ?? "form"]: r.error.message ?? "That did not work." });
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()} title="New app" path="apps / new" name="new-app" width={480}
      footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit} disabled={busy || !name.trim()} data-create-app>Create app</Button></div>}>
      {/* A plain group, not a <form>: inside a form the shared SelectMenu (Radix) adds a hidden native
          <select> for submission, which this sheet does not need. Enter in a text field creates the app. */}
      <div role="group" aria-label="New app" className="flex flex-col gap-5" onKeyDown={(e) => { if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT" && name.trim() && !busy) { e.preventDefault(); void submit(); } }} data-new-app-form>
        <Field label="Name" error={errors.name}>{(a) => <input {...a} className={inputClass} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus data-new-app-name />}</Field>
        <Field label="URL name" hint={<>Opens at /a/{shownSlug || "your-app"}. Lowercase letters, digits and hyphens, up to 40.</>} error={errors.slug}>
          {(a) => <input {...a} className={`${inputClass} font-mono`} value={shownSlug} onChange={(e) => { setSlugTouched(true); setSlug(e.target.value); }} data-new-app-slug />}
        </Field>
        {/* The shared square controls (gauntlet w2-r2 item 6): one row per template with an ink-fill square radio. */}
        <ChoiceGroup<string> label="Start from" look="rows" name="template" value={template} onChange={setTemplate} options={all.map((x) => ({ value: x.id, label: x.title, description: `${x.description}${needsWords(x, integrations)}`, data: { "template-option": x.id } }))} />
        {template === START_PAGE.id && <StartPageForm onChoice={setStart} />}
        {t && t.integrations.length > 0 && (
          <fieldset className="flex flex-col gap-3" data-template-mapping>
            <legend className="mb-1 type-label text-fg">Connect your services</legend>
            {t.integrations.map((i) => {
              const options = integrations.filter((x) => x.packageId === i.packageId);
              return (
                <Field key={i.key} label={i.name} hint={options.length ? i.why : `No ${i.name} integration you can use yet. Skip it, and its components show "No data".`}>
                  {() => (
                    <div data-map-integration={i.key}>
                      <SelectMenu label={i.name} hideLabel name={`map-${i.key}`} value={mappings[i.key] ?? (options[0]?.id ?? "skip")} onChange={(v) => setMappings((m) => ({ ...m, [i.key]: v }))} options={[...options.map((o) => ({ value: o.id, label: o.name })), { value: "skip", label: "Skip for now" }]} />
                    </div>
                  )}
                </Field>
              );
            })}
          </fieldset>
        )}
        {errors.form && <p role="alert" className="type-body text-bad" data-form-error>{errors.form}</p>}
      </div>
    </Sheet>
  );
}
