// POST /api/apps/import (multipart: file, optional mappings JSON, name, slug). Without mappings it
// answers what to map; with them it creates a new app with a draft only. Owners and members.
import "@/features/apps/register";
import { AtriumError } from "@/core/errors";
import { requireUser } from "@/features/auth";
import { handle } from "@/features/apps/http";
import { importAppFile, importMappingOptions, parseAppFile, planLibrary } from "@/features/apps/appfile";
import { canCreate } from "@/features/apps/access";
import { Forbidden } from "@/core/errors";

export const dynamic = "force-dynamic";
const MAX = 40 * 1024 * 1024;

export async function POST(req: Request) {
  return handle(async () => {
    const { principal } = await requireUser(req);
    if (!canCreate(principal)) throw new Forbidden("Only owners and members can import apps.");
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!form || !(file instanceof File)) throw new AtriumError("Choose an Atrium app file.", 400, "bad_request");
    if (file.size > MAX) throw new AtriumError(`${file.name} could not be imported: it is too large.`, 413, "too_large");
    const parsed = parseAppFile(Buffer.from(await file.arrayBuffer()), file.name || "The file");
    const raw = form.get("mappings");
    if (typeof raw !== "string") return Response.json({ step: "map", name: parsed.doc.app.name, slug: parsed.slug, integrations: importMappingOptions(principal, parsed), library: parsed.library, libraryComponents: planLibrary(principal, parsed.libraryFiles).map(({ file: f, outcome }) => ({ id: f.id, name: f.name, version: f.version, containsCode: f.containsCode, outcome })), containsCode: parsed.containsCode });
    let mappings: Record<string, string | null> = {};
    try {
      mappings = JSON.parse(raw) as Record<string, string | null>;
    } catch {
      throw new AtriumError("The integration choices could not be read.", 400, "bad_request");
    }
    const name = form.get("name");
    const slug = form.get("slug");
    const r = importAppFile(principal, parsed, { mappings, ...(typeof name === "string" && name ? { name } : {}), ...(typeof slug === "string" && slug ? { slug } : {}) });
    return Response.json({ step: "done", app: { id: r.app.id, slug: r.app.slug, name: r.app.name }, skipped: r.skipped, library: r.library }, { status: 201 });
  });
}
