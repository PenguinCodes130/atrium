import { z } from "zod";
import { body, handle, packageCardOut, send } from "@/features/integrations/api";
import { packageFromIntegration } from "@/features/integrations/service";

export const dynamic = "force-dynamic";
const input = z.object({ name: z.string().trim().min(1).max(80) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle(req, "member", async (s) => send(packageCardOut, packageFromIntegration(s.principal, id, (await body(req, input)).name), { status: 201 }));
}
