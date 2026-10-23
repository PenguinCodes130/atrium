// Turns an OpenAPI 3.0/3.1 or Swagger 2 document into EndpointSummary rows for detection and the
// agent's docs lookup. Since Wave 2.8 (spec import v2) this is a view of spec/import.ts: every
// operation is considered, only GET calls are listed (headline reads first), nothing is cut off in
// spec order. Pure.
import type { EndpointSummary } from "@/core/contracts";
import { importSpec } from "./spec/import";
import { isSpec, type SpecDoc } from "./spec/load";

/** Where services publish their spec (research 2.2), JSON and YAML. Detection probes each one. */
export const OPENAPI_PATHS = [
  "/openapi.json", "/openapi.yaml", "/swagger.json", "/swagger.yaml",
  "/swagger/v1/swagger.json", "/v3/api-docs", "/api-docs", "/api-docs/openapi.json",
  "/api/openapi.json", "/api/v1/openapi.yaml", "/api/docs", "/api/schema", "/docs/openapi.json",
];

export function isOpenApi(v: unknown): v is SpecDoc {
  return isSpec(v);
}

/** Path settings back in spec form: "/api/x/{{ params.id }}" -> "/api/x/{id}". */
function specPath(path: string): string {
  return path.replace(/\{\{\s*params\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, "{$1}");
}

export function parseOpenApi(doc: SpecDoc): EndpointSummary[] {
  return importSpec(doc).reads.map((r) => ({
    method: "GET" as const,
    path: specPath(r.path),
    summary: r.label,
    ...(r.params ? { params: r.params } : {}),
    suggestedShape: r.shape,
  }));
}

export function openApiTitle(doc: SpecDoc): string {
  const info = doc.info as Record<string, unknown> | undefined;
  return typeof info?.title === "string" ? info.title : "API";
}
