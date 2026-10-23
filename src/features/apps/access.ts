// Who may open, edit and delete an app (architecture v3 sections 4.2 and 5, amendments A1.1 and A4.1;
// spec section 3 "App access answers"). Pure: the resolver and the services call these with the App row.
import type { App, Principal, UserSet } from "@/core/contracts";

type Account = Exclude<Principal, { kind: "guest" }>;

function inSet(set: UserSet, userId: string): boolean {
  if (set === "owner") return false; // only the owner, who passes before any set is read
  if (set === "everyone") return true;
  return set.userIds.includes(userId);
}

/** Agents act for their user, limited by their scopes; the built-in agent has its user's scopes. */
function hasScope(p: Account, scope: "atrium:read" | "atrium:edit"): boolean {
  if (p.kind !== "agent") return true;
  if (scope === "atrium:read") return p.scopes.includes("atrium:read") || p.scopes.includes("atrium:edit");
  return p.scopes.includes("atrium:edit");
}

export function canOpen(app: App | null | undefined, p: Principal | null | undefined): boolean {
  if (!app || !p) return false;
  if (p.kind === "guest") return p.appId === app.id && app.access.guests && app.publishedVersion != null;
  if (!hasScope(p, "atrium:read")) return false;
  if (p.role === "owner") return true;
  return inSet(app.access.view, p.userId) || inSet(app.access.edit, p.userId);
}

/** Editing is granted only to the owner and to members in the edit set; a viewer in it can view only. */
export function canEdit(app: App | null | undefined, p: Principal | null | undefined): boolean {
  if (!app || !p || p.kind === "guest") return false;
  if (!hasScope(p, "atrium:edit")) return false;
  if (p.role === "owner") return true;
  if (p.role !== "member") return false;
  return inSet(app.access.edit, p.userId);
}

/** Amendment A4.1: the instance owner and the app's creator (not demoted to viewer), signed in. */
export function canDelete(app: App, p: Principal): boolean {
  if (p.kind !== "user") return false;
  if (p.role === "owner") return true;
  return p.role === "member" && app.createdBy === p.userId;
}

/** Only owners and members create apps (`apps.create` has minRole member). */
export function canCreate(p: Principal | null | undefined): boolean {
  if (!p || p.kind === "guest") return false;
  if (p.kind === "agent" && !p.scopes.includes("atrium:edit")) return false;
  return p.role === "owner" || p.role === "member";
}

/** Session-only operations (publish, restore, discard, access, delete): never agents, tokens or render sessions. */
export function isSessionPerson(p: Principal | null | undefined): p is Extract<Principal, { kind: "user" }> {
  return !!p && p.kind === "user" && p.via === "session";
}

export const SESSION_ONLY_MESSAGE = {
  publish: "Only a signed-in person can publish an app. Agents, access tokens and previews cannot.",
  restore: "Only a signed-in person can restore a version. Agents, access tokens and previews cannot.",
  access: "Only a signed-in person can change who can open an app. Agents, access tokens and previews cannot.",
  delete: "Only a signed-in person can delete an app. Agents, access tokens and previews cannot.",
  discard: "Only a signed-in person can discard a draft. Agents, access tokens and previews cannot.",
} as const;

/** The audience tag on a launcher tile: `owner only`, `members` or `guest link`. */
export function audienceTag(app: App): "owner only" | "members" | "guest link" {
  if (app.access.guests) return "guest link";
  const others = (set: UserSet) => set === "everyone" || (set !== "owner" && set.userIds.some((id) => id !== app.createdBy));
  return others(app.access.view) || others(app.access.edit) ? "members" : "owner only";
}
