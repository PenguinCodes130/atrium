import type { ReactNode } from "react";
import { AuthShell, Window } from "@/features/shell";

/**
 * One titled window in the auth frame (sky band, lit mark). A screen with one window uses it as is; a
 * screen with several (the interim /account) wraps them in one <AuthShell> and passes framed={false}.
 * `wide` widens both the frame and the window for management screens.
 */
export function AuthCard({ children, wide = false, title = "atrium / sign in", framed = true }: { children: ReactNode; wide?: boolean; title?: string; framed?: boolean }) {
  const card = (
    <Window title={title} className={`mx-auto w-full ${wide ? "max-w-3xl" : "max-w-[400px]"}`}>
      {children}
    </Window>
  );
  return framed ? <AuthShell wide={wide}>{card}</AuthShell> : card;
}
