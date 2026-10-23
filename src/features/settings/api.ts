// Route helpers for settings: every handler signs the caller in through auth (sessions only: a guest
// cookie or a bearer token is signed out everywhere in settings, spec 4 "Permission denied"), parses
// input with Zod, and sends output through a Zod schema that strips unknown fields (architecture 11).
import "server-only";
import { z, type ZodType } from "zod";
import type { Role } from "@/core/contracts";
import { AtriumError, errorResponse } from "@/core/errors";
import { logger } from "@/core/log";
import { requireUser, type AtriumSession } from "@/features/auth";

export async function handle(req: Request, minRole: Role | undefined, fn: (s: AtriumSession) => Promise<Response> | Response): Promise<Response> {
  try {
    const s = await requireUser(req, minRole);
    return await fn(s);
  } catch (err) {
    if (err instanceof z.ZodError) return Response.json({ error: { code: "bad_request", message: err.issues[0]?.message ?? "That request is not valid." } }, { status: 400 });
    const issues = (err as { issues?: unknown }).issues;
    if (err instanceof AtriumError && Array.isArray(issues)) return Response.json({ error: { code: err.code, message: err.message }, issues }, { status: err.status, headers: NO_STORE });
    const extra = err instanceof AtriumError ? extraFields(err) : null;
    if (extra) return Response.json({ error: { code: (err as AtriumError).code, message: (err as AtriumError).message }, ...extra }, { status: (err as AtriumError).status, headers: NO_STORE });
    if (!(err instanceof AtriumError)) console.error("[settings] route error", err instanceof Error ? err.message : "unknown");
    return errorResponse(err);
  }
}

/** Errors that carry structured detail the screen needs (current rev, apps in use). */
function extraFields(err: AtriumError): Record<string, unknown> | null {
  const e = err as unknown as { rev?: number; apps?: unknown };
  if (typeof e.rev === "number") return { rev: e.rev };
  if (Array.isArray(e.apps)) return { apps: e.apps };
  return null;
}

export const NO_STORE = { "cache-control": "no-store" };

export async function body<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new AtriumError("The request body must be JSON.");
  }
  return schema.parse(raw);
}

export function send<T>(schema: ZodType<T>, value: unknown, init: ResponseInit = {}): Response {
  return Response.json(schema.parse(value), { ...init, headers: { ...NO_STORE, ...(init.headers ?? {}) } });
}

/** Read one uploaded file from a multipart form, with a size cap checked before reading it all. */
export async function formFile(req: Request, maxBytes: number): Promise<{ file: File; form: FormData }> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > maxBytes + 64 * 1024) throw new AtriumError(`The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`, 413, "too_large");
  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    // The parse error says why (a cut-off body, a missing boundary); the person gets the plain sentence.
    logger("uploads").warn("form_unreadable", { contentType: req.headers.get("content-type")?.split(";")[0] ?? null, contentLength: len, error: err instanceof Error ? err.message : String(err) });
    throw new AtriumError("Send the file as a form upload.");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw new AtriumError("Choose a file to upload.");
  if (file.size > maxBytes) throw new AtriumError(`The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`, 413, "too_large");
  return { file, form };
}
