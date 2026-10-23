"use client";
// Backups (owner only; settings spec 3.10). Export: without secrets (default) or with secrets sealed
// under a password typed twice; every export first asks for a step-up (A4.4). Import: a fresh step-up
// first, like export (gauntlet w2-r1 item 1), then a fresh instance or the explicit "Replace everything
// on this Atrium" confirmation naming what will be lost; a backup with secrets asks for its password,
// or "Import without secrets". Restored uploads that fail the upload checks are listed (item 2).
// Controls are the settings design-system ones (item 6); counts read "1 library component" (item 13);
// the last-backup line updates as soon as the download starts (item 10).
import { useState, type FormEvent } from "react";
import { StepUpProvider, useStepUp } from "@/features/auth/components";
import { Button, Switch, Window, toast } from "@/features/shell";
import { counted, countedList } from "@/features/backup/words";
import type { ApiError } from "./client-api";
import { Checkbox, ChoiceGroup, Field, FileField, INPUT_CLASS } from "./controls";

type History = { at: string; event: string; withSealedValues: boolean }[];

export function BackupsPanel({ history, existing }: { history: History; existing: Record<string, number> }) {
  return (
    <StepUpProvider>
      <div className="grid gap-8 xl:grid-cols-2">
        <ExportWindow history={history} />
        <ImportWindow existing={existing} />
      </div>
    </StepUpProvider>
  );
}

async function readError(r: Response): Promise<ApiError> {
  const j = (await r.json().catch(() => ({}))) as { error?: { message?: string; code?: string } };
  return { message: j.error?.message ?? "Something went wrong. Try again.", code: j.error?.code, extra: j, status: r.status };
}

