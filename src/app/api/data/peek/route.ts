import { handlePeek } from "@/features/data/catalogue-routes";

export const dynamic = "force-dynamic";

// Architecture A10.4: current values of up to 20 catalogue reads, editors only.
export function POST(req: Request) {
  return handlePeek(req);
}
