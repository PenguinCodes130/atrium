// Shell-only screens (sign-in, setup-required, step-up, consent, and the interim /account): no user
// theme, app-shell tokens only. The frame (AuthShell: sky band, lit mark) comes from AuthCard, so a
// management screen can use the wide frame (card.tsx).
import type { ReactNode } from "react";
// Settings r2 SFR (gauntlet w2-r1 item 8): the owner's sign-in wallpaper. The instance accent is mounted
// by the root layout (settings r3 SFR, w2-r2 item 5).
import { signInWallpaperUrl } from "@/features/settings/branding-head";

export const dynamic = "force-dynamic";

export default function AuthLayout({ children }: { children: ReactNode }) {
  const wallpaper = signInWallpaperUrl();
  return (
    <main className="min-h-dvh bg-bg bg-cover bg-center pt-safe pb-safe" style={wallpaper ? { backgroundImage: `url("${wallpaper}")` } : undefined} data-auth-screen {...(wallpaper ? { "data-sign-in-wallpaper": "" } : {})}>
      {children}
    </main>
  );
}
