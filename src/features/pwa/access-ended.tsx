"use client";
// Rendered with the "this link has ended" screen of an app viewer address (gauntlet w2-r3 item 1,
// security). The answer itself is a 404, which makes the app's worker forget its caches; this also
// forgets them from the page (and the last values, which only a page can reach), so nothing of the app
// stays in this browser for offline use even when no worker is running.
import { useEffect } from "react";
import { appSlugOf, forgetAppOffline } from "./offline";

/** Marks a page that ends this browser's access to an app. */
export const ACCESS_ENDED_MARKER = "data-atrium-access-ended";

export function AccessEnded() {
  useEffect(() => {
    const slug = appSlugOf(window.location.pathname);
    if (!slug) return;
    void forgetAppOffline(slug);
    try {
      navigator.serviceWorker?.controller?.postMessage({ type: "atrium-forget" });
    } catch {
      /* no worker */
    }
  }, []);
  return <div hidden {...{ [ACCESS_ENDED_MARKER]: "" }} />;
}
