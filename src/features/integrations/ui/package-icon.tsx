// Package icons: simple line glyphs drawn in currentColor, one per official package.
const PATHS: Record<string, string> = {
  prometheus: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-4 12h8M9 17.5h6M8 13c1-3 2-4 4-7 1 2 1 3 0 5 2-1 3-2 4-1-1 1-1 2-4 3",
  npm: "M4 7h16v10H4zM8 7v10M4 12h4m4-2h4m-4 4h4",
  pfsense: "M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6l-8-3Zm-3 9h6m-3-3v6",
  rss: "M5 19a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16",
  proxmox: "M4 5h16v6H4zM4 13h16v6H4zM7 8h.01M7 16h.01M11 8h6M11 16h6",
  docker: "M3 12h17c-.5 4-4 7-9 7-4.5 0-7-3-8-7Zm3-3h3v3H6zm3 0h3v3H9zm3 0h3v3h-3zm-3-3h3v3H9zm3 0h3v3h-3zm8 4c.5-1 1.5-1.5 2-1.5",
  "uptime-kuma": "M3 12h4l2-5 4 10 2-5h6",
  "home-assistant": "M3 11 12 4l9 7M5 9.5V20h14V9.5M12 20v-5m0 0-2.5-2.5M12 15l2.5-2.5M12 12a1 1 0 1 0 0-.01",
  "custom-api": "M8 7 3 12l5 5m8-10 5 5-5 5M14 5l-4 14",
};

export function PackageIcon({ id, size = 28 }: { id: string; size?: number }) {
  const d = PATHS[id] ?? "M5 5h14v14H5zM9 9h6v6H9z";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="shrink-0 text-accent-ink" data-package-icon={id}>
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
