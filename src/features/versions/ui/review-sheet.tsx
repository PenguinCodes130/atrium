"use client";
// The publish review (design v4 "Publish review"; spec "Publish" and "Versions", criteria 21, 22, 26, 28):
// the diff, the change authors (agents named), "This version lets people", validation errors (blocking)
// and warnings, a note, and Publish. Restore uses the same sheet against the live version.
import { useCallback, useEffect, useState } from "react";
import { Button, Sheet } from "@/features/shell";
import type { Review } from "../service";
import { DiffLines } from "./diff-lines";
import type { DraftOp, Problem } from "@/core/contracts";

/** The source an "unused source" warning names (apps/review-warnings.ts puts it in where.field). */
const unusedSourceName = (p: Problem) => (p.code === "source.unused" && p.where.field?.startsWith("dataSources.") ? p.where.field.slice("dataSources.".length) : null);

type Props = {
  appId: string;
  open: boolean;
  onClose(): void;
  restore?: number;
  onDone(result: { version: number; rev?: number }): void;
  /** In the builder: a problem that names a component selects it (gauntlet w2-r1 item 2). */
  onSelectProblem?(where: { pageId?: string; nodeId: string }): void;
  /** In the builder: applies a one-click fix through the builder's draft (Wave 2.7 spec 3.6); without it the fix is sent to the draft directly. */
  applyOps?(ops: DraftOp[]): Promise<Problem[] | null>;
};

