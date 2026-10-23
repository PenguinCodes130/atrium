// app-builder errors. Messages are plain English and safe to show.
import type { Problem } from "@/core/contracts";
import { AtriumError } from "@/core/errors";

/** A stale expected revision: the draft moved on. Carries the current revision (architecture 9b). */
export class DraftConflict extends AtriumError {
  constructor(readonly currentRev: number, message = "Someone else changed this draft first.") {
    super(message, 409, "conflict");
  }
}

/** A batch, create or publish refused by validation. Carries the problem list. */
export class Invalid extends AtriumError {
  constructor(readonly problems: Problem[], message?: string) {
    super(message ?? problems[0]?.message ?? "That change is not valid.", 422, "invalid");
  }
}

/** A field problem on a form (for example the slug field on "New app"). */
export class FieldError extends AtriumError {
  constructor(readonly field: string, message: string, status = 400) {
    super(message, status, "invalid_field");
  }
}

/** JSON body for app-builder API errors: the base error plus problems, field or current revision. */
export function appErrorBody(err: unknown): { status: number; body: Record<string, unknown>; headers?: Record<string, string> } {
  if (err instanceof DraftConflict) return { status: 409, body: { error: { code: "conflict", message: err.message, rev: err.currentRev } } };
  if (err instanceof Invalid) return { status: 422, body: { error: { code: "invalid", message: err.message, problems: err.problems } } };
  if (err instanceof FieldError) return { status: err.status, body: { error: { code: "invalid_field", field: err.field, message: err.message } } };
  if (err instanceof AtriumError) {
    const headers: Record<string, string> = {};
    const retry = (err as { retryAfterSec?: number }).retryAfterSec;
    if (retry) headers["Retry-After"] = String(retry);
    return { status: err.status, body: { error: { code: err.code, message: err.message } }, headers };
  }
  return { status: 500, body: { error: { code: "internal", message: "Something went wrong." } } };
}
