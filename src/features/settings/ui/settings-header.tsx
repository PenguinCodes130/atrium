"use client";
// The shared screen header with the settings sub-tabs (design v4 Note 1). Each sub-tab has its own
// address, so it can be linked and reloaded. Tabs the person may not use are not shown.
import { usePathname } from "next/navigation";
import { ScreenHeader, usePageTitle } from "@/features/shell";

export type SettingsTab = { key: string; label: string };

export function SettingsHeader({ tabs, lead }: { tabs: SettingsTab[]; lead: string }) {
  const pathname = usePathname() ?? "/settings";
  const active = tabs.find((t) => pathname === `/settings/${t.key}` || pathname.startsWith(`/settings/${t.key}/`))?.key;
  // Settings r2 (gauntlet w2-r1 item 14): the sky band crumb reads "settings / <tab>", matching the tab.
  usePageTitle(active ? tabs.find((t) => t.key === active)!.label : "Settings");
  return <ScreenHeader title="Settings" lead={lead} tabs={tabs.map((t) => ({ label: t.label, href: `/settings/${t.key}`, active: t.key === active }))} />;
}
