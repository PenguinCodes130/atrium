import { describe, expect, it } from "vitest";
import { createToastStore, MAX_VISIBLE_TOASTS, politenessFor, TOAST_LIFETIME_MS } from "./toast-store";
import { driftAt } from "./drift";

function fakeClock() {
  let now = 0;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      timers.set(++id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (h: unknown) => void timers.delete(h as number),
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
      }
      now = end;
    },
  };
}

describe("toasts (criteria 15, 16, 17, 45)", () => {
  it("info and success close after 5s, errors after 8s", () => {
    const c = fakeClock();
    const s = createToastStore(c);
    s.push({ kind: "info", title: "i" });
    s.push({ kind: "success", title: "s" });
    s.push({ kind: "error", title: "e" });
    c.advance(4999);
    expect(s.getSnapshot().visible.map((t) => t.title)).toEqual(["e", "s", "i"]);
    c.advance(1);
    expect(s.getSnapshot().visible.map((t) => t.title)).toEqual(["e"]);
    c.advance(2999);
    expect(s.getSnapshot().visible).toHaveLength(1);
    c.advance(1);
    expect(s.getSnapshot().visible).toHaveLength(0);
  });

  it("only critical alerts and Secrets locked stay until dismissed", () => {
    expect(Object.entries(TOAST_LIFETIME_MS).filter(([, v]) => v === null).map(([k]) => k).sort()).toEqual(["critical", "secrets-locked"]);
    const c = fakeClock();
    const s = createToastStore(c);
    const a = s.push({ kind: "critical", title: "disk" });
    s.push({ kind: "secrets-locked", title: "Secrets locked" });
    c.advance(60 * 60 * 1000);
    expect(s.getSnapshot().visible).toHaveLength(2);
    s.dismiss(a);
    expect(s.getSnapshot().visible.map((t) => t.title)).toEqual(["Secrets locked"]);
  });

  it("shows at most 3, newest on top; older ones wait with their timers stopped", () => {
    const c = fakeClock();
    const s = createToastStore(c);
    for (let i = 1; i <= 5; i++) s.push({ kind: "info", title: `t${i}` });
    expect(MAX_VISIBLE_TOASTS).toBe(3);
    expect(s.getSnapshot().visible.map((t) => t.title)).toEqual(["t5", "t4", "t3"]);
    expect(s.getSnapshot().queued).toBe(2);
    c.advance(5000);
    // the three visible ones closed; the two waiting now show with full timers
    expect(s.getSnapshot().visible.map((t) => t.title)).toEqual(["t2", "t1"]);
    c.advance(4999);
    expect(s.getSnapshot().visible).toHaveLength(2);
    c.advance(1);
    expect(s.getSnapshot().visible).toHaveLength(0);
  });

  it("hover or focus pauses the timer, and it resumes with the time left", () => {
    const c = fakeClock();
    const s = createToastStore(c);
    const id = s.push({ kind: "info", title: "x" });
    c.advance(3000);
    s.pause(id);
    c.advance(60_000);
    expect(s.getSnapshot().visible).toHaveLength(1);
    s.resume(id);
    c.advance(1999);
    expect(s.getSnapshot().visible).toHaveLength(1);
    c.advance(1);
    expect(s.getSnapshot().visible).toHaveLength(0);
  });

  it("errors and critical alerts are announced assertively, the rest politely", () => {
    expect(politenessFor("info")).toBe("polite");
    expect(politenessFor("success")).toBe("polite");
    expect(politenessFor("secrets-locked")).toBe("polite");
    expect(politenessFor("error")).toBe("assertive");
    expect(politenessFor("critical")).toBe("assertive");
  });
});

describe("time-of-day drift (spec v2 criterion 32)", () => {
  const at = (h: number, m = 0) => {
    const d = new Date(2026, 9, 17, h, m, 0, 0);
    return driftAt(d);
  };
  it("has the specified strengths inside each band", () => {
    expect(at(7).strength).toBe(0.14);
    expect(at(7).band).toBe("morning");
    expect(at(12).strength).toBe(0);
    expect(at(12).css).toBeNull();
    expect(at(17).strength).toBe(0.16);
    expect(at(23).strength).toBe(0.1);
    expect(at(3).strength).toBe(0.1);
  });
  it("uses the specified colours", () => {
    expect(at(7).css).toBe("#A9C8E4");
    expect(at(17).css).toBe("#E9B949");
    expect(at(23).css).toBe("#8E6416");
  });
  it("blends over the 30 minutes after each boundary", () => {
    expect(at(9, 0).strength).toBe(0.14);
    expect(at(9, 15).strength).toBeCloseTo(0.07, 3);
    expect(at(9, 30).strength).toBe(0);
    expect(at(16, 15).strength).toBeCloseTo(0.08, 3);
    expect(at(19, 45).strength).toBeCloseTo(0.13, 3);
    expect(at(5, 15).strength).toBeCloseTo(0.12, 3);
  });
});
