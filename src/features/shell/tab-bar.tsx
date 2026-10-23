"use client";
// Phone bottom bar (under 640px, design v4): 60px plus the safe area, on raised paper with a top
// hairline: Apps, Integrations, Approvals (count badge) and More. More opens a bottom sheet with
// Library, Audit, Settings and the account (architecture v3 amendment A1.7).
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { MoreIcon } from "./icons";
import { MORE_ITEMS, PHONE_TABS, SOON_LABEL, badgeText, isActive, isAvailable, type NavItem } from "./nav";
import { useShell } from "./shell-context";
import { Sheet } from "./sheet";
import { announceSoon } from "./soon";
import { AppearanceControls } from "./appearance";
import { Button } from "./button";
import { signOut, initialsFor } from "./account-menu";

const cell = "relative flex min-h-11 min-w-11 flex-1 cursor-pointer flex-col items-center justify-center gap-1 type-caption";

function Glyph({ item, badge, active }: { item: NavItem; badge: string | null; active: boolean }) {
  return (
    <span className="relative">
      <item.Icon size={20} />
      {badge && (
        <span aria-hidden data-badge="pending proposals" className={`absolute -top-1.5 -right-3 inline-flex h-4 min-w-4 items-center justify-center px-1 type-caption leading-none tabular ${active ? "bg-bg text-fg" : "bg-fg text-bg"}`}>
          {badge}
        </span>
      )}
    </span>
  );
}

/** A row in the More sheet: a link, or a disabled "soon" row for destinations without a route. */
function MoreRow({ item, pathname, onNavigate }: { item: NavItem; pathname: string; onNavigate: () => void }) {
  const { nav } = useShell();
  const active = isActive(pathname, item.href);
  const row = "flex min-h-11 w-full items-center gap-3 border-b border-line px-2 type-body";
  if (!isAvailable(item.key, nav.routes)) {
    return (
      <li>
        <button type="button" aria-disabled="true" aria-description={SOON_LABEL} className={`${row} cursor-default text-fg`} onClick={() => announceSoon(item.label)} data-nav={item.key} data-unavailable>
          <item.Icon size={18} />
          {item.label}
          <span aria-hidden className="ml-auto bg-fg px-1.5 py-0.5 type-caption leading-none text-bg">soon</span>
        </button>
      </li>
    );
  }
  return (
    <li>
      <Link href={item.href} aria-current={active ? "page" : undefined} className={`${row} ${active ? "bg-fg text-bg" : "text-fg hover:bg-bg-sunk"}`} onClick={onNavigate} data-nav={item.key}>
        <item.Icon size={18} />
        {item.label}
      </Link>
    </li>
  );
}

export function TabBar() {
  const pathname = usePathname() ?? "/";
  const { nav } = useShell();
  const [more, setMore] = useState(false);
  const moreActive = MORE_ITEMS.some((i) => isActive(pathname, i.href));
  const user = nav.user;
  return (
    <>
      <nav
        aria-label="Main"
        data-shell="tabbar"
        className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-bg-hi pb-safe sm:hidden"
        style={{ height: "calc(var(--tabbar-height) + env(safe-area-inset-bottom, 0px))" }}
      >
        <div className="flex h-(--tabbar-height) w-full items-stretch">
          {PHONE_TABS.map((item) => {
            const active = isActive(pathname, item.href);
            const count = item.key === "approvals" ? nav.approvalsCount : 0;
            const badge = badgeText(count);
            const label = badge ? `${item.label}, ${count} pending` : undefined;
            if (!isAvailable(item.key, nav.routes)) {
              return (
                <button key={item.key} type="button" aria-disabled="true" aria-description={SOON_LABEL} aria-label={label} className={`${cell} cursor-default text-fg-2`} onClick={() => announceSoon(item.label)} data-tab={item.key} data-unavailable>
                  <Glyph item={item} badge={badge} active={false} />
                  <span data-tab-label>{item.label}</span>
                </button>
              );
            }
            return (
              <Link key={item.key} href={item.href} aria-current={active ? "page" : undefined} aria-label={label} className={`${cell} ${active ? "bg-fg text-bg" : "text-fg-2"}`} data-tab={item.key}>
                <Glyph item={item} badge={badge} active={active} />
                <span data-tab-label>{item.label}</span>
              </Link>
            );
          })}
          <button type="button" className={`${cell} ${moreActive ? "bg-fg text-bg" : "text-fg-2"}`} onClick={() => setMore(true)} aria-haspopup="dialog" data-tab="more">
            <MoreIcon size={20} />
            <span data-tab-label>More</span>
          </button>
        </div>
      </nav>

      <Sheet open={more} onOpenChange={setMore} title="More" side="bottom" name="more">
        <ul className="flex flex-col border-t border-line">
          {MORE_ITEMS.map((item) => (
            <MoreRow key={item.key} item={item} pathname={pathname} onNavigate={() => setMore(false)} />
          ))}
        </ul>
        <section aria-label="Account" className="mt-6" data-more-account>
          <div className="mb-4 flex items-center gap-3">
            <span aria-hidden className="inline-flex size-9 flex-none items-center justify-center rounded-full bg-fg type-label text-bg">
              {initialsFor(user?.name, user?.email)}
            </span>
            <div className="min-w-0">
              <p className="truncate type-body font-medium text-fg">{user?.name || "Account"}</p>
              {user?.email && <p className="truncate type-label text-fg-2">{user.email}</p>}
            </div>
          </div>
          <AppearanceControls idPrefix="more-appearance" />
          <Button variant="secondary" className="mt-4 w-full" onClick={() => void signOut()}>
            Sign out
          </Button>
        </section>
      </Sheet>
    </>
  );
}
