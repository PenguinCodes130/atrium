"use client";
// Step-up prompt (auth spec "States"): a TOTP code, the password, or a hand-off to the provider,
// before a sensitive operation, always with cancel. Covers this session for 10 minutes.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button, Sheet } from "@/features/shell";
import { FormMessage, Spinner, TextField, useKeyboardInset } from "./fields";
import { MESSAGES } from "./messages";

export type StepUpMethod = "totp" | "password" | "provider";

type PanelProps = {
  next?: string;
  onDone: () => void;
  onCancel?: () => void;
  initialError?: string | null;
  /** Why the prompt opened, in one sentence (for example "Confirm it is you to allow this credential on another server."). */
  reason?: string | null;
};

/** The generic step-up refusal says nothing about the action, so it is not shown as a reason. */
const GENERIC_REASON = "Confirm it is you to continue.";

/** The reason to show for a step_up_required refusal: its message when it names the action. */
export function stepUpReason(message: string | null | undefined): string | null {
  const m = message?.trim();
  return m && m !== GENERIC_REASON ? m : null;
}

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  return body.error?.message ?? MESSAGES.generic;
}

/** The step-up form, inline. Used by the sheet and by the /step-up page. */
export function StepUpPanel({ next = "/", onDone, onCancel, initialError, reason }: PanelProps) {
  const [method, setMethod] = useState<StepUpMethod | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const inputRef = useRef<HTMLInputElement>(null);
  // In a bottom sheet the keyboard covers the bottom of the layout viewport: pad by its height so the
  // field and Confirm stay above it (auth gauntlet r1, fix 9).
  const keyboard = useKeyboardInset();

  useEffect(() => {
    let live = true;
    fetch("/api/auth/atrium/step-up", { credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        return r.json() as Promise<{ method: StepUpMethod }>;
      })
      .then((b) => live && setMethod(b.method))
      .catch((e: Error) => live && setError(e.message || MESSAGES.network));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (method && method !== "provider") inputRef.current?.focus();
  }, [method]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || !method) return;
    setBusy(true);
    setError(null);
    try {
      if (method === "provider") {
        const r = await fetch("/api/auth/atrium/step-up/provider", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ next }) });
        if (!r.ok) throw new Error(await readError(r));
        const { url } = (await r.json()) as { url: string };
        window.location.assign(url);
        return;
      }
      const r = await fetch("/api/auth/atrium/step-up", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(method === "totp" ? { method, code: value } : { method, password: value }),
      });
      if (!r.ok) throw new Error(await readError(r));
      setValue("");
      onDone();
    } catch (err) {
      setError((err as Error).message || MESSAGES.network);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4" data-step-up={method ?? "loading"} style={keyboard ? { paddingBottom: keyboard } : undefined}>
      {reason && (
        <p className="type-body-lg text-fg" data-step-up-reason>
          {reason}
        </p>
      )}
      <p className="type-body text-fg-muted">
        {method === "totp" && (reason ? "Enter the 6-digit code from your authenticator app." : "Enter the 6-digit code from your authenticator app to confirm it is you.")}
        {method === "password" && (reason ? "Enter your password." : "Enter your password to confirm it is you.")}
        {method === "provider" && "You will sign in again with your provider to confirm it is you."}
        {!method && !error && "Checking how to confirm it is you."}
      </p>
      {method === "totp" && (
        <TextField
          ref={inputRef}
          label="6-digit code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={value}
          onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))}
          required
        />
      )}
      {method === "password" && (
        <TextField ref={inputRef} label="Password" name="password" type="password" autoComplete="current-password" value={value} onChange={(e) => setValue(e.target.value)} required />
      )}
      <FormMessage message={error} />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {onCancel && (
          <Button variant="secondary" className="h-11!" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
        <Button
          type="submit"
          variant="primary"
          className="h-11!"
          disabled={busy || !method || (method === "totp" && value.length !== 6) || (method === "password" && !value)}
          aria-busy={busy}
        >
          {busy ? (
            <>
              <Spinner /> Confirming
            </>
          ) : method === "provider" ? (
            "Continue to sign in"
          ) : (
            "Confirm"
          )}
        </Button>
      </div>
    </form>
  );
}

/** Step-up in a sheet. Closing it (Esc, cancel, close) cancels the operation. */
export function StepUpSheet({ open, onDone, onCancel, next, reason }: { open: boolean; onDone: () => void; onCancel: () => void; next?: string; reason?: string | null }) {
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onCancel()} title="Confirm it is you" name="step-up" width={420}>
      {open && <StepUpPanel next={next ?? (typeof window !== "undefined" ? window.location.pathname + window.location.search : "/")} onDone={onDone} onCancel={onCancel} reason={reason} />}
    </Sheet>
  );
}

// ---- useStepUp: run a request; if it answers 403 step_up_required, prompt and retry once ----------

/**
 * run(request, { reason }): the sheet says why it opened. Without a reason it shows the refusal's own
 * message when that names the action (integrations: "Confirm it is you to allow this credential on
 * another server.").
 */
type Runner = <T extends Response>(request: () => Promise<T>, opts?: { reason?: string }) => Promise<T | null>;
const StepUpContext = createContext<Runner | null>(null);

export function StepUpProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<null | ((ok: boolean) => void)>(null);
  const [reason, setReason] = useState<string | null>(null);
  const run = useCallback<Runner>(async (request, opts) => {
    const first = await request();
    if (first.status !== 403) return first;
    const body = (await first.clone().json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    if (body.error?.code !== "step_up_required") return first;
    setReason(opts?.reason ?? stepUpReason(body.error.message));
    const ok = await new Promise<boolean>((resolve) => setPending(() => resolve));
    setPending(null);
    return ok ? request() : null;
  }, []);
  return (
    <StepUpContext.Provider value={run}>
      {children}
      <StepUpSheet open={pending !== null} reason={reason} onDone={() => pending?.(true)} onCancel={() => pending?.(false)} />
    </StepUpContext.Provider>
  );
}

/** Returns run(request): null when the user cancelled the step-up (the operation did not happen). */
export function useStepUp(): Runner {
  const ctx = useContext(StepUpContext);
  if (!ctx) throw new Error("useStepUp needs a <StepUpProvider> above it.");
  return ctx;
}
