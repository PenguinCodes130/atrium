// The builder's side of the shared draft (architecture v3 section 4.9; spec "Editing and saving",
// criteria 9 to 11). Every edit applies optimistically, is queued, and is sent as one batch 300 ms
// after the last edit. A refused batch reverts and reports its problems. A stale revision fetches the
// newer draft and replays the pending edits on it; an edit whose target no longer exists is dropped
// and reported. Undo and redo send the inverse operations. No React and no DOM, so it is unit-tested.
// Wave 2.10c N2 (A11.1): one command log. Each entry carries words ("Move Stat"); typing or scrubbing in one
// field coalesces into one entry until blur or 1 s idle; at most 100 entries; publish keeps the log; an undo
// or redo whose target someone else removed is refused with a sentence and that step is skipped.
import type { AppDocument, DraftOp, Problem } from "@/core/contracts";
import { findNode, findPage } from "@/features/apps/doc";
import { applyOpsToDoc, inverseOps, opTargets } from "@/features/apps/ops";
import { historyLabel } from "./history-label";

export const DEBOUNCE_MS = 300;
export const DROPPED_MESSAGE = "Someone else changed this; your last edit was not applied";
/** A11.1: the most steps kept; the oldest drops. */
export const HISTORY_CAP = 100;
/** A11.1: typing in one field joins one entry until the field loses focus or rests this long. */
export const COALESCE_IDLE_MS = 1000;
/** The sentence for an undo or redo whose target was removed by someone else (A11.1). */
export const skippedMessage = (dir: "undo" | "redo", label: string) =>
  `${dir === "undo" ? "Undo" : "Redo"} of "${label}" was skipped: someone else removed what it changes.`;

export type SendResult =
  | { ok: true; rev: number; /** A10.1: follow-up ops the server added to the same change (managed sources). */ follow?: DraftOp[] }
  | { ok: false; kind: "conflict"; rev: number }
  | { ok: false; kind: "invalid"; problems: Problem[] }
  | { ok: false; kind: "error"; message: string };

export type DraftClientDeps = {
  send(rev: number, ops: DraftOp[]): Promise<SendResult>;
  fetchDraft(): Promise<{ rev: number; doc: AppDocument }>;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  /** A10.1: the managed-source follow-up ops for a document, added to the same edit (so one undo reverts both). */
  normalise?(doc: AppDocument): DraftOp[];
  /** The clock for coalescing typed edits (tests pass a fake one). */
  now?(): number;
};

export type DraftEvents = {
  onChange?(doc: AppDocument, rev: number): void;
  onRefused?(problems: Problem[]): void;
  onDropped?(message: string): void;
  onError?(message: string): void;
  onSaved?(rev: number): void;
};

type Entry = { id: number; ops: DraftOp[]; inverse: DraftOp[]; label: string; /** Coalescing key of a field edit. */ key?: string; at: number };
export type EditOptions = {
  history?: "push" | "none" | "merge";
  into?: number;
  /** The entry's words; derived from the ops when absent. */
  label?: string;
  /** A11.1: an edit typed or scrubbed in one field; the same key within COALESCE_IDLE_MS joins the newest entry. */
  coalesce?: string;
};

export class DraftClient {
  /** The draft as the server has it. */
  private confirmed: AppDocument;
  /** What the person sees: confirmed plus pending and in-flight edits. */
  doc: AppDocument;
  rev: number;
  private pending: DraftOp[] = [];
  private inflight: DraftOp[] | null = null;
  private timer: unknown = null;
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private entrySeq = 0;
  /** Undo entries added since the last confirmed send (dropped if the batch is refused). */
  private unsent = 0;
  /** Callers waiting for the queue to be saved or refused (whenSaved). */
  private waiters: ((problems: Problem[] | null) => void)[] = [];
  /** Which entry an op sent by undo or redo belongs to, so a refused one names its step (A11.1). */
  private origin = new WeakMap<DraftOp, { id: number; dir: "undo" | "redo" }>();
  /** The newest entry stops taking typed edits (a field lost focus). */
  private sealed = false;

  constructor(doc: AppDocument, rev: number, private deps: DraftClientDeps, private events: DraftEvents = {}) {
    this.confirmed = doc;
    this.doc = doc;
    this.rev = rev;
  }

