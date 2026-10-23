// Shell navigation (design v4 "Shell Frame and Navigation"): boxed tabs Apps, Integrations, Approvals,
// Library, Audit, Settings on desktop; Apps, Integrations, Approvals and More on phones (the More
// sheet holds Library, Audit, Settings and the account, architecture v3 amendment A1.7).
import { AppsIcon, ApprovalIcon, AuditIcon, LibraryIcon, PlugIcon, SettingsIcon } from "./icons";

export type NavKey = "apps" | "integrations" | "approvals" | "library" | "audit" | "settings";
export type NavItem = { key: NavKey; label: string; href: string; Icon: typeof AppsIcon };

export const APPS: NavItem = { key: "apps", label: "Apps", href: "/", Icon: AppsIcon };
export const INTEGRATIONS: NavItem = { key: "integrations", label: "Integrations", href: "/integrations", Icon: PlugIcon };
export const APPROVALS: NavItem = { key: "approvals", label: "Approvals", href: "/approvals", Icon: ApprovalIcon };
export const LIBRARY: NavItem = { key: "library", label: "Library", href: "/library", Icon: LibraryIcon };
export const AUDIT: NavItem = { key: "audit", label: "Audit", href: "/audit", Icon: AuditIcon };
/**
 * Settings (Wave 2, architecture v3 A4.4). `/account` is now a permanent redirect (auth) to
 * `/settings/security`; every shell link points at `/settings/...` directly.
 */
export const SETTINGS_HREF = "/settings";
/** auth's two panels, mounted by settings: one screen name, "Users and security", for both. */
export const USERS_HREF = "/settings/users";
export const SECURITY_HREF = "/settings/security";
export const USERS_AND_SECURITY_LABEL = "Users and security";
/** Where the account menu and the palette's "Users and security" row go: every signed-in role can open it. */
export const USERS_AND_SECURITY_HREF = SECURITY_HREF;
/** @deprecated round 4 name; Settings no longer has an interim address. */
export const SETTINGS_INTERIM_HREF = SETTINGS_HREF;
export const SETTINGS: NavItem = { key: "settings", label: "Settings", href: SETTINGS_HREF, Icon: SettingsIcon };

/** True on the users and security screens (`/settings/users`, `/settings/security` and below). */
export function isUsersAndSecurity(pathname: string): boolean {
  return [USERS_HREF, SECURITY_HREF].some((h) => pathname === h || pathname.startsWith(`${h}/`));
}
/** @deprecated v3 name of the Apps tab. */
export const HOME = APPS;

/** The desktop tab order. */
export const TABS: NavItem[] = [APPS, INTEGRATIONS, APPROVALS, LIBRARY, AUDIT, SETTINGS];
/** Phone bottom bar (plus More). */
export const PHONE_TABS: NavItem[] = [APPS, INTEGRATIONS, APPROVALS];
/** The phone More sheet. */
export const MORE_ITEMS: NavItem[] = [LIBRARY, AUDIT, SETTINGS];

/**
 * Which shell destinations have a route today (no dead links). A destination that is not available
 * stays in its place, disabled, with a "Coming in a later update" tooltip (and a toast on tap, since
 * touch has no hover). When a subsystem ships its route, flip its flag here (shared request to
 * app-shell), or feed `routes` through the shell nav (`ShellFrame initial` / `useShellNav`).
 */
export type RouteKey = NavKey | "home";
export const ROUTES_AVAILABLE: Record<RouteKey, boolean> = {
  apps: true, // app-builder's launcher (Wave 2)
  home: true,
  integrations: true,
  approvals: false, // actions, Wave 3
  library: true, // components ships /library in Wave 2
  audit: false, // actions, Wave 3
  settings: true, // settings ships /settings in Wave 2
};
export const SOON_LABEL = "Coming in a later update";
/** The mono tag shown with SOON_LABEL in a destination's tooltip. */
export const SOON_TAG = "soon";

/** Paths of destinations that are not built yet, and who builds them (the "coming" room). */
export const COMING_ROUTES: { prefix: string; label: string; key: RouteKey; arrives: string }[] = [
  { prefix: "/settings", label: "Settings", key: "settings", arrives: "with settings" },
  { prefix: "/approvals", label: "Approvals", key: "approvals", arrives: "with agent actions" },
  { prefix: "/audit", label: "Audit", key: "audit", arrives: "with the audit log" },
];
/** The unbuilt destination a path belongs to, or null. A built route always wins over its coming room. */
export function comingRouteFor(pathname: string): (typeof COMING_ROUTES)[number] | null {
  return COMING_ROUTES.find((r) => pathname === r.prefix || pathname.startsWith(`${r.prefix}/`)) ?? null;
}

export function isAvailable(key: RouteKey, overrides?: Partial<Record<RouteKey, boolean>>): boolean {
  return overrides?.[key] ?? ROUTES_AVAILABLE[key];
}

/** The Apps tab is active on the launcher and in the builder; the others by path prefix. */
export function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/" || pathname === "/build" || pathname.startsWith("/build/");
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The tab for the current path, or null (for example on not found). */
export function activeTab(pathname: string): NavKey | null {
  return TABS.find((t) => isActive(pathname, t.href))?.key ?? null;
}

/** Display text for a count badge. */
export function badgeText(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count > 99 ? "99+" : String(Math.floor(count));
}

/** Move an item one place up or down (keyboard reorder). */
export function moveItem<T>(list: T[], from: number, delta: -1 | 1): T[] {
  const to = from + delta;
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}
