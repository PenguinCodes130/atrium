"use client";
// Last-resort error screen when the root layout itself fails (app-shell). It replaces the root
// layout, so it loads the stylesheet again.
import { useMemo } from "react";
import { ErrorScreen, shortErrorId } from "@/features/shell/system-screens";
import "@/styles/globals.css";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const id = useMemo(() => shortErrorId(error.digest), [error.digest]);
  return (
    <html lang="en">
      <body>
        <main className="flex min-h-dvh flex-col">
          <ErrorScreen errorId={id} onRetry={reset} />
        </main>
      </body>
    </html>
  );
}
