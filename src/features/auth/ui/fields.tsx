"use client";
// Form pieces for the auth screens, on the app-shell tokens (design v2 sections 1 and 6).
// Inputs are 44px tall everywhere, so every control meets the 44 x 44 touch target.
// Text in form controls is at least 16px on touch screens and narrow windows (body-lg, 17px), so iOS
// Safari does not zoom the page on focus (auth gauntlet r1, fix 9). No maximum-scale hack.
import { forwardRef, useEffect, useId, useState, type FocusEvent, type InputHTMLAttributes, type ReactNode } from "react";

/** Type classes for every input and select on the auth screens. */
export const CONTROL_TYPE = "type-body max-sm:type-body-lg touch:type-body-lg";

/** Keeps a focused field in view while the on-screen keyboard opens (the visual viewport shrinks). */
export function keepInViewOnKeyboard(e: FocusEvent<HTMLElement>) {
  const el = e.currentTarget;
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  const fix = () => {
    if (document.activeElement === el) el.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  fix();
  if (!vv) return;
  vv.addEventListener("resize", fix);
  el.addEventListener("blur", () => vv.removeEventListener("resize", fix), { once: true });
}

/**
 * Height of the on-screen keyboard over the layout viewport (iOS keeps the layout viewport and
 * shrinks only the visual one). Bottom sheets pad by it so their field and buttons sit above it.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)));
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}
import { ErrorIcon } from "@/features/shell";

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: ReactNode;
  /** Marks the field invalid (the message itself is shown elsewhere, for example in a FormMessage). */
  error?: string;
  /** A message about this field alone, shown under it and read with it (for example "Enter your email."). */
  fieldError?: string | null;
};

export const TextField = forwardRef<HTMLInputElement, FieldProps>(function TextField({ label, hint, error, fieldError, id, className, onFocus, ...rest }, ref) {
  const auto = useId();
  const inputId = id ?? auto;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = fieldError ? `${inputId}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="type-callout text-fg">
        {label}
      </label>
      <input
        ref={ref}
        id={inputId}
        aria-describedby={describedBy}
        aria-invalid={error || fieldError ? true : undefined}
        className={
          `h-11 w-full rounded-sm border border-line-strong bg-bg-hi px-3 ${CONTROL_TYPE} text-fg ` +
          "placeholder:text-fg-subtle aria-invalid:border-danger disabled:opacity-40 " +
          (className ?? "")
        }
        {...rest}
        onFocus={(e) => {
          onFocus?.(e);
          keepInViewOnKeyboard(e);
        }}
      />
      {fieldError && (
        <p id={errorId} className="flex items-start gap-2 type-body text-fg" data-field-error>
          <ErrorIcon aria-hidden className="mt-0.5 size-4 flex-none text-danger" />
          <span>{fieldError}</span>
        </p>
      )}
      {hint && (
        <p id={hintId} className="type-caption text-fg-muted">
          {hint}
        </p>
      )}
    </div>
  );
});

/** A plain message under a form. Errors are announced assertively, notices politely. */
export function FormMessage({ message, tone = "error", id }: { message?: string | null; tone?: "error" | "info"; id?: string }) {
  return (
    <div id={id} role={tone === "error" ? "alert" : "status"} aria-live={tone === "error" ? "assertive" : "polite"} className="min-h-0">
      {message ? (
        <p className={`flex items-start gap-2 type-body ${tone === "error" ? "text-fg" : "text-fg-muted"}`} data-auth-message={tone}>
          {tone === "error" && <ErrorIcon aria-hidden className="mt-0.5 size-4 flex-none text-danger" />}
          <span>{message}</span>
        </p>
      ) : null}
    </div>
  );
}

export function Spinner() {
  // Static under reduced motion (globals.css stops the shimmer keyframes there).
  return <span aria-hidden className="inline-block size-4 flex-none rounded-full border-2 border-current border-r-transparent motion-safe:animate-spin reduced-motion:animate-none" />;
}
