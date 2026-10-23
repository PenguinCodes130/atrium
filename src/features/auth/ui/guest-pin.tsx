"use client";
// The guest PIN step (design v4 "Guest and App Views"): one window on the sky band with a numeric field,
// Continue, and the tries left after a miss. Locked: the message and the field disabled.
import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/features/shell";
import { TextField } from "./fields";

type Reply =
  | { state: "redirect"; to: string }
  | { state: "expired" }
  | { state: "wrong_pin"; triesLeft: number }
  | { state: "locked"; minutes: number }
  | { state: "bad_request" };

export function lockedText(minutes: number): string {
  return `Too many tries. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

export function wrongText(triesLeft: number): string {
  return `Wrong PIN. ${triesLeft} ${triesLeft === 1 ? "try" : "tries"} left.`;
}

export function GuestPinForm({ token, initialLockedMinutes = 0 }: { token: string; initialLockedMinutes?: number }) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(initialLockedMinutes);
  const [message, setMessage] = useState(initialLockedMinutes > 0 ? lockedText(initialLockedMinutes) : "");
  const field = useRef<HTMLInputElement>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || locked > 0) return;
    if (!/^[0-9]{4,8}$/.test(pin)) {
      setMessage("Enter the 4 to 8 digit PIN.");
      field.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/g/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin }),
        credentials: "same-origin",
      });
      const reply = (await res.json().catch(() => ({ state: "bad_request" }))) as Reply;
      if (reply.state === "redirect") {
        window.location.assign(reply.to);
        return;
      }
      if (reply.state === "expired") {
        window.location.assign("/g/expired");
        return;
      }
      setPin("");
      if (reply.state === "locked") {
        setLocked(reply.minutes);
        setMessage(lockedText(reply.minutes));
      } else if (reply.state === "wrong_pin") {
        setMessage(wrongText(reply.triesLeft));
        field.current?.focus();
      } else {
        setMessage(res.status === 429 ? "Too many requests. Wait a minute and try again." : "Something went wrong. Try again.");
      }
    } catch {
      setMessage("Could not reach Atrium. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5" data-guest-pin>
      <div className="flex flex-col gap-1">
        <h1 className="type-title-3 text-fg">Enter the PIN</h1>
        <p className="type-body text-fg-2">The person who shared this link can tell you the PIN.</p>
      </div>
      <TextField
        ref={field}
        label="PIN"
        name="pin"
        type="password"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={8}
        autoFocus
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, "").slice(0, 8))}
        disabled={locked > 0}
        aria-describedby={message ? "guest-pin-message" : undefined}
        error={message && locked === 0 ? message : undefined}
      />
      <p id="guest-pin-message" role={message ? "alert" : undefined} aria-live="assertive" className="min-h-[22px] type-body text-fg" data-guest-pin-message>
        {message}
      </p>
      <Button type="submit" variant="primary" disabled={busy || locked > 0} aria-busy={busy || undefined} className="w-full">
        {busy ? "Checking" : "Continue"}
      </Button>
    </form>
  );
}
