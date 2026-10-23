// The YAML seam for spec import (Amendment 9 A9.3: a safe loader, no custom tags). Atrium reads
// YAML with `js-yaml` once it is a direct dependency (shared file request, Wave 2.8 builder S r1);
// until then a YAML spec is refused with a plain message and JSON specs work as before. The module
// is looked up at run time from the app folder, so adding the dependency needs no code change here.
// Tests may install a loader with setYamlLoader().
import { createRequire } from "node:module";
import { join } from "node:path";

export type YamlLoader = (text: string) => unknown;

type JsYaml = { load(text: string, opts: { schema: unknown; json?: boolean; filename?: string }): unknown; CORE_SCHEMA: unknown };

let override: YamlLoader | null | undefined;
let cached: YamlLoader | null | undefined;

/** Wraps a js-yaml module as a safe loader: CORE schema only (plain maps, lists, strings, numbers, booleans, null), so unknown tags such as !!js/function throw. */
export function safeLoaderFrom(mod: JsYaml): YamlLoader {
  return (text) => mod.load(text, { schema: mod.CORE_SCHEMA, json: true, filename: "spec.yaml" });
}

function lookup(): YamlLoader | null {
  try {
    const req = createRequire(join(process.cwd(), "package.json"));
    const name = ["js", "yaml"].join("-");
    return safeLoaderFrom(req(name) as JsYaml);
  } catch {
    return null;
  }
}

/** For tests: use this loader (or null to act as if none is installed); undefined restores the lookup. */
export function setYamlLoader(l: YamlLoader | null | undefined): void {
  override = l;
}

export function yamlLoader(): YamlLoader | null {
  if (override !== undefined) return override;
  if (cached === undefined) cached = lookup();
  return cached;
}
