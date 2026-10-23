// Guest entry (architecture v3 section 5.1, amendment A1.3). Owned by auth.
//   GET  /g/<token>   valid, no PIN: start a guest session, set atrium.guest, 303 to /a/<slug>
//                     valid with a PIN: 303 to the PIN step; signed in: 303 to /a/<slug> as that user
//                     anything else: the same 303 to /g/expired with an empty body, no cookie
//   POST /g/<token>   {pin} from the PIN step; JSON reply, the cookie on success
// The proxy limits /g/* to 30 requests per minute per IP; the token is never logged.
import { env } from "@/core/env";
import { openGuestLink, submitGuestPin, type GuestCookie, type OpenResult } from "@/features/auth/guest/service";
import { clientAddress } from "@/features/auth/server/rate-limit";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string }> };

const NO_STORE = { "Cache-Control": "no-store" };

function cookieHeader(c: GuestCookie): string {
  return [`${c.name}=${c.value}`, "Path=/", `Expires=${c.expires.toUTCString()}`, "HttpOnly", "SameSite=Lax", ...(c.secure ? ["Secure"] : [])].join("; ");
}

function seeOther(location: string, cookie?: GuestCookie): Response {
  const headers = new Headers({ Location: location, ...NO_STORE });
  if (cookie) headers.append("Set-Cookie", cookieHeader(cookie));
  return new Response(null, { status: 303, headers });
}

const appPath = (slug: string) => `/a/${encodeURIComponent(slug)}`;
const ipOf = (req: Request) => clientAddress(req.headers, env().ATRIUM_TRUSTED_PROXIES) ?? undefined;

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const { token } = await ctx.params;
  const r = await openGuestLink(token, req.headers, { ip: ipOf(req) });
  switch (r.kind) {
    case "guest":
      return seeOther(appPath(r.slug), r.cookie);
    case "user":
      return seeOther(appPath(r.slug));
    case "pin":
      return seeOther(`/g/${encodeURIComponent(token)}/pin`);
    default:
      return seeOther("/g/expired");
  }
}

function reply(r: OpenResult): Response {
  const json = (status: number, body: unknown, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { ...NO_STORE, ...extra } });
  switch (r.kind) {
    case "guest": {
      const res = json(200, { state: "redirect", to: appPath(r.slug) });
      res.headers.append("Set-Cookie", cookieHeader(r.cookie));
      return res;
    }
    case "user":
      return json(200, { state: "redirect", to: appPath(r.slug) });
    case "wrong_pin":
      return json(401, { state: "wrong_pin", triesLeft: r.triesLeft });
    case "locked":
      return json(429, { state: "locked", minutes: r.minutes }, { "Retry-After": String(r.minutes * 60) });
    default:
      return json(404, { state: "expired" });
  }
}

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { token } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { pin?: unknown } | null;
  if (!body || typeof body !== "object") return Response.json({ state: "bad_request" }, { status: 400, headers: NO_STORE });
  return reply(await submitGuestPin(token, body.pin, req.headers, { ip: ipOf(req) }));
}
