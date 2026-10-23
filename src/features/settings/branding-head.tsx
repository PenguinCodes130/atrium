// Server components for instance branding (settings gauntlet w2-r1 item 8), for the shell to mount
// through shared file requests:
//   <BrandingStyle />  in the root layout src/app/layout.tsx (settings r3 SFR, gauntlet w2-r2 item 5), so
//                      every Atrium screen gets the accent override: shell, sign-in, launcher, builder,
//                      the viewer's Atrium button, invite and not-found pages
//   brandingIcons()    in the root layout's generateMetadata: the uploaded favicon, when set
//   brandLogoUrl()     for the top bar mark and the sign-in page: the uploaded logo, when set
//   signInWallpaperUrl() for the sign-in page background
// The CSS holds only palette values (branding.ts), so it cannot style anything but the accent tokens.
import "server-only";
import type { Metadata } from "next";
import { brandingCss, brandUrl, getBranding } from "./branding";

export function BrandingStyle() {
  let css = "";
  try {
    css = brandingCss();
  } catch {
    css = "";
  }
  return css ? <style data-instance-branding>{css}</style> : null;
}

/** The favicon override for Next metadata, or undefined to keep Atrium's own. */
export function brandingIcons(): Metadata["icons"] | undefined {
  try {
    const url = brandUrl("favicon");
    return url ? { icon: [{ url }], apple: [{ url }] } : undefined;
  } catch {
    return undefined;
  }
}

export function brandLogoUrl(): string | null {
  try {
    return brandUrl("logo");
  } catch {
    return null;
  }
}

export function signInWallpaperUrl(): string | null {
  try {
    return brandUrl("sign-in", getBranding());
  } catch {
    return null;
  }
}
