// Unauthenticated liveness probe (architecture v2 section 2). Returns nothing else, ever.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true });
}
