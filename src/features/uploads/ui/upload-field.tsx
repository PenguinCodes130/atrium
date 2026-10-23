"use client";
// UploadField (wave-2-lead-prep, settings provides): pick an image or a woff2 font, upload it to this
// instance, and get back its `/uploads/...` path. Owners and members only (the server checks again).
//   <UploadField value={logo} onChange={(path) => set(path)} accept="image" />
import { useId, useRef, useState, type ChangeEvent } from "react";
import { Button } from "@/features/shell";
import { readWhole } from "./upload-file";

export type UploadFieldProps = {
  value?: string;
  onChange(path: string): void;
  accept: "image" | "font";
  /** Visible label (default "Image" or "Font file"). */
  label?: string;
};

const ACCEPT = { image: "image/png,image/jpeg,image/webp,image/gif,image/avif,image/svg+xml", font: ".woff2,font/woff2" } as const;

export function UploadField({ value, onChange, accept, label }: UploadFieldProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    // Clear the picker only after the upload: some browsers stop reading a picked file once its input
    // is reset, and the server then gets a cut-off form ("Send the file as a form upload").
    const picker = e.target;
    const file = picker.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const fd = new FormData();
      fd.set("file", await readWhole(file));
      fd.set("accept", accept);
      const r = await fetch("/api/settings/uploads", { method: "POST", body: fd });
      const j = (await r.json().catch(() => ({}))) as { path?: string; svgRemoved?: number; error?: { message?: string } };
      if (!r.ok || !j.path) throw new Error(j.error?.message ?? "The upload failed.");
      if (j.svgRemoved) setNote(`Saved. ${j.svgRemoved} unsafe part${j.svgRemoved === 1 ? " was" : "s were"} removed from the SVG.`);
      onChange(j.path);
    } catch (x) {
      setError(x instanceof Error ? x.message : "The upload failed.");
    } finally {
      setBusy(false);
      picker.value = "";
    }
  }

  return (
    <div className="flex flex-col gap-2" data-upload-field={accept}>
      <label htmlFor={id} className="type-label text-fg-2">
        {label ?? (accept === "image" ? "Image" : "Font file (woff2, at most 2 MB)")}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {accept === "image" && value ? (
          <img src={value} alt="" className="size-11 border border-line-strong object-cover" data-upload-preview />
        ) : null}
        <code className="min-w-0 flex-1 truncate type-caption text-fg-2" data-upload-value>{value ?? "nothing chosen"}</code>
        <input ref={input} id={id} type="file" accept={ACCEPT[accept]} className="sr-only" onChange={pick} aria-describedby={`${id}-msg`} data-upload-input />
        <Button variant="secondary" disabled={busy} onClick={() => input.current?.click()} data-upload-button>
          {busy ? "Uploading" : value ? "Replace" : "Upload"}
        </Button>
      </div>
      <p id={`${id}-msg`} role={error ? "alert" : "status"} className={`type-caption ${error ? "text-bad" : "text-fg-2"}`} data-upload-message>
        {error ?? note ?? ""}
      </p>
    </div>
  );
}
