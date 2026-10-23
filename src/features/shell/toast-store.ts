// Toast state, kept free of React so timing and stacking are unit-testable (design v2 "Toasts").
// Info and success close after 5s, errors after 8s. Only critical alerts and the "Secrets locked"
// notice stay until dismissed. At most 3 show at once, newest on top; older ones wait their turn
// with their timers stopped. Hover or focus pauses a toast's timer.

export type ToastKind = "info" | "success" | "error" | "critical" | "secrets-locked";

export type ToastInput = {
  kind?: ToastKind;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
};

export type ToastItem = Required<Pick<ToastInput, "kind" | "title">> &
  Pick<ToastInput, "description" | "action"> & {
    id: string;
    createdAt: number;
    /** ms left on the timer, or null when it stays until dismissed */
    remainingMs: number | null;
    paused: boolean;
  };

export const TOAST_LIFETIME_MS: Record<ToastKind, number | null> = {
  info: 5000,
  success: 5000,
  error: 8000,
  critical: null,
  "secrets-locked": null,
};
export const MAX_VISIBLE_TOASTS = 3;

/** Errors and critical alerts are announced assertively; everything else politely. */
export function politenessFor(kind: ToastKind): "polite" | "assertive" {
  return kind === "error" || kind === "critical" ? "assertive" : "polite";
}

type Clock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type ToastStore = ReturnType<typeof createToastStore>;

export function createToastStore(clock: Clock = realClock) {
  let items: ToastItem[] = []; // newest first
  let snapshot: { visible: ToastItem[]; queued: number } = { visible: [], queued: 0 };
  const timers = new Map<string, { handle: unknown; startedAt: number }>();
  const listeners = new Set<() => void>();
  let seq = 0;

  const isVisible = (id: string) => items.slice(0, MAX_VISIBLE_TOASTS).some((t) => t.id === id);

  function stopTimer(id: string) {
    const timer = timers.get(id);
    if (!timer) return;
    clock.clearTimeout(timer.handle);
    timers.delete(id);
    const item = items.find((t) => t.id === id);
    if (item && item.remainingMs !== null) item.remainingMs = Math.max(0, item.remainingMs - (clock.now() - timer.startedAt));
  }

  // Visible, unpaused, timed toasts run; everything else is stopped.
  function sync() {
    for (const item of items) {
      const shouldRun = isVisible(item.id) && !item.paused && item.remainingMs !== null;
      const running = timers.has(item.id);
      if (shouldRun && !running) {
        const handle = clock.setTimeout(() => dismiss(item.id), item.remainingMs!);
        timers.set(item.id, { handle, startedAt: clock.now() });
      } else if (!shouldRun && running) {
        stopTimer(item.id);
      }
    }
    snapshot = { visible: items.slice(0, MAX_VISIBLE_TOASTS).map((t) => ({ ...t })), queued: Math.max(0, items.length - MAX_VISIBLE_TOASTS) };
    listeners.forEach((l) => l());
  }

  const pending = new Map<string, unknown>();

  function push(input: ToastInput, reservedId?: string): string {
    const kind = input.kind ?? "info";
    const id = reservedId ?? `t${++seq}`;
    items = [{ id, kind, title: input.title, description: input.description, action: input.action, createdAt: clock.now(), remainingMs: TOAST_LIFETIME_MS[kind], paused: false }, ...items];
    sync();
    return id;
  }

  /** Push after `ms` (the success toast waits for the title bar glow, design v4 Note 1). */
  function pushAfter(input: ToastInput, ms: number): string {
    const id = `t${++seq}`;
    pending.set(
      id,
      clock.setTimeout(() => {
        pending.delete(id);
        push(input, id);
      }, ms),
    );
    return id;
  }

  function dismiss(id: string) {
    const waiting = pending.get(id);
    if (waiting !== undefined) {
      clock.clearTimeout(waiting);
      pending.delete(id);
    }
    stopTimer(id);
    items = items.filter((t) => t.id !== id);
    sync();
  }

  function setPaused(id: string, paused: boolean) {
    const item = items.find((t) => t.id === id);
    if (!item || item.paused === paused) return;
    if (paused) stopTimer(id);
    item.paused = paused;
    sync();
  }

  return {
    push: (input: ToastInput) => push(input),
    pushAfter,
    dismiss,
    pause: (id: string) => setPaused(id, true),
    resume: (id: string) => setPaused(id, false),
    clear() {
      for (const h of pending.values()) clock.clearTimeout(h);
      pending.clear();
      for (const id of [...timers.keys()]) stopTimer(id);
      items = [];
      sync();
    },
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
