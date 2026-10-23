// Handlers for GET /api/data/stream and GET /api/data/widget/<appId>:<sourceName> (architecture v3
// section 10), kept here so they can be tested without Next. Both accept session users and guests
// (through the viewer check) and answer not_available until app-builder registers the resolver.
import "server-only";
import { z } from "zod";
import { AtriumError, errorResponse, NotFound } from "@/core/errors";
import { viewerOf } from "@/features/controls/request";
import { resolvePage } from "./page";
import { dataRuntime, readThrough } from "./runtime";
import { imageSignersFor } from "@/features/uploads/data-sign";
import { signedUrlsFor, signedUrlsForValues } from "./signed-urls";
import { createPageStream } from "./stream";
import type { SourceData } from "./types";

const streamQuery = z.object({ app: z.string().min(1).max(100), page: z.string().min(1).max(100), draft: z.enum(["1"]).optional() });

export async function handleStream(req: Request): Promise<Response> {
  try {
    const p = await viewerOf(req);
    if (!p) throw new AtriumError("Sign in to continue.", 401, "unauthorized");
    const q = streamQuery.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!q.success) throw new AtriumError("Name an app and a page.", 400, "bad_request");
    const page = await resolvePage(p, q.data.app, q.data.page, q.data.draft === "1");
    const { scheduler, cache } = dataRuntime();
    return new Response(createPageStream(page.sources, { scheduler, cache }, req.signal, { blocked: page.blocked, signFor: imageSignersFor(p, q.data.app, page.sources), ...(page.guest ? { guest: page.guest } : {}) }), {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", connection: "keep-alive", "x-accel-buffering": "no" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

const pollQuery = z.object({ page: z.string().min(1).max(100), draft: z.enum(["1"]).optional() });

/** The polling fallback: one data source's value by app id and source name. Guests get resolved values only. */
export async function handlePoll(req: Request, id: string): Promise<Response> {
  try {
    const p = await viewerOf(req);
    if (!p) throw new AtriumError("Sign in to continue.", 401, "unauthorized");
    const i = id.indexOf(":");
    if (i <= 0 || i === id.length - 1) throw new AtriumError("Address one value as <appId>:<sourceName>.", 400, "bad_request");
    const appId = id.slice(0, i);
    const name = id.slice(i + 1);
    const q = pollQuery.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!q.success) throw new AtriumError("Name the page the value is on.", 400, "bad_request");
    const page = await resolvePage(p, appId, q.data.page, q.data.draft === "1");
    const src = page.sources.find((s) => s.key === name);
    if (!src) throw new NotFound("That data source is not on this page.");
    const blocked = page.blocked.get(name);
    const data: SourceData = blocked ? { state: "failed", refreshSec: src.refreshSec, error: { code: "permission", message: blocked } } : await readThrough(src, src.refreshSec);
    // Settings r2 (gauntlet w2-r1 items 3 and 4): signed for this app and caller, public or own host only.
    const sign = imageSignersFor(p, appId, page.sources)(name) ?? (() => null);
    if (page.guest) {
      const values = data.data ? await page.guest({ [name]: data.data }) : {};
      const signedUrls = signedUrlsForValues(values, data.data, sign);
      return Response.json({ values, ...(Object.keys(signedUrls).length ? { signedUrls } : {}) }, { headers: { "cache-control": "no-store" } });
    }
    const signedUrls = signedUrlsFor(data.data, sign);
    return Response.json({ key: name, ...data, ...(Object.keys(signedUrls).length ? { signedUrls } : {}) }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
