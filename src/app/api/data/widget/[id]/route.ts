import { handlePoll } from "@/features/data/routes";

export const dynamic = "force-dynamic";

// The polling fallback while the stream is down: GET /api/data/widget/<appId>:<sourceName>?page=<pageId>
// (the route keeps its v2 name, architecture v3 section 10).
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handlePoll(req, decodeURIComponent(id));
}
