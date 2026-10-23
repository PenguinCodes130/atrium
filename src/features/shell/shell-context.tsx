"use client";
// Shell data that other subsystems feed in: the pending-proposal count (actions, through the
// approvalsCount hook), the instance name (settings), the page title (shown as the sky band path),
// and, kept from v3 for screens that still set them, pages, drafts and the Edit toggle.
// The server layout passes what it knows as `initial`; client code can update it with the hooks below.
import type { RouteKey } from "./nav";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type ShellPage = { id: string; title: string; href: string };
export type ShellDraft = { id: string; title: string; href?: string; createdAt?: string };
export type ShellUser = { name?: string; email: string };

export type ShellNav = {
  pages: ShellPage[];
  approvalsCount: number;
  drafts: ShellDraft[];
  user?: ShellUser;
  /** Override which destinations have a route (defaults: ROUTES_AVAILABLE in nav.ts). */
  routes?: Partial<Record<RouteKey, boolean>>;
  /** The clock readout's instance name (architecture v3 A1.7: settings "Instance name", default the host of ATRIUM_PUBLIC_URL). */
  instanceName?: string;
  /** Settings r2 (item 8): the owner's uploaded logo (/uploads/brand/logo), shown instead of the mark. */
  brandLogo?: string;
};

export type EditToggle = { active: boolean; onToggle: () => void };

type ShellCtx = {
  nav: ShellNav;
  setNav: (patch: Partial<ShellNav>) => void;
  title: string | null;
  setTitle: (title: string | null) => void;
  edit: EditToggle | null;
  setEdit: (edit: EditToggle | null) => void;
  onReorderPages: ((ids: string[]) => void) | null;
  setOnReorderPages: (fn: ((ids: string[]) => void) | null) => void;
  onNewPage: (() => void) | null;
  setOnNewPage: (fn: (() => void) | null) => void;
};

export const EMPTY_NAV: ShellNav = { pages: [], approvalsCount: 0, drafts: [] };

const Ctx = createContext<ShellCtx | null>(null);

export function ShellProvider({ initial, children }: { initial?: Partial<ShellNav>; children: ReactNode }) {
  const [nav, setNavState] = useState<ShellNav>({ ...EMPTY_NAV, ...initial });
  const [title, setTitle] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditToggle | null>(null);
  const [onReorderPages, setReorder] = useState<((ids: string[]) => void) | null>(null);
  const [onNewPage, setNewPage] = useState<(() => void) | null>(null);
  const setNav = useCallback((patch: Partial<ShellNav>) => setNavState((n) => ({ ...n, ...patch })), []);
  const value = useMemo<ShellCtx>(
    () => ({
      nav,
      setNav,
      title,
      setTitle,
      edit,
      setEdit,
      onReorderPages,
      setOnReorderPages: (fn) => setReorder(() => fn),
      onNewPage,
      setOnNewPage: (fn) => setNewPage(() => fn),
    }),
    [nav, setNav, title, edit, onReorderPages, onNewPage],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useShell(): ShellCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useShell must be used inside the (shell) layout");
  return ctx;
}

/** Set the top bar title for the current screen. */
export function usePageTitle(title: string | null) {
  const ctx = useContext(Ctx);
  useEffect(() => {
    ctx?.setTitle(title);
    return () => ctx?.setTitle(null);
    // ctx identity changes with its state; only the title matters here
  }, [title]);
}

/** Feed shell nav data (pages, approvals count, drafts) from client code. */
export function useShellNav(patch: Partial<ShellNav> | null) {
  const ctx = useContext(Ctx);
  const key = JSON.stringify(patch);
  useEffect(() => {
    if (patch) ctx?.setNav(patch);
  }, [key]);
}

/** Show the Edit toggle in the top bar (page-composer owns the behaviour). */
export function useEditToggle(edit: EditToggle | null) {
  const ctx = useContext(Ctx);
  const latest = useRef(edit);
  latest.current = edit;
  const active = edit?.active;
  const shown = edit !== null;
  useEffect(() => {
    // onToggle always calls the newest handler, so callers need not memoise it
    ctx?.setEdit(shown ? { active: Boolean(active), onToggle: () => latest.current?.onToggle() } : null);
    return () => ctx?.setEdit(null);
  }, [active, shown]);
}

/** Title shown when no screen has set one. */
export function defaultTitleFor(pathname: string, pages: ShellPage[]): string {
  if (pathname === "/") return "Apps";
  const page = pages.find((p) => p.href === pathname);
  if (page) return page.title;
  const seg = pathname.split("/").filter(Boolean)[0] ?? "";
  const known: Record<string, string> = { integrations: "Integrations", approvals: "Approvals", library: "Library", audit: "Audit", settings: "Settings", agent: "Setup agent", build: "Builder" };
  return known[seg] ?? "Atrium";
}
