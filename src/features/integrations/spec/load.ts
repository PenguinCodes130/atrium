// Turns spec text (JSON or YAML) into a checked OpenAPI 3.x or Swagger 2 document. Pure apart from
// the YAML seam. Refuses anything over 10 MB, anything that is not a spec, and documents whose
// shared references would make walking them blow up (YAML aliases).
import { yamlLoader } from "./yaml";

export const SPEC_MAX_BYTES = 10 * 1024 * 1024;
const MAX_NODES = 3_000_000;

export type SpecDoc = Record<string, unknown>;

export class SpecError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
  }
}

export function isSpec(v: unknown): v is SpecDoc {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const d = v as SpecDoc;
  const version = typeof d.openapi === "string" ? d.openapi : typeof d.swagger === "string" ? d.swagger : undefined;
  return !!version && /^(2\.|3\.[01])/.test(version) && !!d.paths && typeof d.paths === "object";
}

/** "OpenAPI 3.1", "Swagger 2.0". */
export function specVersion(d: SpecDoc): string {
  return typeof d.openapi === "string" ? `OpenAPI ${d.openapi}` : `Swagger ${String(d.swagger)}`;
}

/** Counts nodes as they would be walked (shared references counted each time) and refuses huge expansions. */
function checkSize(v: unknown): void {
  let n = 0;
  const stack: unknown[] = [v];
  while (stack.length) {
    const x = stack.pop();
    if (++n > MAX_NODES) throw new SpecError("This spec is too large or repeats itself too often to read.", "Use the service's plain JSON spec instead.");
    if (x && typeof x === "object") for (const c of Object.values(x as Record<string, unknown>)) if (c && typeof c === "object") stack.push(c);
  }
}

export function looksLikeJson(text: string): boolean {
  return /^\s*[{[]/.test(text);
}

/** Parses JSON or YAML spec text. Throws SpecError with a sentence a person can act on. */
export function parseSpecText(text: string): SpecDoc {
  if (Buffer.byteLength(text, "utf8") > SPEC_MAX_BYTES) throw new SpecError("This spec is larger than 10 MB, the most Atrium reads.");
  const body = text.replace(/^﻿/, "");
  if (!body.trim()) throw new SpecError("The spec is empty.");
  let doc: unknown;
  if (looksLikeJson(body)) {
    try {
      doc = JSON.parse(body);
    } catch {
      throw new SpecError("The spec is not valid JSON.", "Check the file, or paste the address it is served at.");
    }
  } else {
    const load = yamlLoader();
    if (!load) throw new SpecError("This spec is YAML, and this Atrium cannot read YAML yet.", "Use the JSON form of the spec (many services serve both).");
    try {
      doc = load(body);
    } catch (err) {
      const why = err instanceof Error ? err.message.split("\n")[0]!.slice(0, 200) : "";
      throw new SpecError(`The spec is not valid YAML${why ? `: ${why}` : ""}.`);
    }
  }
  if (!isSpec(doc)) throw new SpecError("This is not an OpenAPI or Swagger spec.", "A spec has an \"openapi\" (3.0 or 3.1) or \"swagger\" (2.0) field and a \"paths\" list.");
  checkSize(doc);
  return doc;
}
