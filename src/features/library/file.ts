// The component file format (architecture v3 section 4.8): `<name>.atrium-component`, JSON with
// format "atrium-component", formatVersion 1, and the LibraryComponent without createdBy. Pure.
import { z } from "zod";
import type { ComponentNode, LibraryComponent } from "@/core/contracts";

export const COMPONENT_FILE_EXT = ".atrium-component";
export const MAX_COMPONENT_FILE_BYTES = 1024 * 1024;
export const CONTAINS_CODE_NOTICE = "Contains code. It runs in the sandbox and sees only the data you give it.";

const propValue: z.ZodType<unknown> = z.lazy(() => z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(propValue), z.record(z.string(), propValue)]));
const slot = z.strictObject({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
export const nodeSchema: z.ZodType<ComponentNode> = z.lazy(() =>
  z.strictObject({
    id: z.string().min(1).max(64),
    type: z.string().min(1).max(80),
    name: z.string().max(120).optional(),
    props: z.record(z.string(), propValue),
    overrideTheme: z.boolean().optional(),
    style: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    css: z.string().max(65536).optional(),
    slot: slot.optional(),
    responsive: z.strictObject({ mobile: z.strictObject({ slot: slot.optional(), hidden: z.boolean().optional(), props: z.record(z.string(), propValue).optional(), style: z.record(z.string(), z.record(z.string(), z.unknown())).optional() }).optional() }).optional(),
    visibleWhen: z.strictObject({ $bind: z.string().max(2048) }).optional(),
    children: z.array(nodeSchema).max(200).optional(),
    libraryRef: z.strictObject({ componentId: z.string(), version: z.number().int() }).optional(),
  }),
) as unknown as z.ZodType<ComponentNode>;

export const paramSchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,31}$/),
  label: z.string().min(1).max(120),
  kind: z.enum(["data", "text", "number", "color", "control", "boolean"]),
  default: propValue.optional(),
});

export const componentFileSchema = z.strictObject({
  format: z.literal("atrium-component"),
  formatVersion: z.literal(1),
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  description: z.string().max(300).optional(),
  tags: z.array(z.string().max(40)).max(20),
  version: z.number().int().min(1),
  node: nodeSchema,
  params: z.array(paramSchema).max(40),
  containsCode: z.boolean(),
  source: z.enum(["local", "imported"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ComponentFile = z.infer<typeof componentFileSchema>;

/** The export file for a component: everything except its creator. Keys sorted, 2-space indent. */
export function toComponentFile(c: LibraryComponent): string {
  const { createdBy: _omit, ...rest } = c;
  void _omit;
  const file = { format: "atrium-component" as const, formatVersion: 1 as const, ...rest };
  return `${JSON.stringify(sortKeys(file), null, 2)}\n`;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

/** Parses an import, naming the first problem in plain English when it is not a component file. */
export function parseComponentFile(text: string): { ok: true; file: ComponentFile } | { ok: false; problem: string } {
  if (new TextEncoder().encode(text).length > MAX_COMPONENT_FILE_BYTES) return { ok: false, problem: "This file is larger than 1 MB, so it is not a component file." };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, problem: "This file is not valid JSON." };
  }
  if (!json || typeof json !== "object" || (json as { format?: unknown }).format !== "atrium-component") return { ok: false, problem: 'This is not an Atrium component file (its format is not "atrium-component").' };
  if ((json as { formatVersion?: unknown }).formatVersion !== 1) return { ok: false, problem: "This component file was made by a newer Atrium (format version is not 1)." };
  const r = componentFileSchema.safeParse(json);
  if (!r.success) {
    const i = r.error.issues[0]!;
    return { ok: false, problem: `The file's ${i.path.join(".") || "contents"} is not valid: ${i.message}.` };
  }
  return { ok: true, file: r.data };
}
