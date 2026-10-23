// Input and output schemas of the spec import routes. Outputs strip unknown fields, so nothing but
// words, counts and ids leaves (criterion 14: no secret value or integration config).
import "server-only";
import { z } from "zod";
import { SPEC_MAX_BYTES } from "./load";

export const previewIn = z.object({
  address: z.string().trim().min(1).max(4096).optional(),
  specUrl: z.string().trim().min(1).max(4096).optional(),
  text: z.string().max(SPEC_MAX_BYTES + 1024, "This spec is larger than 10 MB, the most Atrium reads.").optional(),
});

export const importIn = z.object({
  specId: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(120).optional(),
  baseUrl: z.string().trim().min(1).max(4096).optional(),
  verifyTls: z.boolean().optional(),
  integrationId: z.string().max(100).optional(),
  authKey: z.string().max(200).nullable().optional(),
  secret: z.string().max(8192).optional(),
  basicUser: z.string().max(200).optional(),
  readIds: z.array(z.string().max(100)).max(2000).optional(),
  commands: z.array(z.object({ id: z.string().max(200), risk: z.enum(["low", "medium"]) })).max(500).optional(),
  untested: z.boolean().optional(),
});

const setting = z.object({ key: z.string(), title: z.string(), required: z.boolean(), choices: z.boolean() });
export const previewOut = z.object({
  specId: z.string(),
  specUrl: z.string().optional(),
  title: z.string(), version: z.string(), specVersion: z.string(), basePath: z.string(),
  totals: z.object({ operations: z.number(), gets: z.number(), reads: z.number(), headline: z.number(), commands: z.number(), skipped: z.number() }),
  reads: z.array(z.object({ id: z.string(), label: z.string(), description: z.string().optional(), group: z.string(), headline: z.boolean(), shape: z.string(), path: z.string(), settings: z.array(setting), formats: z.array(z.string()) })),
  commands: z.array(z.object({ id: z.string(), label: z.string(), description: z.string(), method: z.string(), path: z.string(), canAdd: z.boolean(), why: z.string().optional() })),
  auth: z.array(z.object({ key: z.string(), scheme: z.string(), label: z.string(), hint: z.string(), as: z.string(), name: z.string().optional(), needsUser: z.boolean().optional() })),
  unsupportedAuth: z.array(z.string()),
  skipped: z.array(z.object({ method: z.string(), path: z.string(), reason: z.string() })),
});

const check = z.object({ status: z.enum(["ok", "empty", "failed", "odd"]), reason: z.string().optional(), at: z.string() });
export const importOut = z.union([
  z.object({ ok: z.literal(false), heading: z.string(), error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }) }),
  z.object({
    ok: z.literal(true), integrationId: z.string(), added: z.number(),
    skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
    commands: z.object({ added: z.array(z.string()), drafts: z.boolean() }),
    recipe: z.object({ id: z.string(), saved: z.boolean(), problem: z.string().optional() }).optional(),
    check: z.object({ running: z.boolean(), total: z.number(), results: z.record(z.string(), check).optional() }),
  }),
]);
