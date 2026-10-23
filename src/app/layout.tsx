// Root layout (app-shell). Loads the shell tokens and the self-hosted font families.
// next/font/google downloads every family at build time and serves it from /_next/static, so the
// browser never contacts a third-party host (architecture section 13, CSP). Inter Tight (400 to 700)
// and Geist Mono (400, 500) are the design v4 shell families (preloaded). The other eight of the ten
// design v4 theme families (Inter, Geist, IBM Plex Sans, IBM Plex Mono, Fraunces, Space Grotesk,
// JetBrains Mono, Atkinson Hyperlegible) are for user apps: preload is off, so a browser downloads one
// only when an app theme uses it. Uploaded theme fonts are declared by the canvas (themeFontFaces). This layout stays limited to html, body, fonts and providers
// (architecture v3 section 2): the (app) route group renders inside it, never inside the shell.
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Inter, Inter_Tight, Geist_Mono, Geist, IBM_Plex_Sans, IBM_Plex_Mono, Fraunces, Space_Grotesk, JetBrains_Mono, Atkinson_Hyperlegible } from "next/font/google";
import { cookies } from "next/headers";
import { htmlAttributes, readPreferences } from "@/features/shell/preferences";
import { SWEEP_COOKIE } from "@/features/shell/sweep";
import { Toaster } from "@/features/shell/toast";
import { ShellGlobals } from "@/features/shell/globals";
// Settings r3 SFR (gauntlet w2-r2 item 5): the instance accent is mounted once, here, so every Atrium
// screen gets it: the shell, sign-in, the launcher, the builder, the viewer's Atrium button, invite and
// not-found pages. Palette values only (settings branding.ts); a viewed app's canvas sets its own accent.
import { BrandingStyle } from "@/features/settings/branding-head";
import "@/styles/globals.css";

const interTight = Inter_Tight({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-inter-tight", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-geist-mono", display: "swap" });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap", axes: ["opsz"], preload: false });
const geist = Geist({ subsets: ["latin"], variable: "--font-geist", display: "swap", preload: false });
const plexSans = IBM_Plex_Sans({ subsets: ["latin"], weight: "variable", variable: "--font-plex-sans", display: "swap", preload: false });
const fraunces = Fraunces({ subsets: ["latin"], variable: "--font-fraunces", display: "swap", preload: false });
const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-space-grotesk", display: "swap", preload: false });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex-mono", display: "swap", preload: false });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains-mono", display: "swap", preload: false });
const atkinson = Atkinson_Hyperlegible({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-atkinson", display: "swap", preload: false });
const fontVars = [interTight, geistMono, inter, geist, plexSans, plexMono, fraunces, spaceGrotesk, jetbrainsMono, atkinson].map((f) => f.variable).join(" ");

// Settings r2 SFR (gauntlet w2-r1 item 8): the owner's uploaded favicon replaces Atrium's when set.
export async function generateMetadata(): Promise<Metadata> {
  const { brandingIcons } = await import("@/features/settings/branding-head");
  const icons = brandingIcons();
  return icons ? { ...metadata, icons } : metadata;
}

const metadata: Metadata = {
  title: { default: "Atrium", template: "%s · Atrium" },
  description: "Your homelab, under one roof.",
  applicationName: "Atrium",
  icons: {
    icon: [
      { url: "/brand/favicon.svg", type: "image/svg+xml" },
      { url: "/brand/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/brand/favicon-16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [{ url: "/brand/icon-192.png", sizes: "192x192" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // The on-screen keyboard resizes the layout viewport, so a focused field can be scrolled into view.
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F3EFE4" },
    { media: "(prefers-color-scheme: dark)", color: "#15130F" },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  const prefs = readPreferences(jar);
  // The opening sweep plays once per browser session; later loads render lit (session cookie).
  const swept = jar.get(SWEEP_COOKIE)?.value === "1" ? "1" : undefined;
  return (
    <html lang="en" className={fontVars} {...htmlAttributes(prefs)} data-swept={swept} suppressHydrationWarning>
      <body>
        <BrandingStyle />
        {children}
        <Toaster />
        <ShellGlobals />
      </body>
    </html>
  );
}
