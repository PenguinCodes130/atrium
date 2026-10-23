// Route handler helpers for app-builder's API: one error shape (with problems, field or current rev).
import "server-only";
import { AtriumError } from "@/core/errors";
import { appErrorBody } from "./errors";
import { logger } from "@/core/log";

const log = logger("apps.api");

export async function handle(fn: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof AtriumError)) log.error("app-builder route failed", { err: String(err) });
    const { status, body, headers } = appErrorBody(err);
    return Response.json(body, { status, ...(headers ? { headers } : {}) });
  }
}

export async function jsonBody(req: Request, maxBytes = 2 * 1024 * 1024): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > maxBytes) throw new AtriumError("That request is too large.", 413, "too_large");
  if (!text) return {};
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new AtriumError("That request is not valid JSON.", 400, "bad_request");
  }
}
