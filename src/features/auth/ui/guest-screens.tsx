// Guest link screens (design v4 "Guest and App Views"): the shell's sky band and one window. Used by
// /g/expired, the PIN step, and (through app-builder) /a/<slug> when a guest session has ended.
// Text sits in the window body (--bg-hi), never on the sky or gold fill, so every pair keeps 4.5:1.
import type { ReactNode } from "react";
import { SkyBand, Window } from "@/features/shell";
import { EXPIRED_TEXT } from "../guest/policy";

/**
 * The shell's sky band (static: a guest screen is a calm, still page; the lit mark stands on its lower
 * edge) and a single centred window.
 */
export function GuestScreen({ title, children, live = false }: { title: string; children: ReactNode; live?: boolean }) {
  return (
    <div className="min-h-dvh bg-bg text-fg" data-guest-screen>
      <SkyBand force="static" />
      <main className="mx-auto flex w-full max-w-[440px] flex-col px-4 pt-16 pb-12 pb-safe">
        <Window title={title} live={live}>
          {children}
        </Window>
      </main>
    </div>
  );
}

/** The one screen every dead or ended guest link shows: no detail and nothing to click. */
export function GuestExpiredScreen() {
  return (
    <GuestScreen title="atrium / guest link">
      <p className="type-body-lg text-fg" data-guest-expired>
        {EXPIRED_TEXT}
      </p>
    </GuestScreen>
  );
}
