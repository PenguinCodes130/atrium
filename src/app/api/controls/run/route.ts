import { handleControlRun } from "@/features/controls/route";

export const dynamic = "force-dynamic";

// POST /api/controls/run (architecture v3 section 6.2, amendment A1.4): session users and guests
// only; bearer tokens, render sessions and other origins are refused before anything runs.
export function POST(req: Request) {
  return handleControlRun(req);
}
