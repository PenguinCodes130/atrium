"use client";
// Account menu (top bar, right). Radix DropdownMenu drawn as a small window (3px hard shadow).
import Link from "next/link";
import { DropdownMenu } from "radix-ui";
import { motion } from "motion/react";
import { transitionFor } from "./motion";
import { useReducedMotion } from "./use-preferences";
import { usePreferences } from "./use-preferences";
import { SettingsIcon, UserIcon } from "./icons";
import { useShell } from "./shell-context";
import type { ThemePreference } from "./preferences";
import { USERS_AND_SECURITY_HREF, USERS_AND_SECURITY_LABEL } from "./nav";

/**
 * Forgets what this browser kept of apps for offline use (app-builder gauntlet w2-r2 item 1, security):
 * the app workers' caches (`atrium-app:*`, and legacy `atrium-app-*`), the app workers themselves (scopes under /a/), and the last
 * values published pages saved (`atrium:last*`). Runs before the sign-out request, so it also works on a
 * plain-HTTP LAN address where browsers ignore the server's Clear-Site-Data. Never throws.
 */
export async function forgetOfflineApps(): Promise<void> {
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith("atrium:last")) keys.push(k);
    }
    for (const k of keys) window.localStorage.removeItem(k);
  } catch {
    /* storage blocked */
  }
  try {
    if ("caches" in window) for (const k of await caches.keys()) if (k.startsWith("atrium-app:") || k.startsWith("atrium-app-")) await caches.delete(k);
  } catch {
    /* Cache Storage unavailable */
  }
  try {
    const regs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
    await Promise.all(regs.filter((r) => new URL(r.scope).pathname.startsWith("/a/")).map((r) => r.unregister()));
  } catch {
    /* no service workers */
  }
}

export async function signOut() {
  try {
    await forgetOfflineApps();
    await fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  } finally {
    window.location.assign("/sign-in");
  }
}

const item =
  "flex min-h-9 cursor-pointer select-none items-center gap-2 px-2 type-body text-fg outline-none data-[highlighted]:bg-fg data-[highlighted]:text-bg touch:min-h-11";

export function initialsFor(name: string | undefined, email: string | undefined): string {
  const src = (name || email || "?").trim();
  const parts = src.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function AccountMenu({ compact = true }: { compact?: boolean }) {
  const { nav } = useShell();
  const [prefs, setPrefs] = usePreferences();
  const reduced = useReducedMotion();
  const user = nav.user;
  const label = user?.name || user?.email || "Account";
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={compact ? `Account: ${label}` : undefined}
          data-account-trigger
          className={
            compact
              ? "inline-flex size-11 cursor-pointer items-center justify-center"
              : "flex h-11 w-full cursor-pointer items-center gap-3 px-2 text-left hover:bg-bg-sunk"
          }
        >
          <span aria-hidden className="inline-flex size-8 flex-none items-center justify-center rounded-full bg-fg type-label font-medium text-bg">
            {user ? initialsFor(user.name, user.email) : <UserIcon size={16} />}
          </span>
          {!compact && <span className="min-w-0 flex-1 truncate type-callout text-fg">{label}</span>}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content side="bottom" align="end" sideOffset={8} asChild>
          <motion.div
            className="z-50 min-w-60 border border-line-strong bg-bg-hi p-1.5 text-fg shadow-window-sm"
            data-account-menu
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={transitionFor("pop", reduced)}
          >
          {user?.email && <DropdownMenu.Label className="px-2 py-1.5 type-label text-fg-2">{user.email}</DropdownMenu.Label>}
          <DropdownMenu.Label className="px-2 pt-1.5 pb-1 type-caption text-fg-3">Appearance</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={prefs.theme} onValueChange={(v) => setPrefs({ theme: v as ThemePreference })}>
            {(["system", "light", "dark"] as const).map((t) => (
              <DropdownMenu.RadioItem key={t} value={t} className={item} onSelect={(e) => e.preventDefault()}>
                <span aria-hidden className="inline-flex w-4 justify-center">
                  <DropdownMenu.ItemIndicator>
                    <span className="block size-1.5 rounded-full bg-current" />
                  </DropdownMenu.ItemIndicator>
                </span>
                {t === "system" ? "Match system" : t === "light" ? "Light" : "Dark"}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <DropdownMenu.CheckboxItem className={item} checked={prefs.reducedMotion} onCheckedChange={(v) => setPrefs({ reducedMotion: v === true })} onSelect={(e) => e.preventDefault()}>
            <span aria-hidden className="inline-flex w-4 justify-center">
              <DropdownMenu.ItemIndicator>✓</DropdownMenu.ItemIndicator>
            </span>
            Reduce motion
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.CheckboxItem
            className={item}
            checked={prefs.reduceTransparency}
            onCheckedChange={(v) => setPrefs({ reduceTransparency: v === true })}
            onSelect={(e) => e.preventDefault()}
          >
            <span aria-hidden className="inline-flex w-4 justify-center">
              <DropdownMenu.ItemIndicator>✓</DropdownMenu.ItemIndicator>
            </span>
            Reduce transparency
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          {/* auth's panels, mounted by settings (A4.4): one name, "Users and security". */}
          <DropdownMenu.Item asChild className={item}>
            <Link href={USERS_AND_SECURITY_HREF} data-account-link>
              <SettingsIcon size={16} /> {USERS_AND_SECURITY_LABEL}
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item className={item} onSelect={() => void signOut()}>
            Sign out
          </DropdownMenu.Item>
          </motion.div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
