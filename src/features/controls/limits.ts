// Control run limits (architecture v3 section 6.2, amendment A1.4): 30 runs per minute per
// principal per app, a cooldown per control (it guards the device), and at most 2 runs of one
// control at a time; a third click waits at most 5 seconds, then gets "busy". In memory: Atrium
// is one Node process (section 1).

export const RUNS_PER_MINUTE = 30;
export const DEFAULT_COOLDOWN_MS = 500;
export const MIN_COOLDOWN_MS = 250;
export const MAX_IN_FLIGHT = 2;
export const MAX_WAIT_MS = 5_000;
/**
 * Gauntlet r2 security finding 2: refused runs are audited, so they get their own per principal
 * limit, consulted before the audit entry is written. Past it, a refusal answers 429 and only the
 * first one in the minute is audited.
 */
export const REFUSALS_PER_MINUTE = 10;

export function cooldownOf(ms: number | undefined): number {
  return typeof ms === "number" && Number.isFinite(ms) ? Math.max(MIN_COOLDOWN_MS, ms) : DEFAULT_COOLDOWN_MS;
}

type Waiter = { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> };

export class ControlLimits {
  private runs = new Map<string, number[]>();
  private lastStart = new Map<string, number>();
  private inFlight = new Map<string, number>();
  private queues = new Map<string, Waiter[]>();
  private rateAudited = new Map<string, number>();
  private refusals = new Map<string, number[]>();
  private refusalAudited = new Map<string, number>();

  constructor(private now: () => number = Date.now) {}

  /** The per minute limit. Returns the seconds to wait when the run is refused. */
  rate(principalKey: string, appId: string): { ok: true } | { ok: false; retryAfterSec: number } {
    const key = `${principalKey}|${appId}`;
    const t = this.now();
    const list = (this.runs.get(key) ?? []).filter((x) => t - x < 60_000);
    if (list.length >= RUNS_PER_MINUTE) {
      this.runs.set(key, list);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((60_000 - (t - list[0]!)) / 1000)) };
    }
    list.push(t);
    this.runs.set(key, list);
    return { ok: true };
  }

  /** True for the first rate-limit refusal of a principal in a minute: only that one is audited (A1.4). */
  firstRateRefusal(principalKey: string): boolean {
    const t = this.now();
    const last = this.rateAudited.get(principalKey);
    if (last !== undefined && t - last < 60_000) return false;
    this.rateAudited.set(principalKey, t);
    return true;
  }

  /**
   * Counts one refused run for a principal (any app). Returns ok while it is within
   * REFUSALS_PER_MINUTE, otherwise the seconds to wait and whether this is the first over-limit
   * refusal in the minute (the only one that is audited).
   */
  refusal(principalKey: string): { ok: true } | { ok: false; retryAfterSec: number; audit: boolean } {
    const t = this.now();
    const list = (this.refusals.get(principalKey) ?? []).filter((x) => t - x < 60_000);
    if (list.length >= REFUSALS_PER_MINUTE) {
      this.refusals.set(principalKey, list);
      const last = this.refusalAudited.get(principalKey);
      const audit = last === undefined || t - last >= 60_000;
      if (audit) this.refusalAudited.set(principalKey, t);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((60_000 - (t - list[0]!)) / 1000)), audit };
    }
    list.push(t);
    this.refusals.set(principalKey, list);
    return { ok: true };
  }

  /** The cooldown of one control (per control, across viewers). Starts when a run is accepted. */
  cooldown(controlKey: string, cooldownMs: number): { ok: true } | { ok: false; retryAfterMs: number } {
    const t = this.now();
    const last = this.lastStart.get(controlKey);
    if (last !== undefined && t - last < cooldownMs) return { ok: false, retryAfterMs: cooldownMs - (t - last) };
    this.lastStart.set(controlKey, t);
    return { ok: true };
  }

  /** Waits for a run slot of one control; false after MAX_WAIT_MS (the click gets "busy"). */
  acquire(controlKey: string, maxWaitMs = MAX_WAIT_MS): Promise<boolean> {
    const n = this.inFlight.get(controlKey) ?? 0;
    if (n < MAX_IN_FLIGHT) {
      this.inFlight.set(controlKey, n + 1);
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const q = this.queues.get(controlKey) ?? [];
      const w: Waiter = {
        resolve,
        timer: setTimeout(() => {
          const list = this.queues.get(controlKey) ?? [];
          const i = list.indexOf(w);
          if (i >= 0) list.splice(i, 1);
          resolve(false);
        }, maxWaitMs),
      };
      q.push(w);
      this.queues.set(controlKey, q);
    });
  }

  release(controlKey: string): void {
    const q = this.queues.get(controlKey);
    const next = q?.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve(true); // the slot passes straight to the next waiting click
      return;
    }
    const n = (this.inFlight.get(controlKey) ?? 1) - 1;
    if (n <= 0) this.inFlight.delete(controlKey);
    else this.inFlight.set(controlKey, n);
  }

  inFlightCount(controlKey: string): number {
    return this.inFlight.get(controlKey) ?? 0;
  }
}

const g = globalThis as unknown as { __atriumControlLimits?: ControlLimits };
export function controlLimits(): ControlLimits {
  return (g.__atriumControlLimits ??= new ControlLimits());
}
/** For tests. */
export function resetControlLimits(now?: () => number): ControlLimits {
  g.__atriumControlLimits = new ControlLimits(now);
  return g.__atriumControlLimits;
}
