// Resolving one app page for the data stream and the polling fallback (architecture v3 section 10,
// amendments A1.1 and A1.2). Shared by GET /api/data/stream and GET /api/data/widget/<app>:<name>.
import "server-only";
import type { Principal, ShapedData } from "@/core/contracts";
import { AtriumError, RateLimited } from "@/core/errors";
import { appAccess } from "@/core/hooks";
import { bindingAllowedInApp, NOT_SHARED_MESSAGE } from "@/features/integrations/commands";
import { getIntegrationRow, ownerIds } from "@/features/integrations/repo";
import { dataSources, streamSourceOf, type StreamSource } from "./stream";

export const NOT_AVAILABLE_MESSAGE = "App pages arrive with apps. This Atrium has no apps yet.";
export const GUEST_REQUESTS_PER_MINUTE = 120;

export type ResolvedPage = {
  sources: StreamSource[];
  blocked: Map<string, string>;
  /** Present for guests: the only thing a guest is ever sent. */
  guest?: (sources: Record<string, ShapedData>) => Promise<Record<string, unknown>>;
};

const g = globalThis as unknown as { __atriumGuestHits?: Map<string, number[]> };
const hits: Map<string, number[]> = (g.__atriumGuestHits ??= new Map<string, number[]>());

/** 120 stream and poll requests per minute per guest session (spec v2 section 3.5). */
export function guestHit(p: Principal, now = Date.now()): { ok: true } | { ok: false; retryAfterSec: number } {
  if (p.kind !== "guest") return { ok: true };
  const list = (hits.get(p.guestLinkId) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= GUEST_REQUESTS_PER_MINUTE) {
    hits.set(p.guestLinkId, list);
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((60_000 - (now - list[0]!)) / 1000)) };
  }
  list.push(now);
  hits.set(p.guestLinkId, list);
  return { ok: true };
}

/** For tests. */
export function resetGuestHits(): void {
  hits.clear();
}

export async function resolvePage(p: Principal, appId: string, pageId: string, draftAsked: boolean): Promise<ResolvedPage> {
  if (p.kind === "agent" || p.kind === "builtin-agent") throw new AtriumError("Agents read data through data.read, not the page stream.", 403, "forbidden");
  const resolver = dataSources();
  if (!resolver) throw new AtriumError(NOT_AVAILABLE_MESSAGE, 403, "not_available");
  const limit = guestHit(p);
  if (!limit.ok) throw new RateLimited(limit.retryAfterSec);
  if (p.kind === "guest" && p.appId !== appId) throw new AtriumError("You cannot open this app.", 403, "forbidden");
  const hook = appAccess();
  // The draft flag is honoured only for people who can edit the app; never for guests.
  const draft = draftAsked && p.kind === "user" && !!hook && (await hook.canEditApp(p, appId));
  const defs = await resolver.page(appId, pageId, p, draft);
  if (!defs) throw new AtriumError("You cannot open this page.", 403, "forbidden");
  const sources = defs.map(streamSourceOf);
  const blocked = new Map<string, string>();
  const app = hook ? await hook.appById(appId) : null;
  if (app) {
    const owners = ownerIds();
    for (const s of sources) {
      const row = getIntegrationRow(s.integrationId);
      if (row && !bindingAllowedInApp(app, row, owners)) blocked.set(s.key, NOT_SHARED_MESSAGE);
    }
  }
  if (p.kind === "guest") {
    // Without app-builder's guest binding resolver a guest gets nothing, never whole sources.
    const guest = hook ? (data: Record<string, ShapedData>) => hook.guestValues(appId, pageId, data) : async () => ({});
    return { sources, blocked, guest };
  }
  return { sources, blocked };
}
