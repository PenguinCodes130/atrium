// The builder's side of the shared draft (architecture v3 section 4.9; spec "Editing and saving",
// criteria 9 to 11). Every edit applies optimistically, is queued, and is sent as one batch 300 ms
// after the last edit. A refused batch reverts and reports its problems. A stale revision fetches the
// newer draft and replays the pending edits on it; an edit whose target no longer exists is dropped
// and reported. Undo and redo send the inverse operations. No React and no DOM, so it is unit-tested.
import type { AppDocument, DraftOp, Problem } from "@/core/contracts";
import { findNode, findPage } from "@/features/apps/doc";
import { applyOpsToDoc, inverseOps, opTargets } from "@/features/apps/ops";

export const DEBOUNCE_MS = 300;
export const DROPPED_MESSAGE = "Someone else changed this; your last edit was not applied";

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
};

export type DraftEvents = {
  onChange?(doc: AppDocument, rev: number): void;
  onRefused?(problems: Problem[]): void;
  onDropped?(message: string): void;
  onError?(message: string): void;
  onSaved?(rev: number): void;
};

type Entry = { id: number; ops: DraftOp[]; inverse: DraftOp[] };

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

  /**
   * Applies an edit locally and queues it. Returns the problems when it cannot apply even locally.
   * `history: "merge"` (Wave 2.10 B1, A11.2) adds the edit to the newest undo entry when that entry is still
   * `into` and nothing was undone since, so a follow-up (a fit component growing its slot after an insert or
   * a prop change) undoes in the same step; otherwise it becomes its own entry.
   */
  edit(asked: DraftOp[], opts: { history?: "push" | "none" | "merge"; into?: number } = {}): Problem[] | null {
    let ops = asked;
    let r = applyOpsToDoc(this.doc, ops);
    if (!r.ok) return r.problems;
    const follow = this.deps.normalise?.(r.doc) ?? [];
    if (follow.length) {
      const both = applyOpsToDoc(this.doc, [...asked, ...follow]);
      if (both.ok) { ops = [...asked, ...follow]; r = both; }
    }
    const inv = inverseOps(this.doc, ops);
    this.doc = r.doc;
    const top = this.undoStack.at(-1);
    if (opts.history === "merge" && inv && top && top.id === opts.into && this.redoStack.length === 0) {
      // Undo runs the newer inverse first, then the entry's own.
      this.undoStack[this.undoStack.length - 1] = { id: top.id, ops: [...top.ops, ...ops], inverse: [...inv, ...top.inverse] };
    } else if (opts.history !== "none" && inv) {
      this.undoStack.push({ id: ++this.entrySeq, ops, inverse: inv });
      this.redoStack = [];
      this.unsent++;
    }
    this.pending.push(...ops);
    this.schedule();
    this.events.onChange?.(this.doc, this.rev);
    return null;
  }

  undo(): void {
    const e = this.undoStack.pop();
    if (!e) return;
    const r = applyOpsToDoc(this.doc, e.inverse);
    if (!r.ok) return this.events.onDropped?.(DROPPED_MESSAGE);
    this.doc = r.doc;
    this.redoStack.push(e);
    this.pending.push(...e.inverse);
    this.schedule();
    this.events.onChange?.(this.doc, this.rev);
  }

  redo(): void {
    const e = this.redoStack.pop();
    if (!e) return;
    const r = applyOpsToDoc(this.doc, e.ops);
    if (!r.ok) return this.events.onDropped?.(DROPPED_MESSAGE);
    this.doc = r.doc;
    this.undoStack.push(e);
    this.pending.push(...e.ops);
    this.schedule();
    this.events.onChange?.(this.doc, this.rev);
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
        if (kept.length < ops.length) this.events.onDropped?.(DROPPED_MESSAGE);
        ops = kept;
        continue;
      }
      if (res.kind === "invalid") {
        // A target that vanished between the conflict check and the send: drop those edits and retry the rest.
        const missing = new Set(res.problems.filter((p) => p.code === "node.missing" || p.code === "page.missing" || p.code === "parent.missing").map((p) => p.where.nodeId ?? p.where.pageId ?? ""));
        if (missing.size && attempt < 3) {
          const kept = ops.filter((op) => !opTargets(op).some((id) => missing.has(id)));
          if (kept.length < ops.length) {
            this.events.onDropped?.(DROPPED_MESSAGE);
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

  /** Replace the draft wholesale (after a publish, restore or discard). */
  reset(doc: AppDocument, rev: number): void {
    this.confirmed = doc;
    this.doc = doc;
    this.rev = rev;
    this.pending = [];
    this.undoStack = [];
    this.redoStack = [];
    this.events.onChange?.(this.doc, this.rev);
  }
}