export function ReviewSheet({ appId, open, onClose, restore, onDone, onSelectProblem, applyOps }: Props) {
  const [review, setReview] = useState<Review | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (keepError = false) => {
    if (!keepError) setError(null);
    const res = await fetch(`/api/apps/${appId}/review${restore ? `?restore=${restore}` : ""}`, { credentials: "same-origin" }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as (Review & { error?: { message?: string } }) | null;
    if (!res?.ok || !body) return setError(body?.error?.message ?? "The review could not be loaded.");
    setReview(body);
  }, [appId, restore]);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function go() {
    if (!review) return;
    setBusy(true);
    setError(null);
    const url = restore ? `/api/apps/${appId}/restore` : `/api/apps/${appId}/publish`;
    const res = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectRev: review.rev, note, ...(restore ? { version: restore } : {}) }) }).catch(() => null);
    const body = (await res?.json().catch(() => ({}))) as { version?: number; rev?: number; error?: { message?: string; problems?: { message: string }[] } };
    setBusy(false);
    if (res?.ok && body.version) return onDone({ version: body.version, ...(body.rev ? { rev: body.rev } : {}) });
    setError(body.error?.message ?? "That did not work.");
    if (res?.status === 409) void load(true);
  }

  /** "Remove" on an unused source (criterion 19): one op through the builder's draft, then read the review again. */
  async function removeSource(name: string) {
    setBusy(true);
    const ops: DraftOp[] = [{ op: "source.remove", name }];
    let failed: string | null = null;
    if (applyOps) {
      const problems = await applyOps(ops);
      if (problems && problems.length) failed = problems[0]!.message;
    } else if (review) {
      const res = await fetch(`/api/apps/${appId}/ops`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ rev: review.rev, ops }) }).catch(() => null);
      if (!res?.ok) failed = "That source could not be removed. Try again.";
    }
    setBusy(false);
    if (failed) setError(failed);
    await load(!!failed);
  }

  const errors = review?.problems.filter((p) => p.severity === "error") ?? [];
  const warnings = review?.problems.filter((p) => p.severity !== "error") ?? [];
  const title = restore ? `Restore v${restore}` : "Publish";
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()} title={title} path={restore ? `versions / restore v${restore}` : "builder / publish"} name="publish-review" width={560}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={go} disabled={busy || !review || !review.canPublish} data-publish-confirm>{restore ? `Restore v${restore}` : "Publish"}</Button>
        </div>
      }>
      {!review ? (
        <p className="type-body text-fg-2">{error ?? "Reading the draft..."}</p>
      ) : (
        <div className="flex flex-col gap-6" data-review>
          <p className="font-mono text-[12px] text-fg-2" data-review-meta>
            {restore ? `v${restore} against the live version v${review.against}` : review.against ? `draft · rev ${review.rev} against v${review.against}` : `draft · rev ${review.rev} · first publish`}
          </p>
          {restore && review.discardsDraftChanges && <p className="border-l-4 border-l-warn bg-bg-sunk p-2 type-body" data-review-discard>Restoring discards the draft's unpublished changes.</p>}
          <section className="flex flex-col gap-2">
            <h3 className="type-title-3">What changes</h3>
            <DiffLines groups={review.groups} empty="Nothing changes against the live version." />
          </section>
          {review.authors.length > 0 && (
            <section className="flex flex-col gap-2" data-review-authors>
              <h3 className="type-title-3">Who changed it</h3>
              <ul className="flex flex-col gap-1">
                {review.authors.map((a) => (
                  <li key={`${a.kind}:${a.name}`} className="type-body" data-review-author={a.kind}>
                    {a.name} {a.kind === "agent" && <span className="ml-1 bg-fg px-1 font-mono text-[11px] text-bg">agent</span>} <span className="text-fg-2">· {a.count} {a.count === 1 ? "change" : "changes"}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="flex flex-col gap-2" data-review-controls>
            <h3 className="type-title-3">This version lets people</h3>
            {review.controls.length === 0 ? (
              <p className="type-body text-fg-2">Use no new or changed controls.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {review.controls.map((c) => (
                  <li key={c.controlId} className="flex flex-col bg-bg-sunk px-2 py-1" data-review-control={c.label}>
                    <span className="type-body">{c.change === "added" ? "Use" : "Use the changed"} {c.label} <span className="text-fg-2">({c.integration})</span></span>
                    <span className="font-mono text-[12px] text-fg-2">{c.command}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {(errors.length > 0 || warnings.length > 0) && (
            <section className="flex flex-col gap-2" data-review-problems>
              <h3 className="type-title-3">{errors.length ? `${errors.length} ${errors.length === 1 ? "problem blocks" : "problems block"} publishing` : "Warnings"}</h3>
              <ul className="flex flex-col gap-1">
                {[...errors, ...warnings].map((p, i) => {
                  const nodeId = p.where.nodeId;
                  const unused = restore ? null : unusedSourceName(p);
                  if (unused) {
                    return (
                      <li key={i} className="flex items-start gap-2 border-l-4 border-l-warn bg-bg-sunk px-2 py-1 type-body" data-review-problem={p.severity} data-review-unused={unused}>
                        <span className="min-w-0 flex-1"><span className="mr-2 font-mono text-[11px] text-fg-2">{p.severity}</span>{p.message}</span>
                        <Button variant="secondary" disabled={busy} onClick={() => void removeSource(unused)} data-review-remove-source={unused}>Remove</Button>
                      </li>
                    );
                  }
                  const body = (
                    <>
                      <span className="mr-2 font-mono text-[11px] text-fg-2">{p.severity}</span>
                      {p.message}
                      {p.fix && <span className="block type-caption text-fg-2">{p.fix}</span>}
                      {nodeId && onSelectProblem && <span className="mt-0.5 block type-caption underline">Show the component</span>}
                    </>
                  );
                  const tone = `border-l-4 bg-bg-sunk px-2 py-1 type-body ${p.severity === "error" ? "border-l-bad" : "border-l-warn"}`;
                  return (
                    <li key={i} className={nodeId && onSelectProblem ? "" : tone} data-review-problem={p.severity}>
                      {nodeId && onSelectProblem ? (
                        <button type="button" className={`${tone} block min-h-11 w-full text-left hover:bg-bg focus-visible:outline-2 focus-visible:outline-accent-ink`} onClick={() => onSelectProblem({ nodeId, ...(p.where.pageId ? { pageId: p.where.pageId } : {}) })} data-review-problem-select={nodeId}>
                          {body}
                        </button>
                      ) : body}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="type-label">Note</span>
            <textarea className="min-h-20 border border-line-strong bg-bg-hi p-2 type-body text-fg outline-none focus-visible:outline-2 focus-visible:outline-accent-ink" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What this version changes" data-review-note />
          </label>
          {error && <p role="alert" className="type-body text-bad" data-review-error>{error}</p>}
        </div>
      )}
    </Sheet>
  );
}
