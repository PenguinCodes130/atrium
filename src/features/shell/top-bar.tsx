"use client";
// The top bar (design v4 "Shell Frame and Navigation"). No sidebar.
//   1100px and wider: 52px on the screen background with a hairline under it: the 24px lit mark and
//     "Atrium", then boxed tabs Apps, Integrations, Approvals (count badge), Library, Audit, Settings
//     (32px tall mono labels in a 1px box; the active one filled ink with paper text). Right: the
//     "Ctrl K" key hint, the clock readout (instance name and time) and the account menu.
//   640 to 1099px: the clock hides; under 900px the tabs become icons with mono labels under them.
//   Under 640px: the mark, search and account only; the tabs move to the bottom bar.
// Round 5 (Wave 1 carry-over): every tab stop in the bar is at least 44px tall at every width. The visual
// boxes stay as design v4 draws them (32px tabs, key hint and avatar); each sits centred in a 44px tall
// hit area, which is the element that takes focus and clicks.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Mark, Wordmark } from "./mark";
import { SearchIcon } from "./icons";
import { SOON_LABEL, SOON_TAG, TABS, badgeText, isActive, isAvailable, type NavItem } from "./nav";
import { useShell } from "./shell-context";
import { useOnline } from "./use-viewport";
import { useReducedMotion } from "./use-preferences";
import { timed } from "./motion";
import { openPalette } from "./palette-bridge";
import { AccountMenu } from "./account-menu";
import { Tip } from "./tip";
import { DEFAULT_INSTANCE_NAME } from "./instance-name";
import { announceSoon } from "./soon";

export const OFFLINE_MESSAGE = "You're offline. Showing the last data Atrium had.";

/** "21:40" in the browser's time zone. */
export function clockText(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The clock readout: instance name and the local time, ticking each minute (client only). */
export function ClockReadout({ instance }: { instance: string }) {
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => setNow(clockText(new Date()));
    tick();
    const ms = 60_000 - (Date.now() % 60_000);
    let id: number | undefined;
    const t = window.setTimeout(() => {
      tick();
      id = window.setInterval(tick, 60_000);
    }, ms);
    return () => {
      window.clearTimeout(t);
      if (id) window.clearInterval(id);
    };
  }, []);
  return (
    <span className="hidden h-8 items-center gap-2 border border-line bg-bg-hi px-2.5 type-label text-fg-2 lg:inline-flex" data-clock aria-label={`${instance}, local time ${now ?? ""}`}>
      <span aria-hidden className="live-dot inline-block size-1.5 rounded-full bg-ok" />
      <span data-instance>{instance}</span>
      <time className="tabular text-fg" data-clock-time suppressHydrationWarning>
        {now ?? "--:--"}
      </time>
    </span>
  );
}

// The focusable hit area: 44px tall at every width; the box inside it carries the look.
const tabHit = "group relative inline-flex h-11 flex-none items-center px-0.5";
const tabBase =
  "relative inline-flex flex-none items-center justify-center border type-label whitespace-nowrap " +
  // 900px and wider: a 32px boxed label. 640 to 899px: an icon with a mono label under it.
  "h-11 min-w-11 flex-col gap-0.5 px-1.5 md:h-8 md:flex-row md:gap-2 md:px-2.5";
const tabIdle = "border-line-strong bg-bg-hi text-fg group-hover:bg-bg-sunk";
const tabActive = "border-line-strong bg-fg text-bg";
// Not built yet: the same box and full-contrast text as a live tab; the tooltip says "soon" (Fix 8).
const tabSoon = "cursor-default border-line-strong bg-bg-hi text-fg group-hover:bg-bg-sunk";

function TabBadge({ count, active }: { count: number; active: boolean }) {
  const text = badgeText(count);
  if (!text) return null;
  return (
    <span data-badge="pending proposals" className={`absolute -top-1.5 -right-1.5 inline-flex h-4 min-w-4 items-center justify-center px-1 type-caption leading-none tabular md:static md:h-[18px] ${active ? "bg-bg text-fg" : "bg-fg text-bg"}`}>
      <span aria-hidden>{text}</span>
    </span>
  );
}

