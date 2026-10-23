// Who is asking to run a control (architecture v3 sections 6.2, 9b.1 and 13). A control run is a
// cookie request from a person's browser: a session user, or a guest for their own app. Bearer
// tokens (MCP and personal access tokens), render sessions and requests from another origin are
// refused before anything else happens.
import "server-only";
import type { Principal } from "@/core/contracts";
import { env } from "@/core/env";
import { Unauthorized } from "@/core/errors";
import * as auth from "@/features/auth";

export type GateRefusal = { reason: "bearer" | "render" | "origin"; message: string };

/** Cookie names only; values are never read here. */
function cookieNames(h: Headers): string[] {
  return (h.get("cookie") ?? "").split(";").map((c) => c.split("=")[0]!.trim()).filter(Boolean);
}

/** True for a preview render session: the render ticket's cookie, or a render-mode page asking. */
export function isRenderRequest(req: Request): boolean {
  if (cookieNames(req.headers).some((n) => /render/i.test(n))) return true;
  if (req.headers.has("x-atrium-render")) return true;
  const url = new URL(req.url);
  if (url.searchParams.has("render")) return true;
  const ref = req.headers.get("referer");
  if (ref) {
    try { if (new URL(ref).searchParams.has("render")) return true; } catch { /* not a URL */ }
  }
  return false;
}

function originOk(req: Request): boolean {
  const publicOrigin = new URL(env().ATRIUM_PUBLIC_URL).origin;
  const origin = req.headers.get("origin");
  if (origin) return origin === publicOrigin;
  const ref = req.headers.get("referer");
  if (!ref) return false;
  try { return new URL(ref).origin === publicOrigin; } catch { return false; }
}

export function gate(req: Request): GateRefusal | null {
  // Any Authorization header at all: a control run never carries a token (agents never run controls).
  if (req.headers.has("authorization")) return { reason: "bearer", message: "Agents, access tokens and previews can never run a control." };
  if (isRenderRequest(req)) return { reason: "render", message: "Agents, access tokens and previews can never run a control." };
  if (!originOk(req)) return { reason: "origin", message: "This request did not come from this Atrium." };
  return null;
}

/** The session user or guest behind this request (auth's requireViewer), or null when signed out. */
export async function viewerOf(req: Request): Promise<Principal | null> {
  try {
    return await auth.requireViewer(req);
  } catch (e) {
    if (e instanceof Unauthorized) return null;
    throw e;
  }
}

/** For the audit entry of a refused bearer request: the agent behind the token, if it resolves. */
export async function bearerPrincipal(req: Request): Promise<Principal | null> {
  try {
    return await auth.getPrincipal(req);
  } catch {
    return null;
  }
}
