// GET /api/library: every saved component (owners and members). POST: save a subtree, or a new
// version of an existing component (architecture v3 section 4.8, amendment A4.1).
import { z } from "zod";
import { errorResponse, AtriumError } from "@/core/errors";
import { requireUser } from "@/features/auth";
import { nodeSchema } from "@/features/library/file";
import { listLibrary, saveLibrary } from "@/features/library/server";

export const dynamic = "force-dynamic";

const saveBody = z.strictObject({
  componentId: z.string().max(64).optional(),
  name: z.string().min(1).max(80),
  description: z.string().max(300).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  node: nodeSchema,
  promote: z.array(z.strictObject({ nodeId: z.string().max(64), prop: z.string().max(64), name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,31}$/), label: z.string().max(120).optional(), kind: z.enum(["text", "number", "color", "boolean"]) })).max(30).optional(),
  sources: z.array(z.string().max(32)).max(100),
  controls: z.array(z.strictObject({ id: z.string().max(32), label: z.string().max(120) })).max(100),
});

export async function GET(req: Request) {
  try {
    const { principal } = await requireUser(req, "member");
    return Response.json({ components: listLibrary(principal) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const { principal } = await requireUser(req, "member");
    const parsed = saveBody.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new AtriumError(`The request is not valid: ${parsed.error.issues[0]?.path.join(".") || "body"} ${parsed.error.issues[0]?.message ?? ""}`.trim(), 400, "invalid");
    return Response.json({ component: saveLibrary(principal, parsed.data) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