function ExportWindow({ history }: { history: History }) {
  const runStepUp = useStepUp();
  const [withSecrets, setWithSecrets] = useState(false);
  const [audit, setAudit] = useState(true);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState(() => history.find((h) => h.event === "backup.exported") ?? null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (withSecrets && pw.length < 12) return setError("The backup password must be at least 12 characters.");
    if (withSecrets && pw !== pw2) return setError("The two passwords do not match.");
    setBusy(true);
    try {
      const r = await runStepUp(
        () => fetch("/api/settings/backup/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ includeSecrets: withSecrets, includeAudit: audit, ...(withSecrets ? { password: pw, passwordAgain: pw2 } : {}) }) }),
        { reason: "Confirm it is you to export a backup of this Atrium." },
      );
      if (!r) return;
      if (!r.ok) return setError((await readError(r)).message);
      // The server has written the backup.exported entry by now: show it at once (item 10).
      setLast({ at: new Date().toISOString(), event: "backup.exported", withSealedValues: withSecrets });
      const blob = await r.blob();
      const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? "atrium-backup.atrium";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setPw("");
      setPw2("");
      toast({ kind: "success", title: "Backup ready", description: name });
    } catch {
      setError("The export failed. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Window title="backups / export" data-backup-export>
      <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
        <p className="type-body text-fg-2" data-last-export>{last ? `Last backup made ${new Date(last.at).toLocaleString()}${last.withSealedValues ? ", with secrets" : ""}.` : "No backup made from this Atrium yet"}</p>
        <ChoiceGroup
          label="Secrets"
          look="rows"
          name="secrets"
          value={withSecrets ? "with" : "without"}
          onChange={(v) => setWithSecrets(v === "with")}
          options={[
            { value: "without", label: "Without secrets", description: "You type them again after restoring.", data: { "without-secrets": "" } },
            { value: "with", label: "With secrets, sealed under a password", description: "Only this password opens them.", data: { "with-secrets": "" } },
          ]}
        />
        {withSecrets && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Backup password" htmlFor="backup-pw"><input id="backup-pw" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} className={INPUT_CLASS} data-backup-password /></Field>
            <Field label="Type it again" htmlFor="backup-pw2"><input id="backup-pw2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} className={INPUT_CLASS} data-backup-password-again /></Field>
            <p className="type-caption text-fg-2 sm:col-span-2">At least 12 characters. Without it the secrets in this backup cannot be opened, by you or anyone.</p>
          </div>
        )}
        <div className="border-t border-line pt-3"><Switch label="Include the audit log" checked={audit} onCheckedChange={setAudit} /></div>
        {error && <p role="alert" className="type-body text-bad" data-export-error>{error}</p>}
        <div><Button variant="primary" type="submit" disabled={busy} data-export-backup>{busy ? "Preparing backup" : "Export backup"}</Button></div>
      </form>
    </Window>
  );
}

function ImportWindow({ existing }: { existing: Record<string, number> }) {
  const runStepUp = useStepUp();
  const [refused, setRefused] = useState<{ file: string; reason: string }[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const hasData = Object.keys(existing).length > 0;
  const lose = countedList(existing);

  async function run(withoutSecrets: boolean) {
    if (!file) return setError("Choose a backup file first.");
    if (hasData && !replace) return setError(`Confirm "Replace everything on this Atrium" first. You will lose ${lose}.`);
    setBusy(withoutSecrets ? "without" : "import");
    setError(null);
    try {
      const fd = new FormData();
      fd.set("file", file);
      if (password && !withoutSecrets) fd.set("password", password);
      if (withoutSecrets) fd.set("withoutSecrets", "1");
      if (replace) fd.set("replace", "1");
      setRefused([]);
      // A fresh step-up first, before the file is sent (item 1). The import itself checks it again.
      const reason = "Confirm it is you to import a backup. Importing can replace everything on this Atrium.";
      const check = await runStepUp(() => fetch("/api/settings/backup/import?check=1", { method: "POST" }), { reason });
      if (!check) return setError("Import cancelled. Nothing was changed.");
      if (!check.ok) return setError((await readError(check)).message);
      setDone("Checking the backup, then writing everything in one step.");
      const r = await runStepUp(() => fetch("/api/settings/backup/import", { method: "POST", body: fd }), { reason });
      if (!r) {
        setDone(null);
        return setError("Import cancelled. Nothing was changed.");
      }
      if (!r.ok) {
        const e = await readError(r);
        if (e.code === "password_needed") setNeedsPassword(true);
        setDone(null);
        return setError(e.message);
      }
      const j = (await r.json()) as { usersToReset: number; withoutSecrets: boolean; uploadsRefused?: { file: string; reason: string }[] };
      const skipped = j.uploadsRefused ?? [];
      setRefused(skipped);
      setDone(`Backup restored.${j.usersToReset ? ` ${j.usersToReset} imported ${j.usersToReset === 1 ? "person needs" : "people need"} a reset link from Users before they can sign in.` : ""}${j.withoutSecrets ? " Integrations and credentials that had values need them typed again." : ""}${skipped.length ? ` ${counted(skipped.length, "uploads")} failed the upload checks and ${skipped.length === 1 ? "was" : "were"} not restored.` : ""}`);
      setPassword("");
      toast({ kind: "success", title: "Backup restored" });
    } catch {
      setDone(null);
      setError("The import failed. Nothing was changed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Window title="backups / import" data-backup-import>
      <form onSubmit={(e) => { e.preventDefault(); void run(false); }} className="flex flex-col gap-5" noValidate>
        <p className="type-body text-fg-2">Restore a backup from another Atrium. The file is checked first; a damaged file, a newer version or a wrong password changes nothing.</p>
        <FileField label="Backup file (.atrium)" accept=".atrium,application/zip,application/octet-stream" file={file} onFile={(f) => { setFile(f); setNeedsPassword(false); setError(null); }} data-backup-file />
        <Field label="Backup password (only for a backup with secrets)" htmlFor="import-pw">
          <input id="import-pw" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} className={INPUT_CLASS} data-import-password />
        </Field>
        {hasData && (
          <div className="border border-bad px-3" data-replace-confirm>
            <Checkbox tone="danger" checked={replace} onCheckedChange={setReplace} label={<strong className="font-semibold">Replace everything on this Atrium.</strong>} description={`You will lose ${lose}. Your own sign-in stays as it is.`} />
          </div>
        )}
        {error && <p role="alert" className="type-body text-bad" data-import-error>{error}</p>}
        {done && <p role="status" className="type-body text-fg" data-import-status>{done}</p>}
        {refused.length > 0 && (
          <ul className="flex flex-col gap-1 border-t border-line pt-3" aria-label="Uploads not restored" data-uploads-refused>
            {refused.map((u) => <li key={u.file} className="type-caption text-fg-2"><span className="font-mono text-fg">{u.file}</span>: {u.reason}.</li>)}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant={hasData ? "destructive-confirm" : "primary"} type="submit" disabled={busy !== null} data-import-backup>{busy === "import" ? "Importing" : "Import backup"}</Button>
          {needsPassword && <Button variant="secondary" disabled={busy !== null} onClick={() => run(true)} data-import-without>{busy === "without" ? "Importing" : "Import without secrets"}</Button>}
        </div>
      </form>
    </Window>
  );
}
