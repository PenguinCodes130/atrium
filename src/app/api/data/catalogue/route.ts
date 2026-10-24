import { handleCatalogue } from "@/features/data/catalogue-routes";

export const dynamic = "force-dynamic";

// Architecture A10.4: the data catalogue, editors only (see features/data/catalogue.ts).
export function GET(req: Request) {
  return handleCatalogue(req);
}
