// Title bar paths (design v4 "Windows": the title as a readable path, never an id). Pure, so server
// components and client components can both use them.

/** A readable path segment from a name: lowercase words joined by hyphens (never an id). */
export function slugOf(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "untitled";
}

/** A package id as a title bar segment: the last part of a declarative id (`me/home-api` reads `home-api`). */
export function packageSegment(packageId: string): string {
  return packageId.split("/").at(-1) ?? packageId;
}

/** The title bar path of a saved integration (design v4 "Windows"): `integrations / <package> · <name slug>`. */
export function integrationPath(i: { packageId: string; name: string }, ...rest: string[]): string {
  return [`integrations / ${packageSegment(i.packageId)} · ${slugOf(i.name)}`, ...rest].join(" / ");
}
