// Shell appearance preferences: light or dark override, in-app reduced motion, reduce transparency.
// Round 1 stores them in browser cookies so the server can render the right <html> attributes on the
// first paint with no inline script (CSP). Settings will take over persistence later; it only needs
// to call applyPreferences() and keep these cookie names, or replace readPreferences().

export type ThemePreference = "system" | "light" | "dark";
export type Preferences = {
  theme: ThemePreference;
  reducedMotion: boolean; // the in-app switch only; the system setting is honoured separately
  reduceTransparency: boolean; // the in-app switch only
};

export const PREF_COOKIES = {
  theme: "atrium_theme",
  motion: "atrium_motion",
  transparency: "atrium_transparency",
} as const;

export const DEFAULT_PREFERENCES: Preferences = { theme: "system", reducedMotion: false, reduceTransparency: false };

type CookieReader = { get(name: string): { value: string } | undefined };

export function readPreferences(cookies: CookieReader): Preferences {
  const theme = cookies.get(PREF_COOKIES.theme)?.value;
  return {
    theme: theme === "light" || theme === "dark" ? theme : "system",
    reducedMotion: cookies.get(PREF_COOKIES.motion)?.value === "reduce",
    reduceTransparency: cookies.get(PREF_COOKIES.transparency)?.value === "reduce",
  };
}

// The attributes tokens.css and globals.css key on.
export function htmlAttributes(p: Preferences): Record<string, string | undefined> {
  return {
    "data-theme": p.theme === "system" ? undefined : p.theme,
    "data-motion": p.reducedMotion ? "reduce" : undefined,
    "data-transparency": p.reduceTransparency ? "reduce" : undefined,
  };
}

// Client side: write the cookies and update <html> without a reload.
export function applyPreferences(p: Preferences): void {
  if (typeof document === "undefined") return;
  const year = 60 * 60 * 24 * 365;
  const set = (name: string, value: string | undefined) => {
    document.cookie = value
      ? `${name}=${value}; Path=/; Max-Age=${year}; SameSite=Lax`
      : `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
  };
  set(PREF_COOKIES.theme, p.theme === "system" ? undefined : p.theme);
  set(PREF_COOKIES.motion, p.reducedMotion ? "reduce" : undefined);
  set(PREF_COOKIES.transparency, p.reduceTransparency ? "reduce" : undefined);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(htmlAttributes(p))) {
    if (v === undefined) root.removeAttribute(k);
    else root.setAttribute(k, v);
  }
  window.dispatchEvent(new CustomEvent("atrium:preferences", { detail: p }));
}

export function readPreferencesFromDocument(): Preferences {
  if (typeof document === "undefined") return DEFAULT_PREFERENCES;
  const root = document.documentElement;
  const t = root.getAttribute("data-theme");
  return {
    theme: t === "light" || t === "dark" ? t : "system",
    reducedMotion: root.getAttribute("data-motion") === "reduce",
    reduceTransparency: root.getAttribute("data-transparency") === "reduce",
  };
}

// Pure mapping used by hooks and unit tests: the in-app switch OR the system setting.
export function effectiveReducedMotion(systemReduce: boolean, inApp: boolean): boolean {
  return systemReduce || inApp;
}
export function effectiveReduceTransparency(systemReduce: boolean, inApp: boolean, supportsBlur: boolean): boolean {
  return systemReduce || inApp || !supportsBlur;
}
