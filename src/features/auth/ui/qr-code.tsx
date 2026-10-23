"use client";
// A QR code drawn locally as SVG (auth gauntlet r1, fix 5). Dark modules on a light plate in both
// themes, because not every authenticator app reads an inverted code: light theme uses --fg on
// --bg-raised, dark theme swaps to --bg on --fg (both near black on near white).
import { useMemo } from "react";
import { encodeQr, qrPath } from "../qr/encode";

const QUIET = 4;

export function QrCode({ value, label, size = 192 }: { value: string; label: string; size?: number }) {
  const { path, units } = useMemo(() => {
    const q = encodeQr(value, "M");
    return { path: qrPath(q, QUIET), units: q.size + QUIET * 2 };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${units} ${units}`}
      shapeRendering="crispEdges"
      className="flex-none rounded-sm border border-line bg-bg-raised fill-fg dark:bg-fg dark:fill-bg"
      data-totp-qr
    >
      <path d={path} />
    </svg>
  );
}
