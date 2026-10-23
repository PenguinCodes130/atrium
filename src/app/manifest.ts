// Atrium's own web manifest for the shell (spec "Install": Atrium keeps a root manifest). Each app has
// its own at /a/<slug>/manifest.webmanifest.
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Atrium",
    short_name: "Atrium",
    description: "Your homelab, under one roof.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#F3EFE4",
    theme_color: "#F3EFE4",
    icons: [
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