  get busy(): boolean {
    return this.pending.length > 0 || this.inflight !== null;
  }
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** The id of the newest undo entry (0 when there is none), for `edit(..., { history: "merge", into })`. */
  get lastEntryId(): number {
    return this.undoStack.at(-1)?.id ?? 0;
  }
  /** The words of the step Undo would take back ("Move Stat"), or null. */
  get undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null;
  }
  /** The words of the step Redo would put back, or null. */
  get redoLabel(): string | null {
    return this.redoStack.at(-1)?.label ?? null;
  }
  /** How many steps are kept (for tests and the cap). */
  get depth(): number {
    return this.undoStack.length;
  }

  /** Ends the typed edit in progress: the next edit to the same field is a step of its own (blur). */
  seal(): void {
    this.sealed = true;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * Applies an edit locally and queues it. Returns the problems when it cannot apply even locally.
   * `history: "merge"` (Wave 2.10 B1, A11.2) adds the edit to the newest undo entry when that entry is still
   * `into` and nothing was undone since, so a follow-up (a fit component growing its slot after an insert or
   * a prop change) undoes in the same step; otherwise it becomes its own entry.
   */
  edit(asked: DraftOp[], opts: EditOptions = {}): Problem[] | null {
    let ops = asked;
    let r = applyOpsToDoc(this.doc, ops);
    if (!r.ok) return r.problems;
    const follow = this.deps.normalise?.(r.doc) ?? [];
    if (follow.length) {
      const both = applyOpsToDoc(this.doc, [...asked, ...follow]);
      if (both.ok) { ops = [...asked, ...follow]; r = both; }
    }
    const inv = inverseOps(this.doc, ops);
    const label = opts.label ?? historyLabel(this.doc, ops);
    this.doc = r.doc;
    const top = this.undoStack.at(-1);
    const at = this.now();
    const joins = opts.coalesce !== undefined && opts.history !== "none" && opts.history !== "merge" && inv && top && top.key === opts.coalesce && !this.sealed && at - top.at < COALESCE_IDLE_MS && this.redoStack.length === 0;
    if (joins && top && inv) {
      // A11.1: the same field typed again within the idle time is the same step; undo restores the value
      // from before the first keystroke.
      this.undoStack[this.undoStack.length - 1] = { ...top, ops: [...top.ops, ...ops], inverse: [...inv, ...top.inverse], at };
    } else if (opts.history === "merge" && inv && top && top.id === opts.into && this.redoStack.length === 0) {
      // Undo runs the newer inverse first, then the entry's own.
      this.undoStack[this.undoStack.length - 1] = { ...top, ops: [...top.ops, ...ops], inverse: [...inv, ...top.inverse] };
    } else if (opts.history !== "none" && inv) {
      this.undoStack.push({ id: ++this.entrySeq, ops, inverse: inv, label, at, ...(opts.coalesce !== undefined ? { key: opts.coalesce } : {}) });
      if (this.undoStack.length > HISTORY_CAP) this.undoStack.splice(0, this.undoStack.length - HISTORY_CAP);
      this.redoStack = [];
      this.unsent++;
      this.sealed = false;
    }
    this.pending.push(...ops);
    this.schedule();
    this.events.onChange?.(this.doc, this.rev);
    return null;
  }

  /** Takes back the newest step. Returns its words, or null when nothing was undone. */
  undo(): string | null {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.sealed = true;
    const r = applyOpsToDoc(this.doc, e.inverse);
    // A11.1: its target is gone (another editor removed it): refused with a sentence, and the step is skipped.
    if (!r.ok) { this.events.onDropped?.(skippedMessage("undo", e.label)); this.events.onChange?.(this.doc, this.rev); return null; }
    this.doc = r.doc;
    this.redoStack.push(e);
    for (const op of e.inverse) this.origin.set(op, { id: e.id, dir: "undo" });
    this.pending.push(...e.inverse);
    this.schedule();
    this.events.onChange?.(this.doc, this.rev);
    return e.label;
  }

  /** Puts back the newest undone step. Returns its words, or null when nothing was redone. */
  redo(): string | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.sealed = true;
    const r = applyOpsToDoc(this.doc, e.ops);
    if (!r.ok) { this.events.onDropped?.(skippedMessage("redo", e.label)); this.events.onChange?.(this.doc, this.rev); return null; }
    this.doc = r.doc;
    this.undoStack.push(e);
    for (const op of e.ops) this.origin.set(op, { id: e.id, dir: "redo" });
    this.pending.push(...e.ops);
    this.schedule();
    this.events.onChange?.(this.doc, this.rev);
    return e.label;
  }

  /**
   * Undo of one named step (the delete toast's Undo): only when it is still the newest, so the button never
   * takes back a later edit. Returns false (and nothing changes) otherwise.
   */
  undoEntry(id: number): boolean {
    if (!id || this.undoStack.at(-1)?.id !== id) return false;
    return this.undo() !== null;
  }

  /**
   * Ops dropped on the server because their target is gone: the undo or redo steps they came from are
   * refused with a sentence each and leave the log (A11.1). True when any dropped op was not from one.
   */
  private dropped(ops: DraftOp[]): boolean {
    let plain = false;
    const seen = new Set<number>();
    for (const op of ops) {
      const o = this.origin.get(op);
      if (!o) { plain = true; continue; }
      if (seen.has(o.id)) continue;
      seen.add(o.id);
      const stack = o.dir === "undo" ? this.redoStack : this.undoStack;
      const i = stack.findIndex((e) => e.id === o.id);
      const label = i >= 0 ? stack[i]!.label : "that step";
      if (i >= 0) stack.splice(i, 1);
      this.events.onDropped?.(skippedMessage(o.dir, label));
    }
    return plain;
  }

  /**
   * Resolves once everything queued so far is saved (null) or a batch is refused (its problems). Forms
   * that must stay open until their change is accepted await it (gauntlet w2-r1 item 15).
   */
  whenSaved(): Promise<Problem[] | null> {
    if (!this.busy) return Promise.resolve(null);
    const p = new Promise<Problem[] | null>((resolve) => this.waiters.push(resolve));
    void this.flush();
    return p;
  }

  private settle(problems: Problem[] | null): void {
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn(problems);
  }

  private schedule(): void {
    if (this.timer) this.deps.clearTimeout(this.timer);
    this.timer = this.deps.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, DEBOUNCE_MS);
  }

  /** Sends the pending edits as one batch now (the debounce calls it). */
  async flush(): Promise<void> {
    if (this.inflight || this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.inflight = batch;
    const entries = this.unsent;
    this.unsent = 0;
    let ops = batch;
    let outcome: Problem[] | null = null;
    for (let attempt = 0; attempt < 4 && ops.length; attempt++) {
      const res = await this.deps.send(this.rev, ops);
      if (res.ok) {
        const withFollow = res.follow?.length ? applyOpsToDoc(this.confirmed, [...ops, ...res.follow]) : null;
        const applied = withFollow?.ok ? withFollow : applyOpsToDoc(this.confirmed, ops);
        if (applied.ok) this.confirmed = applied.doc;
        this.rev = res.rev;
        break;
      }
      if (res.kind === "conflict") {
        const latest = await this.deps.fetchDraft();
        this.confirmed = latest.doc;
        this.rev = latest.rev;
        const kept = ops.filter((op) => opTargets(op).every((id) => (id.startsWith("p_") ? !!findPage(latest.doc, id) : !!findNode(latest.doc, id))));
        if (kept.length < ops.length && this.dropped(ops.filter((op) => !kept.includes(op)))) this.events.onDropped?.(DROPPED_MESSAGE);
        ops = kept;
        continue;
      }
      if (res.kind === "invalid") {
        // A target that vanished between the conflict check and the send: drop those edits and retry the rest.
        const missing = new Set(res.problems.filter((p) => p.code === "node.missing" || p.code === "page.missing" || p.code === "parent.missing").map((p) => p.where.nodeId ?? p.where.pageId ?? ""));
        if (missing.size && attempt < 3) {
          const kept = ops.filter((op) => !opTargets(op).some((id) => missing.has(id)));
          if (kept.length < ops.length) {
            if (this.dropped(ops.filter((op) => !kept.includes(op)))) this.events.onDropped?.(DROPPED_MESSAGE);
            ops = kept;
            continue;
          }
        }
        this.undoStack.splice(Math.max(0, this.undoStack.length - entries), entries);
        this.events.onRefused?.(res.problems);
        outcome = res.problems;
        ops = [];
        break;
      }
      this.events.onError?.(res.message);
      outcome = [{ severity: "error", code: "network", where: {}, message: res.message }];
      // Network or server error: put the edits back so they go with the next batch.
      this.pending = [...ops, ...this.pending];
      ops = [];
      break;
    }
    this.inflight = null;
    // Rebuild what the person sees: confirmed plus whatever is still queued.
    const rebuilt = this.pending.length ? applyOpsToDoc(this.confirmed, this.pending) : { ok: true as const, doc: this.confirmed, changed: [] };
    if (rebuilt.ok) this.doc = rebuilt.doc;
    else {
      this.pending = [];
      this.doc = this.confirmed;
    }
    this.events.onChange?.(this.doc, this.rev);
    this.events.onSaved?.(this.rev);
    if (outcome) this.settle(outcome);
    else if (!this.pending.length) this.settle(null);
    if (this.pending.length) this.schedule();
  }

  /**
   * Replace the draft wholesale (after a publish, restore or discard). A11.1: a publish keeps the history
   * (`keepHistory`); a restore or discard clears it.
   */
  reset(doc: AppDocument, rev: number, opts: { keepHistory?: boolean } = {}): void {
    this.confirmed = doc;
    this.doc = doc;
    this.rev = rev;
    this.pending = [];
    if (!opts.keepHistory) {
      this.undoStack = [];
      this.redoStack = [];
    }
    this.sealed = true;
    this.events.onChange?.(this.doc, this.rev);
  }
}
