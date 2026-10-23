"use client";
// The Integrations tab's two views (Amendment 2, design v4 "Shell Frame and Navigation"): Services
// and Credentials, boxed like the top bar's tabs, the active one filled ink. Each is its own address.
import Link from "next/link";
import type { ScreenTab } from "@/features/shell";

/** The two views as the shared ScreenHeader's boxed tabs (design v4 Note 1). */
export function integrationsTabs(current: "services" | "credentials"): ScreenTab[] {
  return [
    { label: "Services", href: "/integrations", active: current === "services" },
    { label: "Credentials", href: "/integrations/credentials", active: current === "credentials" },
  ];
}

const base = "inline-flex h-8 touch:h-11 flex-none items-center justify-center border border-line-strong px-3 type-label whitespace-nowrap";
const idle = "bg-bg-hi text-fg hover:bg-bg-sunk";
const active = "bg-fg text-bg";

export function IntegrationsViewTabs({ current }: { current: "services" | "credentials" }) {
  const tabs = [
    { key: "services", label: "Services", href: "/integrations" },
    { key: "credentials", label: "Credentials", href: "/integrations/credentials" },
  ] as const;
  return (
    <nav aria-label="Integrations views" data-integrations-views>
      <ul className="flex items-center gap-1">
        {tabs.map((t) => (
          <li key={t.key}>
            <Link href={t.href} aria-current={current === t.key ? "page" : undefined} className={`${base} ${current === t.key ? active : idle}`} data-view-tab={t.key} data-active={current === t.key ? "" : undefined}>
              {t.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
