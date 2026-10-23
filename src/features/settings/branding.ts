// Instance branding (settings gauntlet w2-r1 item 8). The owner picks an instance accent from the shell's
// own palette, and uploads a logo, a favicon and a sign-in wallpaper through the upload sanitiser. No free
// shell CSS: the accent is one of the named palette entries below (each with light and dark values that
// keep the shell's contrast), and images are /uploads/ files whose type came from their bytes. The shell
// layout, root layout and sign-in page read this through shared file requests (see the r2 build report).
// Branding images are served to anyone (they show on the sign-in page) at /uploads/brand/<slot>.
import "server-only";
import { getInstanceSettings, type InstanceSettings } from "./store";
export { BRAND_ACCENTS, BRAND_ACCENT_IDS, type BrandAccentId } from "./branding-palette";
import { BRAND_ACCENTS, type BrandAccentId } from "./branding-palette";

export type BrandSlot = "logo" | "favicon" | "sign-in";
export type Branding = { accent: BrandAccentId | null; logo: string | null; favicon: string | null; signInWallpaper: string | null };

export function getBranding(s: InstanceSettings = getInstanceSettings()): Branding {
  return { accent: s.brandAccent, logo: s.brandLogo, favicon: s.brandFavicon, signInWallpaper: s.signInWallpaper };
}

/** The upload file behind a public branding slot, or null. */
export function brandFile(slot: BrandSlot, b: Branding = getBranding()): string | null {
  const path = slot === "logo" ? b.logo : slot === "favicon" ? b.favicon : b.signInWallpaper;
  return path ? path.slice("/uploads/".length) : null;
}

/** The public address of a branding image (cache-busted by its file name), or null when unset. */
export function brandUrl(slot: BrandSlot, b: Branding = getBranding()): string | null {
  const f = brandFile(slot, b);
  return f ? `/uploads/brand/${slot}?v=${f.slice(0, 8)}` : null;
}

/**
 * The shell accent override as CSS custom properties, or "" for the default gold. Only palette values
 * ever reach this string, so it cannot carry anything else (shell containment holds).
 */
export function brandingCss(b: Branding = getBranding()): string {
  if (!b.accent || b.accent === "gold") return "";
  const a = BRAND_ACCENTS[b.accent];
  const light = `--accent:${a.light.accent};--accent-hi:${a.light.hi};--accent-fg:${a.light.fg};--accent-ink:${a.light.ink};`;
  const dark = `--accent:${a.dark.accent};--accent-hi:${a.dark.hi};--accent-fg:${a.dark.fg};--accent-ink:${a.dark.ink};`;
  // No quotes or angle brackets: React writes this as the text of a <style> element.
  return `:root{${light}}@media (prefers-color-scheme: dark){:root:not([data-theme=light]){${dark}}}:root[data-theme=dark]{${dark}}`;
}
