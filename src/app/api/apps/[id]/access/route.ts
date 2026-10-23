// GET /api/apps/<id>/access: audience, people and live guest links. PUT: change it (session people who
// can edit; audited as app.access_changed; guests off revokes every link).
import "@/features/apps/register";
import type { UserSet } from "@/core/contracts";
import { listGuestLinks, requireUser } from "@/features/auth";
import { handle, jsonBody } from "@/features/apps/http";
import { appForEditor, updateAccess } from "@/features/apps/service";
import * as repo from "@/features/apps/repo";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await params;
    const { principal } = await requireUser(req);
    const app = appForEditor(principal, id);
    const links = await listGuestLinks(principal, app.id).catch(() => null);
    const live = (links?.links ?? []).filter((l) => l.status === "active" || l.status === "locked").length;
    return Response.json({ access: app.access, people: repo.allUsers().map((u) => ({ id: u.id, name: u.name, role: u.role })), liveLinks: live });
  });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await params;
    const { principal } = await requireUser(req);
    const b = await jsonBody(req, 64 * 1024);
    const r = updateAccess(principal, id, { view: b.view as UserSet, edit: b.edit as UserSet, guests: b.guests === true });
    return Response.json({ access: r.app.access, revokedLinks: r.revokedLinks });
  });
}
