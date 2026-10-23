"use client";
// Small form pieces for app-builder screens, on shell tokens (design v4 type and colours).
import { useId, type ReactNode } from "react";

export function Field({ label, hint, error, children, id }: { label: string; hint?: ReactNode; error?: string | null; children: (props: { id: string; "aria-invalid"?: boolean; "aria-describedby"?: string }) => ReactNode; id?: string }) {
  const auto = useId();
  const fid = id ?? auto;
  const hintId = `${fid}-hint`;
  const errId = `${fid}-err`;
  return (
    <div className="flex flex-col gap-1.5" data-field={label}>
      <label htmlFor={fid} className="type-label text-fg">{label}</label>
      {children({ id: fid, ...(error ? { "aria-invalid": true } : {}), "aria-describedby": [hint ? hintId : "", error ? errId : ""].filter(Boolean).join(" ") || undefined })}
      {hint && <p id={hintId} className="type-caption text-fg-2">{hint}</p>}
      {error && <p id={errId} role="alert" className="type-caption text-bad" data-field-error>{error}</p>}
    </div>
  );
}

export const inputClass = "h-9 w-full border border-line-strong bg-bg-hi px-2.5 type-body text-fg outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink aria-invalid:border-bad touch:h-11";

export async function apiJson<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; status: number; error: { code?: string; message?: string; field?: string; rev?: number; problems?: { severity: string; code: string; message: string; where: { field?: string; nodeId?: string; pageId?: string } }[] } }> {
  try {
    const res = await fetch(url, { credentials: "same-origin", ...init, headers: { ...(init?.body && typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...(init?.headers ?? {}) } });
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & T;
    if (!res.ok) return { ok: false, status: res.status, error: (body as { error?: object }).error ?? { message: "Something went wrong." } };
    return { ok: true, data: body as T };
  } catch {
    return { ok: false, status: 0, error: { message: "Atrium could not be reached." } };
  }
}
