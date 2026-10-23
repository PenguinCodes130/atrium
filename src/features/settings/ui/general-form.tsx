"use client";
// General (owner only; settings spec 3.1): instance name, audit log retention, app version retention.
import { useState, type FormEvent } from "react";
import { Button, toast } from "@/features/shell";
import { api, type ApiError } from "./client-api";
import { ChoiceGroup, Field, INPUT_CLASS } from "./controls";

type Values = { instanceName: string | null; auditRetentionDays: number; versionRetention: "all" | number };
// Settings r2 (gauntlet w2-r1 items 6 and 14): design-system controls, one label style, one input height.

export function GeneralForm({ initial, defaultName }: { initial: Values; defaultName: string }) {
  const [name, setName] = useState(initial.instanceName ?? "");
  const [audit, setAudit] = useState(String(initial.auditRetentionDays));
  const [keepAll, setKeepAll] = useState(initial.versionRetention === "all");
  const [keepN, setKeepN] = useState(String(initial.versionRetention === "all" ? 50 : initial.versionRetention));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const local: Record<string, string> = {};
    const a = Number(audit);
    if (!Number.isInteger(a) || a < 1) local.auditRetentionDays = "Audit retention must be at least 1 day.";
    const n = Number(keepN);
    if (!keepAll && (!Number.isInteger(n) || n < 20)) local.versionRetention = "Keep at least 20 versions.";
    setErrors(local);
    if (Object.keys(local).length) return;
    setBusy(true);
    try {
      await api("/api/settings/instance", { method: "PUT", body: { instanceName: name.trim() || null, auditRetentionDays: a, versionRetention: keepAll ? "all" : n } });
      toast({ kind: "success", title: "Saved General settings" });
    } catch (x) {
      const err = x as ApiError;
      setErrors(Object.fromEntries((err.issues ?? [{ path: "form", message: err.message }]).map((i) => [i.path || "form", i.message])));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex max-w-[560px] flex-col gap-6" noValidate data-general-form>
      <Field label="Instance name" htmlFor="general-name" hint={`Shown in the clock readout. Empty uses ${defaultName}.`} error={errors.instanceName}>
        <input id="general-name" value={name} maxLength={40} placeholder={defaultName} onChange={(e) => setName(e.target.value)} className={INPUT_CLASS} data-field="instanceName" aria-invalid={!!errors.instanceName} />
      </Field>
      <div className="flex flex-col gap-1.5">
        <Field label="Keep the audit log for (days)" htmlFor="general-audit">
          <input id="general-audit" inputMode="numeric" value={audit} onChange={(e) => setAudit(e.target.value)} className={`${INPUT_CLASS} max-w-40 font-mono`} data-field="auditRetentionDays" aria-invalid={!!errors.auditRetentionDays} />
        </Field>
        {errors.auditRetentionDays && <span role="alert" className="type-caption text-bad" data-field-error="auditRetentionDays">{errors.auditRetentionDays}</span>}
      </div>
      <div className="flex flex-col gap-1.5">
        <ChoiceGroup
          label="App versions"
          look="rows"
          name="versions"
          value={keepAll ? "all" : "last"}
          onChange={(v) => setKeepAll(v === "all")}
          options={[
            { value: "all", label: "Keep every version", data: { field: "keepAll" } },
            { value: "last", label: "Keep the last N versions", description: "At least 20. The published version and the five before it are never removed.", data: { field: "keepLast" } },
          ]}
        />
        <Field label="Versions to keep (N)" htmlFor="general-keep">
          <input id="general-keep" inputMode="numeric" value={keepN} onChange={(e) => { setKeepN(e.target.value); setKeepAll(false); }} className={`${INPUT_CLASS} max-w-40 font-mono`} data-field="versionRetention" aria-invalid={!!errors.versionRetention} />
        </Field>
        {errors.versionRetention && <span role="alert" className="type-caption text-bad" data-field-error="versionRetention">{errors.versionRetention}</span>}
      </div>
      {errors.form && <p role="alert" className="type-body text-bad">{errors.form}</p>}
      <div><Button variant="ink" type="submit" disabled={busy} data-save-general>{busy ? "Saving" : "Save"}</Button></div>
    </form>
  );
}
