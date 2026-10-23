import { handleStream } from "@/features/data/routes";

export const dynamic = "force-dynamic";

// GET /api/data/stream?app=<appId>&page=<pageId>[&draft=1]: Server-Sent Events keyed by data source
// name (architecture v3 section 10). Guests receive only resolved values.
export function GET(req: Request) {
  return handleStream(req);
}
