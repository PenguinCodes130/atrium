import { handleChoices } from "@/features/data/choices";

export const dynamic = "force-dynamic";

// Architecture A8.2: live choices for an endpoint parameter, editors only (see features/data/choices.ts).
export function GET(req: Request) {
  return handleChoices(req);
}
