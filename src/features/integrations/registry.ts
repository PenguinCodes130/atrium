// The package registry (spec 3.1): loads the official packages, Custom API and saved declarative
// packages. A package that fails validation is skipped and listed as a problem; the rest load.
import type { Adapter, CustomCommand, CustomEndpoint, PackageManifest, PackageProblem } from "@/core/contracts";
import { createGenericAdapter } from "@/packages/declarative/runner";
import { validateManifest } from "./manifest";
import type { OfficialEntry } from "./official";

export type PackageSource = PackageProblem["source"];
export type LoadedPackage = {
  manifest: PackageManifest;
  source: PackageSource;
  /** Declarative packages: their endpoint records. */
  declarativeEndpoints?: CustomEndpoint[];
  /** Declarative packages: their published command records (commands.json). */
  declarativeCommands?: CustomCommand[];
  status?: "draft" | "active";
  /** Builds the adapter; Custom API passes the integration's own endpoints. */
  adapterFor(customEndpoints: CustomEndpoint[]): Adapter;
};

export type DeclarativeRow = { id: string; manifest: unknown; endpoints: unknown; commands?: unknown; status: "draft" | "active" };

export type ProblemSink = {
  /** Records a problem; returns true the first time this exact problem is seen (so one alert is sent). */
  record(p: PackageProblem): boolean;
  /** Marks problems that were not seen in this load as resolved. */
  resolveOthers(seen: PackageProblem[]): void;
};

export type Registry = { packages: Map<string, LoadedPackage>; order: string[]; problems: PackageProblem[] };

export function buildRegistry(
  official: OfficialEntry[],
  declarative: DeclarativeRow[],
  sink: ProblemSink,
  alert: (p: PackageProblem) => void,
  now: () => Date = () => new Date(),
): Registry {
  const packages = new Map<string, LoadedPackage>();
  const order: string[] = [];
  const problems: PackageProblem[] = [];
  const problem = (packageId: string, source: PackageSource, reason: string) => {
    const p: PackageProblem = { packageId: packageId || "(no id)", source, reason, at: now().toISOString() };
    problems.push(p);
    if (sink.record(p)) alert(p);
  };
  const idOf = (m: unknown) => (m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string" ? (m as { id: string }).id : "");

  for (const entry of official) {
    const id = idOf(entry.manifest);
    const v = validateManifest(entry.manifest, { hasAdapter: true, source: "official" });
    if (!v.ok) { problem(id, "official", v.reason); continue; }
    if (packages.has(v.manifest.id)) { problem(id, "official", `package id "${id}" is already taken`); continue; }
    const adapter = entry.adapter;
    packages.set(v.manifest.id, {
      manifest: v.manifest,
      source: "official",
      adapterFor: (eps) => (typeof adapter === "function" ? adapter(eps) : adapter),
    });
    order.push(v.manifest.id);
  }
  for (const row of declarative) {
    const id = idOf(row.manifest) || row.id;
    const v = validateManifest(row.manifest, { hasAdapter: false, source: "declarative", declarativeEndpoints: row.endpoints, declarativeCommands: row.commands ?? [] });
    if (!v.ok) { problem(id, "declarative", v.reason); continue; }
    if (v.manifest.kind !== "declarative") { problem(id, "declarative", "a saved package must be declarative"); continue; }
    if (packages.has(v.manifest.id)) { problem(id, "declarative", `package id "${id}" is already taken`); continue; }
    const endpoints = row.endpoints as CustomEndpoint[];
    const commands = (row.commands ?? []) as CustomCommand[];
    packages.set(v.manifest.id, { manifest: v.manifest, source: "declarative", declarativeEndpoints: endpoints, declarativeCommands: commands, status: row.status, adapterFor: () => createGenericAdapter(endpoints) });
    order.push(v.manifest.id);
  }
  sink.resolveOthers(problems);
  return { packages, order, problems };
}

/** Gallery list: official packages in order, Custom API last; declarative packages are listed separately. */
export function galleryOrder(r: Registry): LoadedPackage[] {
  const official = r.order.map((id) => r.packages.get(id)!).filter((p) => p.source === "official");
  const custom = official.filter((p) => p.manifest.id === "custom-api");
  return [...official.filter((p) => p.manifest.id !== "custom-api"), ...custom];
}
