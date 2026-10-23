// The frame for screens outside the shell that still carry the Atrium look (sign-in, setup required,
// step-up, consent, the guest PIN and expired link screens): the sky band across the top, the 72px lit
// mark with the door glow, and the content (one window) below. No top bar, no navigation.
import type { ReactNode } from "react";
import { Mark } from "./mark";
import { SkyBand } from "./sky-band";

export function AuthShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-dvh w-full flex-col" data-auth-shell>
      <SkyBand showMark={false} />
      <div className={`mx-auto flex w-full flex-1 flex-col items-center px-4 pt-10 pb-16 sm:pt-14 ${wide ? "max-w-3xl" : "max-w-[440px]"}`}>
        <Mark height={72} lit glow title="Atrium" className="mb-10 flex-none" />
        <div className="w-full">{children}</div>
      </div>
    </div>
  );
}
