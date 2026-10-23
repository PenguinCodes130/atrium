// The empty room (design v4 section 4, "Empty rooms"): a full-width sky block with the 96px lit mark
// and its door glow (the doorway is the light source), a display line, one lead sentence and two
// buttons. Presets:
//   launcher  "Build your first app." / "Start from a template, or ask an agent to build one."
//             Primary "New app", Secondary "Start from a template"
//   page      "This room is waiting for light." / "Add a component to bring live data onto this page."
//             Primary "Add a component", Secondary "Start from a template"
//   missing   "This room does not exist." with "Go to Apps" (the not-found screen)
// Text on the sky fill is only primary or secondary text (design v4 section 6).
import type { ReactNode } from "react";
import { Mark } from "./mark";

export const ROOM_COPY = {
  launcher: { title: "Build your first app.", body: "Start from a template, or ask an agent to build one.", primary: "New app", secondary: "Start from a template" },
  page: { title: "This room is waiting for light.", body: "Add a component to bring live data onto this page.", primary: "Add a component", secondary: "Start from a template" },
  missing: { title: "This room does not exist.", body: null, primary: "Go to Apps", secondary: null },
} as const;

type EmptyRoomProps = {
  title?: ReactNode;
  body?: ReactNode;
  /** Buttons, in order. The first should be the one primary. */
  actions?: ReactNode;
  footer?: ReactNode;
  headingLevel?: 1 | 2;
  /** A mono tag above the mark, for example "[00] apps". */
  tag?: ReactNode;
  className?: string;
  /** @deprecated v3 (the dim room); ignored. */
  dim?: boolean;
};

export function EmptyRoom({ title = ROOM_COPY.page.title, body = ROOM_COPY.page.body, actions, footer, headingLevel = 2, tag, className }: EmptyRoomProps) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <section
      data-empty-room
      className={`grain relative flex w-full flex-1 flex-col justify-center overflow-hidden bg-sky py-16 sm:py-20 ${className ?? ""}`}
      // The sky settles into the paper floor at the bottom.
      style={{ backgroundImage: "linear-gradient(to bottom, var(--sky) 0%, var(--sky) 45%, color-mix(in srgb, var(--sky) 55%, var(--bg)) 80%, color-mix(in srgb, var(--sky) 25%, var(--bg)) 100%)" }}
    >
      {/* The doorway is the light source: a pale-gold pool of light around the mark, and a wider glow. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(28% 46% at calc(max(0px, (100% - var(--screen-max)) / 2) + var(--gutter) + 72px) 34%, color-mix(in srgb, var(--accent-hi) 80%, transparent) 0%, transparent 72%), " +
            "radial-gradient(60% 90% at 100% 0%, color-mix(in srgb, var(--accent-hi) 45%, transparent) 0%, transparent 70%)",
        }}
        data-room-light
      />
      {/* The shell content column: the room's mark and line sit on the sky band's left edge (Fix 5). */}
      <div className="screen-x relative z-[2] flex flex-col items-start" data-room-column>
        <div className="flex max-w-[880px] flex-col items-start">
        {tag && <div className="mb-6">{tag}</div>}
        <Mark height={96} lit glow className="mb-8 sm:mb-10" />
        <Heading className="type-display text-fg" data-room-title>
          {title}
        </Heading>
        {body && (
          <p className="mt-5 max-w-[34ch] type-body-lg text-fg-2 dark:text-fg" data-room-body>
            {body}
          </p>
        )}
        {actions && <div className="mt-8 flex flex-wrap items-center gap-3">{actions}</div>}
        {footer}
        </div>
      </div>
    </section>
  );
}

/** @deprecated v3 illustration; the v4 empty room uses the lit mark. Kept so old imports compile. */
export function RoomIllustration({ className }: { dim?: boolean; className?: string }) {
  return <Mark height={96} lit glow className={className} />;
}
