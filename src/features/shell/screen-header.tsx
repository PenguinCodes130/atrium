// The shared screen header and column (design v4 Note 1: "Shell screens share one header"). Every
// shell screen opens with one <ScreenHeader>: the title at --type-title-1 (the only h1 style on a work
// screen; rooms use --type-display), an optional --type-body-lg lead, an optional right-aligned primary
// action and optional boxed sub-tabs under it. Put it inside <Screen>, the shell's one content column:
// its left edge is the same as the sky band's mark and crumb (both use the `screen-x` utility), so a
// screen has one left edge.
//
//   <Screen>
//     <ScreenHeader title="Integrations" lead="Services Atrium reads from." action={<Button variant="primary" href="/integrations/new">Add integration</Button>}
//       tabs={[{ label: "Services", href: "/integrations", active: true }, { label: "Credentials", href: "/integrations/credentials" }]} />
//     ...windows...
//   </Screen>
import Link from "next/link";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

export type ScreenTab = { label: string; href: string; active?: boolean };

export type ScreenHeaderProps = {
  /** The screen title (an h1 at --type-title-1). */
  title: ReactNode;
  /** One lead sentence under the title (--type-body-lg, secondary text). */
  lead?: ReactNode;
  /** The screen's one primary action (or a small group), right-aligned beside the title. */
  action?: ReactNode;
  /** Boxed sub-tabs under the title, for views within a screen. */
  tabs?: ScreenTab[];
};

export function ScreenHeader({ title, lead, action, tabs }: ScreenHeaderProps) {
  return (
    <header className="flex flex-col gap-6" data-screen-header>
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="min-w-0 max-w-[64ch] flex-[1_1_28rem]">
          <h1 className="type-title-1 break-words text-fg" data-screen-title>
            {title}
          </h1>
          {lead ? (
            <p className="mt-3 type-body-lg text-fg-2" data-screen-lead>
              {lead}
            </p>
          ) : null}
        </div>
        {action ? (
          <div className="flex flex-none flex-wrap items-center gap-2" data-screen-action>
            {action}
          </div>
        ) : null}
      </div>
      {tabs && tabs.length > 0 ? (
        <nav aria-label="Views" data-screen-tabs>
          <ul className="flex flex-wrap items-center gap-1">
            {tabs.map((t) => (
              <li key={t.href}>
                {/* The link is a 44px hit area (settings criterion 46, like the top bar tabs in round 5); the
                    boxed tab inside keeps the 32px design box with a pointer and grows to 44px on touch. */}
                <Link
                  href={t.href}
                  aria-current={t.active ? "page" : undefined}
                  className="group inline-flex h-11 items-center"
                  data-screen-tab={t.active ? "active" : ""}
                >
                  <span
                    className={`inline-flex h-8 items-center border border-line-strong px-2.5 type-label whitespace-nowrap touch:h-11 ${t.active ? "bg-fg text-bg" : "bg-bg-hi text-fg group-hover:bg-bg-sunk"}`}
                    data-screen-tab-box
                  >
                    {t.label}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </header>
  );
}

/**
 * The shell content column: the `screen-x` grid (max width, centred, the gutter plus the side safe
 * areas) with the gutter above and below. Its left edge matches the sky band's mark and crumb.
 */
export function Screen({ className, ...rest }: ComponentPropsWithoutRef<"div">) {
  return <div data-screen className={`screen-x flex w-full flex-col gap-8 py-(--gutter) ${className ?? ""}`} {...rest} />;
}
