// POST /api/library/import: checks a component file and, unless ?check=1, saves it as an imported
// component. The check answer lists its parameters and whether it contains code, so the screen can
// show "Contains code. It runs in the sandbox and sees only the data you give it." before confirming.
// It also names the component the file came from when it is here (`match`), and the name a copy gets
// (`copyName`); `?mode=update` then saves the file as that component's next version (Fix 15).
import { errorResponse, AtriumError } from "@/core/errors";
import { requireUser } from "@/features/auth";
import { containsCode } from "@/features/components/library-instance";
import { freeName, importLibrary, importMatch, libraryActor, parseComponentFile, CONTAINS_CODE_NOTICE } from "@/features/library/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { principal } = await requireUser(req, "member");
    libraryActor(principal);
    const text = await req.text();
    const parsed = parseComponentFile(text);
    if (!parsed.ok) throw new AtriumError(parsed.problem, 400, "invalid_file");
    const code = containsCode(parsed.file.node);
    if (new URL(req.url).searchParams.get("check") === "1") {
      const match = importMatch(principal, parsed.file);
      return Response.json({ name: parsed.file.name, description: parsed.file.description ?? "", params: parsed.file.params, containsCode: code, ...(code ? { notice: CONTAINS_CODE_NOTICE } : {}), match, copyName: freeName(parsed.file.name) });
    }
    const mode = new URL(req.url).searchParams.get("mode") === "update" ? "update" : "copy";
    return Response.json({ component: importLibrary(principal, parsed.file, { mode }) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
