"use client";
// The signed-in person's name and email for the root not-found room, fetched on the client
// (app-builder final r4 SFR, gauntlet w2-r3 item 2, security). Next renders the root not-found into
// every page's payload, including the app viewer's offline snapshot that a browser keeps; with the user
// passed from the server, every stored copy carried the person's name and email. Now the payload holds
// nothing about who asked, and the account menu fills in only when this room is actually shown.
import { useEffect } from "react";
import { useShell } from "./shell-context";

export function NotFoundAccount() {
  const { setNav } = useShell();
  useEffect(() => {
    let live = true;
    fetch("/api/auth/get-session", { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((s: { user?: { name?: string; email?: string } } | null) => {
        if (live && s?.user?.email) setNav({ user: { name: s.user.name ?? "", email: s.user.email } });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [setNav]);
  return null;
}
