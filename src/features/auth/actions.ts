"use server";
// Server actions behind the users, allowlist and sessions components. Each one runs auth's own
// checks (owner role, step-up) inside manage.ts; the proxy is never the only gate.
import { headers } from "next/headers";
import type { Role } from "@/core/contracts";
import { AtriumError } from "@/core/errors";
import * as manage from "./server/manage";

export type ActionResult<T = null> = { ok: true; data: T } | { ok: false; status: number; code: string; message: string; field?: string };

async function run<T>(fn: (h: Headers) => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn(new Headers(await headers())) };
  } catch (err) {
    if (err instanceof AtriumError) {
      const field = (err as AtriumError & { problem?: { field?: string } }).problem?.field;
      return { ok: false, status: err.status, code: err.code, message: err.message, ...(field ? { field } : {}) };
    }
    return { ok: false, status: 500, code: "internal", message: "Something went wrong. Try again." };
  }
}

const ROLE = new Set<Role>(["owner", "member", "viewer"]);
const role = (r: unknown): Role => {
  if (typeof r !== "string" || !ROLE.has(r as Role)) throw new AtriumError("Pick a role.", 400, "bad_request");
  return r as Role;
};
const id = (v: unknown): string => {
  if (typeof v !== "string" || v.length === 0 || v.length > 64) throw new AtriumError("Not found.", 404, "not_found");
  return v;
};

export async function loadUsersAction() {
  return run((h) => manage.loadUsersPage(h));
}
export async function changeRoleAction(userId: string, newRole: Role) {
  return run((h) => manage.changeRoleAs(h, id(userId), role(newRole)));
}
export async function removeUserAction(userId: string) {
  return run(async (h) => {
    await manage.removeUserAs(h, id(userId));
    return null;
  });
}
export async function transferOwnershipAction(userId: string) {
  return run(async (h) => {
    await manage.transferOwnershipAs(h, id(userId));
    return null;
  });
}
export async function addPatternAction(pattern: string, newRole: Role) {
  return run((h) => manage.addPatternAs(h, String(pattern ?? "").slice(0, 320), role(newRole)));
}
export async function removePatternAction(entryId: string) {
  return run((h) => manage.removePatternAs(h, id(entryId)));
}
export async function setPatternRoleAction(entryId: string, newRole: Role) {
  return run((h) => manage.setPatternRoleAs(h, id(entryId), role(newRole)));
}
// Invite and reset links (Amendment 3): the owner only, checked in the service on every call.
export async function createInviteAction(email: string, newRole: string, days?: number) {
  return run((h) => manage.createInviteAs(h, { email: String(email ?? "").slice(0, 320), role: newRole, days }));
}
export async function createResetAction(userId: string, days?: number) {
  return run((h) => manage.createResetAs(h, id(userId), days));
}
export async function listLinksAction() {
  return run((h) => manage.listLinksAs(h));
}
export async function revokeLinkAction(linkId: string) {
  return run((h) => manage.revokeLinkAs(h, id(linkId)));
}
export async function listMySessionsAction() {
  return run((h) => manage.listMySessions(h));
}
export async function signOutOthersAction() {
  return run((h) => manage.signOutOtherSessions(h));
}
