// The host side of the HTML block bridge as pure rules (architecture v3 4.7, spec 3.5.3): which frame
// messages are honoured. The React host (html-block.tsx) only ever listens on its private port, so a
// message posted to the window never reaches these rules at all.
import type { FrameToHost } from "@/core/contracts";

export const MAX_MESSAGE_BYTES = 256 * 1024;
export const MAX_AUTO_HEIGHT = 4000;
export const CONTROL_LIMIT = { count: 10, windowMs: 10_000 } as const;
export const MAX_CODE_BYTES = 64 * 1024;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export type BridgeState = {
  /** Control ids the block lists (props.controls). */
  listed: string[];
  /** Control ids in the document being shown. */
  inDocument: string[];
  /** Page slugs of the same app. */
  pages: { id: string; slug: string }[];
  height: "auto" | number;
  /** Times of accepted control requests (ms), for the 10 per 10 seconds limit. */
  recent: number[];
};

export type BridgeAction =
  | { kind: "drop"; reason: string }
  | { kind: "ready" }
  | { kind: "resize"; height: number }
  | { kind: "control"; reqId: string; controlId: string; input?: unknown }
  | { kind: "navigate"; pageId: string }
  | { kind: "log"; level: "info" | "warn" | "error"; message: string };

export function messageBytes(m: unknown): number {
  try {
    const s = JSON.stringify(m);
    return s === undefined ? 0 : new TextEncoder().encode(s).length;
  } catch {
    return Infinity;
  }
}

/** Decides what to do with one message from the frame's port. Mutates `state.recent` for accepted controls. */
export function handleFrameMessage(raw: unknown, state: BridgeState, now: number): BridgeAction {
  if (messageBytes(raw) > MAX_MESSAGE_BYTES) return { kind: "drop", reason: "message over 256 KB" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { kind: "drop", reason: "not a message" };
  const m = raw as Partial<FrameToHost> & Record<string, unknown>;
  switch (m.t) {
    case "ready":
      return { kind: "ready" };
    case "resize": {
      if (state.height !== "auto") return { kind: "drop", reason: "fixed height" };
      const h = typeof m.height === "number" && Number.isFinite(m.height) ? m.height : NaN;
      if (!(h >= 0)) return { kind: "drop", reason: "bad height" };
      return { kind: "resize", height: Math.min(MAX_AUTO_HEIGHT, Math.max(20, Math.ceil(h))) };
    }
    case "control": {
      if (typeof m.reqId !== "string" || m.reqId.length > 64 || typeof m.controlId !== "string") return { kind: "drop", reason: "bad control request" };
      if (!state.listed.includes(m.controlId)) return { kind: "drop", reason: "control not listed by the block" };
      if (!state.inDocument.includes(m.controlId)) return { kind: "drop", reason: "control not in this document" };
      state.recent = state.recent.filter((t) => now - t < CONTROL_LIMIT.windowMs);
      if (state.recent.length >= CONTROL_LIMIT.count) return { kind: "drop", reason: "more than 10 control requests in 10 seconds" };
      state.recent.push(now);
      return { kind: "control", reqId: m.reqId, controlId: m.controlId, ...(m.input !== undefined ? { input: m.input } : {}) };
    }
    case "navigate": {
      const slug = typeof m.page === "string" ? m.page : "";
      const page = state.pages.find((p) => p.slug === slug);
      return page ? { kind: "navigate", pageId: page.id } : { kind: "drop", reason: "not a page of this app" };
    }
    case "log": {
      const level = m.level === "warn" || m.level === "error" ? m.level : "info";
      return { kind: "log", level, message: typeof m.message === "string" ? m.message.slice(0, 2000) : "" };
    }
    default:
      return { kind: "drop", reason: "unknown message" };
  }
}

/** Refuses a code field over 64 KB, naming the limit (spec 3.5.1). */
export function codeFieldProblem(field: "html" | "css" | "js", value: string): string | null {
  const n = new TextEncoder().encode(value).length;
  return n > MAX_CODE_BYTES ? `The ${field} is ${Math.ceil(n / 1024)} KB; each code field is limited to 64 KB.` : null;
}

/** Refuses images over 2 MB in total, naming the limit. */
export function imagesProblem(sizes: number[]): string | null {
  const total = sizes.reduce((a, b) => a + b, 0);
  return total > MAX_IMAGE_BYTES ? `These images add up to ${(total / 1024 / 1024).toFixed(1)} MB; a block's images are limited to 2 MB in total.` : null;
}

/** The block's log console store (the builder's code window subscribes). */
/** One console line; `stale` marks a line from an earlier run of the block's code (gauntlet w2-r2 Fix 11). */
export type LogLine = { at: number; level: "info" | "warn" | "error"; message: string; stale?: boolean };
const logs = new Map<string, LogLine[]>();
const subs = new Map<string, Set<() => void>>();
export function pushBlockLog(nodeId: string, line: Omit<LogLine, "stale">) {
  logs.set(nodeId, [...(logs.get(nodeId) ?? []), line].slice(-200));
  for (const fn of subs.get(nodeId) ?? []) fn();
}
/**
 * The block's code runs again (a new frame said "ready"): every line so far is from an earlier run and
 * is marked stale, so a syntax error from a half-typed line never reads as the current state. Only the
 * last 20 earlier lines are kept.
 */
export function startBlockRun(nodeId: string) {
  const prev = logs.get(nodeId);
  if (!prev?.length || prev.every((l) => l.stale)) return;
  logs.set(nodeId, prev.map((l) => (l.stale ? l : { ...l, stale: true })).slice(-20));
  for (const fn of subs.get(nodeId) ?? []) fn();
}
const EMPTY: LogLine[] = [];
export function blockLogs(nodeId: string): LogLine[] {
  return logs.get(nodeId) ?? EMPTY;
}
export function clearBlockLogs(nodeId: string) {
  logs.set(nodeId, []);
  for (const fn of subs.get(nodeId) ?? []) fn();
}
export function subscribeBlockLogs(nodeId: string, fn: () => void): () => void {
  const set = subs.get(nodeId) ?? new Set();
  set.add(fn);
  subs.set(nodeId, set);
  return () => set.delete(fn);
}
