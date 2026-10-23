"use client";
// Palette fallback (gauntlet r1 quality-bar finding 3): until command-palette ships, Ctrl/Cmd+K, the
// sidebar search hint and the phone Search tab open a working jump list over the destinations the
// shell knows: nav items that have a route, the user's pages and the saved integrations. Arrow keys,
// Home/End and Enter; Esc closes. It opens only when no palette claims the request.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import { useRouter } from "next/navigation";
import { Sheet } from "./sheet";
import { HomeIcon, PageIcon, PlugIcon, PlusIcon, SearchIcon, type IconProps } from "./icons";
import { PALETTE_EVENT } from "./palette-bridge";
import { APPROVALS, AUDIT, INTEGRATIONS, LIBRARY, SETTINGS, USERS_AND_SECURITY_HREF, USERS_AND_SECURITY_LABEL, isAvailable } from "./nav";
import { useShell, type ShellNav } from "./shell-context";

export type JumpItem = { id: string; label: string; group: "Go to" | "Pages" | "Integrations"; href: string; keywords?: string };

/** Live destinations only (Fix 11): nav items that have a route, the user's pages, saved integrations. */
export function jumpItems(nav: ShellNav | null, integrations: { id: string; name: string }[] = []): JumpItem[] {
  const items: JumpItem[] = [{ id: "home", label: "Apps", group: "Go to", href: "/", keywords: "home launcher start" }];
  const keywords: Partial<Record<string, string>> = { settings: "preferences appearance themes backups" };
  for (const n of [INTEGRATIONS, APPROVALS, LIBRARY, AUDIT, SETTINGS]) {
    if (isAvailable(n.key, nav?.routes)) items.push({ id: n.key, label: n.label, group: "Go to", href: n.href, keywords: keywords[n.key] });
  }
  if (isAvailable("settings", nav?.routes)) {
    items.push({ id: "users-and-security", label: USERS_AND_SECURITY_LABEL, group: "Go to", href: USERS_AND_SECURITY_HREF, keywords: "account users allowlist invite reset password security sessions two-factor 2fa authenticator backup codes" });
  }
  if (isAvailable("integrations", nav?.routes)) {
    items.push({ id: "add-integration", label: "Add integration", group: "Go to", href: "/integrations/new", keywords: "connect service new" });
    items.push({ id: "credentials", label: "Credentials", group: "Go to", href: "/integrations/credentials", keywords: "credential token password secret key" });
    items.push({ id: "new-credential", label: "New credential", group: "Go to", href: "/integrations/credentials#new", keywords: "credential token password secret key add" });
  }
  for (const p of nav?.pages ?? []) items.push({ id: `page:${p.id}`, label: p.title, group: "Pages", href: p.href, keywords: "page" });
  for (const i of integrations) items.push({ id: `integration:${i.id}`, label: i.name, group: "Integrations", href: `/integrations/${encodeURIComponent(i.id)}`, keywords: "integration" });
  return items;
}

/** Case-insensitive match on the label (and keywords); label prefix matches rank first. */
export function filterJumpItems(items: JumpItem[], query: string): JumpItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const hits = items.filter((i) => `${i.label} ${i.keywords ?? ""} ${i.group}`.toLowerCase().includes(q));
  return hits.sort((a, b) => Number(!a.label.toLowerCase().startsWith(q)) - Number(!b.label.toLowerCase().startsWith(q)));
}

const iconFor = (item: JumpItem): ((p: IconProps) => ReactElement) =>
  item.group === "Pages" ? PageIcon : item.group === "Integrations" ? PlugIcon : item.id === "home" ? HomeIcon : item.id === "add-integration" ? PlusIcon : PlugIcon;

/** Shown only when no command palette has registered (the real palette ships with command-palette). */
export function PaletteFallback() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [integrations, setIntegrations] = useState<{ id: string; name: string }[]>([]);
  const { nav } = useShell();
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    // Runs after every other listener: if nobody claimed the request, open the fallback.
    const onRequest = (e: Event) => {
      queueMicrotask(() => {
        if (!e.defaultPrevented) setOpen(true);
      });
    };
    window.addEventListener(PALETTE_EVENT, onRequest);
    return () => window.removeEventListener(PALETTE_EVENT, onRequest);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    if (!nav?.user) return; // signed-out screens: no API calls
    // Saved integrations come from Atrium's own API (integrations owns it); failures just hide them.
    const ctl = new AbortController();
    fetch("/api/integrations", { headers: { accept: "application/json" }, signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { integrations?: { id?: unknown; name?: unknown }[] } | null) => {
        const list = Array.isArray(d?.integrations) ? d.integrations : [];
        setIntegrations(list.filter((i): i is { id: string; name: string } => typeof i.id === "string" && typeof i.name === "string").slice(0, 50));
      })
      .catch(() => {});
    return () => ctl.abort();
  }, [open, nav?.user]);

  const results = useMemo(() => filterJumpItems(jumpItems(nav, integrations), query), [nav, integrations, query]);
  const current = Math.min(active, Math.max(0, results.length - 1));

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const go = (item: JumpItem | undefined) => {
    if (!item) return;
    setOpen(false);
    router.push(item.href);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((current + 1) % Math.max(1, results.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((current - 1 + results.length) % Math.max(1, results.length));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(Math.max(0, results.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(results[current]);
    }
  };

  let lastGroup = "";
  return (
    <Sheet open={open} onOpenChange={setOpen} title="Search" description="Jump to a page, an integration or a part of Atrium." name="palette-fallback">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-muted" />
        <input
          autoFocus
          type="search"
          role="combobox"
          aria-label="Search Atrium"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={results[current] ? `${listId}-${current}` : undefined}
          placeholder="Search Atrium"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          data-palette-input
          className="h-11 w-full border border-line-strong bg-bg-hi pr-3 pl-10 type-body text-fg outline-none placeholder:text-fg-3 focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-accent-ink"
        />
      </div>
      <ul ref={listRef} id={listId} role="listbox" aria-label="Destinations" className="mt-3 flex flex-col gap-0.5" data-palette-results>
        {results.map((item, i) => {
          const heading = item.group !== lastGroup ? item.group : null;
          lastGroup = item.group;
          const Icon = iconFor(item);
          return (
            <li key={item.id} role="presentation">
              {heading && (
                <p aria-hidden className="px-3 pt-3 pb-1 type-caption text-glass-muted">
                  {heading}
                </p>
              )}
              <div
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === current}
                data-index={i}
                data-jump={item.id}
                onPointerMove={() => setActive(i)}
                onClick={() => go(item)}
                className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-sm px-3 type-body sm:min-h-9 ${i === current ? "bg-fg text-bg" : "text-fg-2"}`}
              >
                <Icon size={18} className="flex-none" />
                <span className="truncate">{item.label}</span>
              </div>
            </li>
          );
        })}
      </ul>
      {results.length === 0 && (
        <p className="mt-4 type-callout text-glass-muted" data-palette-empty>
          Nothing matches &ldquo;{query.trim()}&rdquo;.
        </p>
      )}
      <p className="mt-4 hidden type-caption text-glass-muted sm:block">Arrow keys to move, Enter to open, Esc to close.</p>
    </Sheet>
  );
}