function Tab({ item, pathname }: { item: NavItem; pathname: string }) {
  const { nav } = useShell();
  const active = isActive(pathname, item.href);
  const count = item.key === "approvals" ? nav.approvalsCount : 0;
  const badge = badgeText(count);
  const label = badge ? `${item.label}, ${count} pending` : item.label;
  const inner = (
    <>
      <item.Icon size={16} className="md:hidden" />
      <span data-tab-label className="text-[11px] leading-[13px] md:text-[12px] md:leading-4">
        {item.label}
      </span>
      <TabBadge count={count} active={active} />
    </>
  );
  if (!isAvailable(item.key, nav.routes)) {
    return (
      <li>
        <Tip label={SOON_LABEL} tag={SOON_TAG} side="bottom">
          <button type="button" aria-disabled="true" aria-description={SOON_LABEL} aria-label={label} className={`${tabHit} cursor-default`} data-tab={item.key} data-unavailable onClick={() => announceSoon(item.label)}>
            <span className={`${tabBase} ${tabSoon}`} data-tab-box>
              {inner}
            </span>
          </button>
        </Tip>
      </li>
    );
  }
  return (
    <li>
      <Link href={item.href} aria-current={active ? "page" : undefined} aria-label={badge ? label : undefined} className={tabHit} data-tab={item.key} data-active={active ? "" : undefined}>
        <span className={`${tabBase} ${active ? tabActive : tabIdle}`} data-tab-box>
          {inner}
        </span>
      </Link>
    </li>
  );
}

export function TopBar() {
  const { nav } = useShell();
  const pathname = usePathname() ?? "/";
  return (
    <header
      data-shell="topbar"
      className="sticky top-0 z-30 flex flex-none items-center gap-3 border-b border-line bg-bg pr-[max(var(--gutter),env(safe-area-inset-right,0px))] pl-[max(var(--gutter),env(safe-area-inset-left,0px))] lg:gap-4"
      style={{ height: "calc(var(--topbar-height) + env(safe-area-inset-top, 0px))", paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      <Link href="/" aria-label="Atrium, apps" className="inline-flex h-11 min-w-11 flex-none items-center" data-brand>
        {nav.brandLogo ? (
          <img src={nav.brandLogo} alt="" height={24} className="h-6 w-auto max-w-40 object-contain" data-brand-logo />
        ) : (
          <>
            <span className="sm:hidden">
              <Mark height={22} lit />
            </span>
            <span className="hidden sm:inline-flex">
              <Wordmark height={24} lit />
            </span>
          </>
        )}
      </Link>
      <nav aria-label="Main" className="hidden min-w-0 flex-1 sm:block" data-shell="tabs">
        <ul className="flex items-center overflow-x-auto [scrollbar-width:none] md:ml-4">
          {TABS.map((item) => (
            <Tab key={item.key} item={item} pathname={pathname} />
          ))}
        </ul>
      </nav>
      <div className="ml-auto flex flex-none items-center gap-2" data-topbar-actions>
        <button
          type="button"
          onClick={() => openPalette("other")}
          aria-label="Search (Ctrl K)"
          aria-haspopup="dialog"
          aria-keyshortcuts="Control+K Meta+K"
          className="group inline-flex size-11 cursor-pointer items-center justify-center text-fg hover:bg-bg-sunk sm:w-auto sm:hover:bg-transparent"
          data-search-hint
        >
          <SearchIcon size={16} className="sm:hidden" data-search-icon />
          <span className="hidden h-8 items-center gap-1 border border-line bg-bg-hi px-2 group-hover:bg-bg-sunk sm:inline-flex" aria-hidden data-search-keys>
            <kbd className="border border-line-strong bg-bg px-1 type-caption leading-4 text-fg">Ctrl</kbd>
            <kbd className="border border-line-strong bg-bg px-1 type-caption leading-4 text-fg">K</kbd>
          </span>
        </button>
        <ClockReadout instance={nav.instanceName ?? DEFAULT_INSTANCE_NAME} />
        <AccountMenu />
      </div>
    </header>
  );
}

/** A full-width ink strip under the top bar while the browser is offline; leaves with `fade`. */
export function OfflineBanner() {
  const online = useOnline();
  const reduced = useReducedMotion();
  return (
    <AnimatePresence>
      {!online && (
        <motion.div
          role="status"
          data-offline-banner
          className="flex flex-none items-center gap-2 bg-ink px-(--gutter) py-2 type-label text-paper"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={reduced ? { duration: 0.12 } : timed("fade")}
        >
          <span aria-hidden className="inline-block size-2 bg-warn" style={{ clipPath: "polygon(50% 0, 100% 100%, 0 100%)" }} />
          {OFFLINE_MESSAGE}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
