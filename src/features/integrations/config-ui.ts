// Pure helpers for rendering a package's config schema on the setup screen: enum choices with
// labels, fields shown only for one choice (Prometheus "Login"), and which secret fields apply.
export type ConfigProp = {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  format?: string;
  enum?: unknown[];
  "x-atrium-labels"?: Record<string, string>;
  "x-atrium-secrets"?: Record<string, string[]>;
  "x-atrium-show-when"?: Record<string, string>;
};

export function propsOf(schema: unknown): Record<string, ConfigProp> {
  return ((schema as { properties?: Record<string, ConfigProp> } | undefined)?.properties ?? {}) as Record<string, ConfigProp>;
}

/** False when the property only applies to another choice of a sibling setting. */
export function isShown(p: ConfigProp, config: Record<string, unknown>, props: Record<string, ConfigProp>): boolean {
  const when = p["x-atrium-show-when"];
  if (!when) return true;
  return Object.entries(when).every(([k, v]) => String(config[k] ?? props[k]?.default ?? "") === v);
}

/** The secret keys that apply to this config (see requiredSecretKeys on the server). */
export function secretKeysFor(schema: unknown, config: Record<string, unknown>, all: string[]): Set<string> {
  const props = propsOf(schema);
  const optional = new Set<string>();
  const needed = new Set<string>();
  for (const [key, p] of Object.entries(props)) {
    const map = p["x-atrium-secrets"];
    if (!map) continue;
    for (const keys of Object.values(map)) for (const k of keys) optional.add(k);
    for (const k of map[String(config[key] ?? p.default ?? "")] ?? []) needed.add(k);
  }
  return new Set(all.filter((k) => !optional.has(k) || needed.has(k)));
}

/** The origin a typed address points at, or undefined when it is not a valid http(s) address. */
export function originOf(address: string): string | undefined {
  try {
    const u = new URL(address);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : undefined;
  } catch {
    return undefined;
  }
}
