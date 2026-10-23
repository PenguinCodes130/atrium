// Invite and reset entry (architecture v3 Amendment 3, auth-spec-v3). Owned by auth.
//   GET  /invite/<token>   live link, signed out: 303 to /invite/<token>/set
//                          signed in (any token): 303 to /invite/signed-in, nothing consumed
//                          anything else: the same 303 to /invite/expired with an empty body
//   POST /invite/<token>   {password, confirm} from the set page; JSON reply, the session cookie on an invite
// The proxy limits /invite/* to 30 requests per minute per IP and refuses bearer tokens; this handler
// refuses them too. The token is never logged.
import { env } from "@/core/env";
import { inspectAccountLink, redeemAccountLink } from "@/features/auth/account-links/service";
import { clientAddress } from "@/features/auth/server/rate-limit";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string }> };

const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const hasBearer = (req: Request) => /^Bearer\s/i.test(req.headers.get("authorization") ?? "");
const agentsRefused = () => Response.json({ error: { code: "agents_refused", message: "Agents cannot use invite and reset links." } }, { status: 403, headers: NO_STORE });

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, ...NO_STORE } });
}

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  if (hasBearer(req)) return agentsRefused();
  const { token } = await ctx.params;
  const r = await inspectAccountLink(token, req.headers);
  if (r.kind === "signed_in") return seeOther("/invite/signed-in");
  if (r.kind === "dead") return seeOther("/invite/expired");
  return seeOther(`/invite/${encodeURIComponent(token)}/set`);
}

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  if (hasBearer(req)) return agentsRefused();
  const { token } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { password?: unknown; confirm?: unknown } | null;
  if (!body || typeof body !== "object") return Response.json({ state: "bad_request" }, { status: 400, headers: NO_STORE });
  const ip = clientAddress(req.headers, env().ATRIUM_TRUSTED_PROXIES) ?? undefined;
  const r = await redeemAccountLink(token, req.headers, { password: body.password, confirm: body.confirm }, { ip });
  const json = (status: number, b: unknown) => Response.json(b, { status, headers: NO_STORE });
  switch (r.kind) {
    case "signed_in":
      return json(409, { state: "signed_in" });
    case "dead":
      return json(404, { state: "expired" });
    case "invalid":
      return json(400, { state: "invalid", field: r.problem.field, message: r.problem.message });
    case "reset_done":
      return json(200, { state: "reset_done" });
    case "invite_done": {
      const res = json(200, { state: "invite_done" });
      for (const c of r.setCookies) res.headers.append("Set-Cookie", c);
      return res;
    }
  }
}
