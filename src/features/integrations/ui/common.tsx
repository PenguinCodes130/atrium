"use client";
// Small UI pieces shared by the integrations screens. Colours, type and motion come from the
// app-shell tokens and primitives only.
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { motion } from "motion/react";
import { durations, ErrorIcon, LockIcon, StatusMark, useReducedMotion, WarnIcon } from "@/features/shell";

/** `field` (round 8): the form field the message belongs to, when the server knows it. */
export type ApiError = { code: string; message: string; hint?: string; field?: string };
export class ApiFailure extends Error {
  constructor(readonly status: number, readonly error: ApiError) { super(error.message); }
}

/** Calls Atrium's own API (the browser never calls an integration directly). */
export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }),
    ...(init.signal ? { signal: init.signal } : {}),
    credentials: "same-origin",
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as { error?: ApiError };
  if (!res.ok) throw new ApiFailure(res.status, data.error ?? { code: "internal", message: "Something went wrong." });
  return data as T;
}

export const HEADINGS: Record<string, string> = {
  auth: "Wrong credentials",
  unreachable: "Cannot reach host",
  timeout: "Timed out",
  tls: "Certificate problem",
  bad_response: "Unexpected response",
  rate_limited: "Rate limited",
  config: "Config problem",
  permission: "Not permitted",
};

export function ErrorCallout({ heading, error, id }: { heading?: string; error: ApiError; id?: string }) {
  return (
    <div id={id} role="alert" data-error-code={error.code} className="flex gap-3 border border-line-strong bg-bg-hi p-4">
      <span className="mt-0.5 shrink-0 text-danger"><ErrorIcon width={20} height={20} aria-hidden /></span>
      <div className="min-w-0">
        <p className="type-callout text-fg" data-error-heading>{heading ?? HEADINGS[error.code] ?? "Something went wrong"}</p>
        <p className="type-body text-fg">{error.message}</p>
        {error.hint && <p className="type-caption mt-1 text-glass-muted">{error.hint}</p>}
      </div>
    </div>
  );
}

export function LockedNotice() {
  return (
    <p role="status" className="flex items-center gap-2 type-callout text-fg" data-secrets-locked>
      <span className="text-warning"><LockIcon width={16} height={16} aria-hidden /></span>
      Secrets locked: the master key is missing or wrong
    </p>
  );
}

/** Busy indicator for buttons. It turns once per `sweep` duration (no one-off timing) and is still under reduced motion. */
export function Spinner({ label = "Working" }: { label?: string }) {
  const reduced = useReducedMotion();
  return (
    <motion.svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      role="img"
      aria-label={label}
      data-spinner
      animate={reduced ? undefined : { rotate: 360 }}
      transition={reduced ? undefined : { repeat: Infinity, ease: "linear", duration: durations.sweep.ms / 1000 }}
    >
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </motion.svg>
  );
}

export function Field({ label, hint, htmlFor, children, error }: { label: string; hint?: string | undefined; htmlFor: string; children: ReactNode; error?: string | undefined }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="type-callout text-fg">{label}</label>
      {children}
      {/* Premium r3: a hint longer than one line reads as prose (body, Inter Tight), not mono caption. */}
      {hint && <p id={`${htmlFor}-hint`} className={hint.length > 60 ? "type-body text-fg-3" : "type-caption text-glass-muted"} data-field-hint>{hint}</p>}
      {error && <p className="type-caption text-danger" role="alert">{error}</p>}
    </div>
  );
}

/** Inputs are 17px on touch (the body-lg token), so phones do not zoom in on focus. */
export const inputClass =
  "h-9 touch:h-11 w-full rounded-sm border border-line bg-bg-raised px-3 type-body touch:type-body-lg text-fg placeholder:text-fg-subtle disabled:opacity-40 aria-invalid:border-danger";

/** For every URL field: the URL keyboard, and no capitalising or correcting of addresses. */
export const urlInputProps = { inputMode: "url", autoCapitalize: "off", autoCorrect: "off", spellCheck: false } as const;

export const Input = forwardRef<HTMLInputElement, ComponentPropsWithoutRef<"input">>(function Input({ className, ...p }, ref) {
  return <input ref={ref} className={`${inputClass} ${className ?? ""}`} {...p} />;
});

export function HealthLine({ status, latencyMs, version, message }: { status: "ok" | "degraded" | "down"; latencyMs: number; version?: string | undefined; message?: string | undefined }) {
  const state = status === "ok" ? "up" : status === "degraded" ? "warn" : "down";
  return (
    <span className="inline-flex flex-wrap items-center gap-2 type-caption text-glass-muted" data-health={status}>
      <StatusMark state={state} label={status === "ok" ? "Connected" : status === "degraded" ? "Degraded" : "Down"} />
      <span className="font-mono">{latencyMs} ms</span>
      {version && <span className="font-mono">v{version.replace(/^v/, "")}</span>}
      {message && <span>{message}</span>}
    </span>
  );
}

export function UntestedBadge() {
  return (
    <span className="inline-flex w-fit items-center gap-1 rounded-xs border border-line px-2 type-caption text-glass-muted" data-untested>
      <WarnIcon width={12} height={12} aria-hidden /> Untested
    </span>
  );
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** A disclosure chevron (the shell has no chevron icon yet). Points down when open. */
export function Chevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" aria-hidden className={`shrink-0 ${open ? "" : "-rotate-90"} ${className ?? ""}`}>
      <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export { slugOf, packageSegment, integrationPath } from "./titles";

/** The right side of an integration's title bar: `up 6ms`, `degraded`, `down`, `untested`, `locked`, `draft` or `disabled`. */
export function HealthStatus({ i }: { i: { status: string; locked: boolean; lastHealth?: { status: "ok" | "degraded" | "down"; latencyMs: number } | undefined } }) {
  let word: string;
  let dot: string | null = null;
  if (i.locked) word = "locked";
  else if (i.status === "draft") word = "draft";
  else if (i.status === "disabled") word = "disabled";
  else if (!i.lastHealth) word = "untested";
  else if (i.lastHealth.status === "ok") { word = `up ${i.lastHealth.latencyMs}ms`; dot = "bg-ok"; }
  else if (i.lastHealth.status === "degraded") { word = "degraded"; dot = "bg-warn"; }
  else { word = "down"; dot = "bg-bad"; }
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums" data-title-status={word.split(" ")[0]}>
      {dot && <span aria-hidden className={`inline-block size-1.5 rounded-full ${dot}`} />}
      {word}
    </span>
  );
}

/** A neutral info line (not an error): a confirmation such as "Not saved. ... is still locked to ...". */
export function InfoNote({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <p id={id} role="status" className="border-l-2 border-sky-ink bg-sky-hi px-3 py-2 type-body text-fg" data-info-note>
      {children}
    </p>
  );
}
