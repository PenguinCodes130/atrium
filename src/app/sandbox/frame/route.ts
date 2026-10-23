// The HTML block frame document (architecture v3 sections 4.7 and 13). Static and identical for every
// block: it holds no Atrium data, so it answers without a session (the proxy lists /sandbox as public,
// and the sandboxed frame's own requests carry no cookies anyway). Its headers do the work: an opaque
// origin (CSP sandbox), no network, no frames, no forms, no base changes, no WebRTC, DNS prefetch off,
// and framing only by this Atrium's public URL or its LAN origins.
import { env } from "@/core/env";
import { allowedFrameOrigin, frameDocument, frameHeaders } from "@/features/components/sandbox/frame-doc";

export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
  const publicOrigin = new URL(env().ATRIUM_PUBLIC_URL).origin;
  const requestOrigin = new URL(req.url).origin;
  // A request on a host that is neither the public URL nor a LAN origin can only be framed by the public URL.
  const origin = allowedFrameOrigin(requestOrigin, publicOrigin, env().ATRIUM_LAN_ORIGINS) ?? publicOrigin;
  return new Response(frameDocument(), { status: 200, headers: frameHeaders(origin) });
}
