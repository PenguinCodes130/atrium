"use client";
// The shell frame around every signed-in screen (design v4 "Shell Frame and Navigation"): the top bar
// (tabs on 640px and wider), the offline strip, the sky band (every shell screen except the builder),
// the content, and the phone bottom bar (under 640px). No sidebar. Layout switches with CSS
// breakpoints, so the server render is right. Ctrl/Cmd+K lives in <ShellGlobals> (root layout); the
// palette fallback it opens is mounted here.
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Tooltip } from "radix-ui";
import { ShellProvider, defaultTitleFor, useShell, type ShellNav, type ShellPage } from "./shell-context";
import { TABS, isActive } from "./nav";
import { DEFAULT_INSTANCE_NAME } from "./instance-name";
import { TabBar } from "./tab-bar";
import { OfflineBanner, TopBar } from "./top-bar";
import { PaletteFallback } from "./palette-fallback";
import { SkyBand, type SkyCrumb } from "./sky-band";

/** An app's versions or settings screen: `/build/<slug>/versions` or `/build/<slug>/settings`. */
const APP_SUBSCREEN = /^\/build\/([^/]+)\/(versions|settings)\/?$/;

/** The builder has its own bar and never shows the sky band (design v4); its versions and settings screens do. */
export function showsSkyBand(pathname: string): boolean {
  if (APP_SUBSCREEN.test(pathname)) return true;
  return !(pathname === "/build" || pathname.startsWith("/build/"));
}

/**
 * Design v4 "The Builder": the 48px builder bar replaces the shell top bar on the builder itself
 * (`/build/<slug>` and `/build/<slug>/<page>`). Versions and app settings keep the top bar: they have no
 * builder bar of their own. The phone tab bar stays (the builder is read-only there and needs a way out).
 */
export function showsTopBar(pathname: string): boolean {
  const m = /^\/build\/[^/]+(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!m) return true;
  return m[1] === "versions" || m[1] === "settings";
}

function TopBarSlot() {
  const pathname = usePathname() ?? "/";
  return showsTopBar(pathname) ? <TopBar /> : null;
}

/**
 * The sky band crumb (Fix 9): the instance name (links to Apps), the section (links to its screen
 * when deeper), then the screen's own title with its case kept (user data such as an integration name).
 */
export function crumbsFor(pathname: string, title: string | null, instance: string, pages: ShellPage[]): SkyCrumb[] {
  const crumbs: SkyCrumb[] = [{ label: instance, href: "/" }];
  const sub = APP_SUBSCREEN.exec(pathname);
  if (sub) {
    // Atrium / apps / <slug> / versions (gauntlet w2-r1 app-builder item 18).
    const slug = decodeURIComponent(sub[1]!);
    return [...crumbs, { label: "apps", href: "/" }, { label: slug, href: `/build/${sub[1]}` }, { label: sub[2]! }];
  }
  const section = TABS.find((t) => t.href !== "/" && isActive(pathname, t.href));
  const sectionHref = section ? (pathname.startsWith(section.href) ? section.href : `/${pathname.split("/").filter(Boolean)[0] ?? ""}`) : null;
  const shown = title ?? defaultTitleFor(pathname, pages);
  if (section && sectionHref) {
    crumbs.push({ label: section.label.toLowerCase(), href: sectionHref });
    const deeper = pathname !== sectionHref && pathname !== `${sectionHref}/`;
    // Settings r2 SFR (gauntlet w2-r1 item 14): the crumb matches the active settings tab ("Users",
    // "Security"), which the settings header sets as the page title.
    if (deeper && shown && shown.toLowerCase() !== section.label.toLowerCase()) crumbs.push({ label: shown });
  } else {
    crumbs.push({ label: shown === "Apps" || shown === "Not found" ? shown.toLowerCase() : shown });
  }
  return crumbs;
}

function Band() {
  const { title, nav } = useShell();
  const pathname = usePathname() ?? "/";
  if (!showsSkyBand(pathname)) return null;
  return <SkyBand crumbs={crumbsFor(pathname, title, nav.instanceName ?? DEFAULT_INSTANCE_NAME, nav.pages)} />;
}

export function ShellFrame({ initial, children }: { initial?: Partial<ShellNav>; children: ReactNode }) {
  return (
    <ShellProvider initial={initial}>
      <Tooltip.Provider delayDuration={300} skipDelayDuration={150}>
        <a href="#main" className="sr-only bg-fg px-4 py-2 type-label text-bg focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[70]">
          Skip to content
        </a>
        <div data-shell="content" className="flex min-h-dvh flex-col pb-[calc(var(--tabbar-height)+env(safe-area-inset-bottom,0px))] sm:pb-0">
          <TopBarSlot />
          <OfflineBanner />
          <Band />
          <main id="main" tabIndex={-1} className="relative flex flex-1 flex-col outline-none" data-shell-main>
            {children}
          </main>
        </div>
        <TabBar />
        <PaletteFallback />
      </Tooltip.Provider>
    </ShellProvider>
  );
}
