"use client";
// Error screen inside the shell frame (app-shell): the frame stays usable around it.
import { useMemo } from "react";
import { ErrorScreen, shortErrorId } from "@/features/shell/system-screens";

export default function ShellError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const id = useMemo(() => shortErrorId(error.digest), [error.digest]);
  return <ErrorScreen errorId={id} onRetry={reset} />;
}
