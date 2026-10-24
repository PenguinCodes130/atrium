// Agent tools for integrations and packages (architecture v2 section 9b). The registry (Wave 3)
// imports these arrays. No tool returns a secret, a header or a response body, and every write
// lands as a draft that only the user can publish.
import "server-only";
import { z } from "zod";
import type { ToolDef } from "@/core/contracts";
import { env } from "@/core/env";
import { readThrough } from "@/features/data/runtime";
import { detect } from "./detect";
import { lookupDocs } from "./docs";
import { HostError } from "./host/errors";
import { addCommand, listCommands } from "./commands";
import { customCommandSchema, customEndpointSchema } from "./manifest";
import { galleryOrder } from "./registry";
import { getIntegrationRow } from "./repo";
import { endpointsOf, getRegistry } from "./runtime";
import * as svc from "./service";
import { credentialPicksInput, credentialTools } from "./credentials/tools";
import { buildCatalogue, mayUseCatalogue, peek } from "@/features/data/catalogue";
import { catalogueOut, peekIn, peekOut } from "./api";
import { MEASURES } from "./manifest";

const shape = z.enum(["stat", "series", "table", "status"]);
const healthOut = z.object({ status: z.enum(["ok", "degraded", "down"]), latencyMs: z.number(), version: z.string().optional(), message: z.string().optional() });
const summaryOut = z.object({
  id: z.string(), name: z.string(), packageId: z.string(), status: z.enum(["draft", "active", "disabled"]), untested: z.boolean(), locked: z.boolean(),
  secrets: z.array(z.object({ key: z.string(), set: z.boolean(), credentialId: z.string().optional() })),
  lastHealth: healthOut.extend({ checkedAt: z.string() }).optional(),
});
const endpointSummary = z.object({ method: z.enum(["GET", "POST"]), path: z.string(), summary: z.string().optional(), params: z.record(z.string(), z.unknown()).optional(), suggestedShape: shape.optional() });
const toSummary = (v: svc.IntegrationView) => summaryOut.parse({ ...v, secrets: v.secrets.map((s) => ({ key: s.key, set: s.set, ...(s.credentialId ? { credentialId: s.credentialId } : {}) })) });

function hostSafe<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err) => {
    if (err instanceof HostError) throw new Error(`${err.adapterError.message}${err.adapterError.hint ? ` ${err.adapterError.hint}` : ""}`);
    throw err;
  });
}

const read = { scope: "atrium:read" as const, effect: "none" as const, surfaces: ["palette", "builtin-agent", "mcp"] as ("palette" | "builtin-agent" | "mcp")[], minRole: "viewer" as const };
const edit = { scope: "atrium:edit" as const, surfaces: ["builtin-agent", "mcp"] as ("palette" | "builtin-agent" | "mcp")[], minRole: "member" as const };

// Each tool has its own input type; the registry treats them uniformly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const integrationTools: ToolDef<any, any>[] = [
  {
    name: "integrations.list", title: "List integrations", ...read,
    description: "Lists the connected services with their package, status (draft, active, disabled), last health check and which secret fields are set. Never returns secret values.",
    input: z.object({}), output: z.object({ integrations: z.array(summaryOut) }),
    async handler({ principal }) { return { integrations: svc.listIntegrations(principal).map(toSummary) }; },
  },
  {
    name: "integrations.endpoints", title: "List an integration's endpoints", ...read,
    description: "Lists the endpoints an integration can read, with their shape (stat, series, table, status), parameters and refresh limits.",
    input: z.object({ integrationId: z.string() }),
    output: z.object({ endpoints: z.array(z.object({ id: z.string(), label: z.string(), description: z.string(), shape, defaultRefreshSec: z.number(), minRefreshSec: z.number(), params: z.record(z.string(), z.unknown()).optional() })) }),
    async handler({ principal }, i: { integrationId: string }) { return { endpoints: svc.listEndpoints(principal, i.integrationId) }; },
  },
  {
    name: "data.read", title: "Read data", ...read,
    description: "Reads one endpoint through Atrium's shared cache and returns shaped data (stat, series, table or status) with its state. Never returns configs or secrets.",
    input: z.object({ integrationId: z.string(), endpointId: z.string(), params: z.record(z.string(), z.unknown()).optional() }),
    output: z.object({ state: z.enum(["fresh", "stale", "failed", "empty"]), data: z.unknown().optional(), fetchedAt: z.string().optional(), error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }).optional() }),
    async handler(_ctx, i: { integrationId: string; endpointId: string; params?: Record<string, unknown> }) {
      const row = getIntegrationRow(i.integrationId);
      const ep = row ? endpointsOf(row).find((e) => e.id === i.endpointId) : undefined;
      if (!row || !ep) throw new Error("That integration or endpoint does not exist.");
      const d = await readThrough({ integrationId: row.id, endpointId: ep.id, params: i.params }, ep.defaultRefreshSec);
      return { state: d.state, ...(d.data ? { data: d.data } : {}), ...(d.fetchedAt ? { fetchedAt: d.fetchedAt } : {}), ...(d.error ? { error: d.error } : {}) };
    },
  },
  {
    name: "controls.commands", title: "List commands for controls", ...read,
    description: "Lists every command you may put on a control in an app: integration, command id, label, parameter schema, risk, whether it is owner-only, and its valid targets (for example the lights Home Assistant reports). Read only: it never runs anything. Place a command with controls.set; target fields such as entityId must be fixed values from the targets list.",
    input: z.object({}),
    output: z.object({ commands: z.array(z.object({ integrationId: z.string(), integrationName: z.string(), command: z.object({ id: z.string(), label: z.string(), description: z.string(), params: z.record(z.string(), z.unknown()), risk: z.enum(["low", "medium"]), ownerOnly: z.boolean().optional(), target: z.object({ endpointId: z.string(), field: z.string() }).optional() }), targets: z.array(z.object({ id: z.string(), label: z.string() })).optional() })) }),
    async handler({ principal }) { return { commands: listCommands(principal) }; },
  },
  {
    name: "integrations.detect", title: "Detect a service", ...read,
    description: "Probes a service URL from the Atrium server and returns which official packages match it and any OpenAPI endpoints found at /openapi.json, /swagger.json, /v3/api-docs or /api-docs.",
    input: z.object({ url: z.string().max(4096) }),
    output: z.object({ matches: z.array(z.string()), openapi: z.array(endpointSummary).optional() }),
    async handler({ signal }, i: { url: string }) {
      const r = await hostSafe(() => detect(i.url, galleryOrder(getRegistry()), signal));
      return { matches: r.matches, ...(r.openapi ? { openapi: r.openapi } : {}) };
    },
  },
  {
    name: "integrations.search_docs", title: "Look up documentation", ...read,
    description: "Fetches one documentation or OpenAPI URL that you supply and returns its title, URL, text cut to 20 KB and any endpoints found. This is not a web search; use your own search to find the URL.",
    input: z.object({ url: z.string().max(4096) }),
    output: z.object({ title: z.string(), url: z.string(), text: z.string(), endpoints: z.array(endpointSummary).optional() }),
    async handler({ signal }, i: { url: string }) { return hostSafe(() => lookupDocs(i.url, signal)); },
  },
  {
    name: "integrations.create", title: "Create an integration draft", ...edit, effect: "draft",
    description: "Creates an integration as a draft from a package id, a name and non-secret config (for example baseUrl). Custom API drafts can include endpoints. You cannot set credential values, but you can propose a saved credential per secret field (`credentials`, ids from credentials.list). Then call integrations.request_credentials and give the user the link to publish.",
    input: z.object({ packageId: z.string(), name: z.string().min(1).max(120), config: z.record(z.string(), z.unknown()).default({}), endpoints: z.array(customEndpointSchema).max(50).optional(), credentials: credentialPicksInput }),
    output: summaryOut,
    async handler({ principal }, i: { packageId: string; name: string; config: Record<string, unknown>; endpoints?: unknown[]; credentials?: Record<string, string> }) {
      return toSummary(svc.createIntegration(principal, { packageId: i.packageId, name: i.name, config: i.config, secrets: {}, ...(i.endpoints ? { endpoints: i.endpoints as never } : {}), ...(i.credentials ? { credentials: i.credentials } : {}) }));
    },
  },
  {
    name: "integrations.update", title: "Update an integration draft", ...edit, effect: "draft",
    description: "Changes a draft integration's name, non-secret config or proposed saved credentials (`credentials`: secret field key to credential id, an empty string clears one). Live integrations can only be changed by the user.",
    input: z.object({ integrationId: z.string(), name: z.string().min(1).max(120).optional(), config: z.record(z.string(), z.unknown()).optional(), credentials: z.record(z.string(), z.string().max(100)).optional() }),
    output: summaryOut,
    async handler({ principal }, i: { integrationId: string; name?: string; config?: Record<string, unknown>; credentials?: Record<string, string> }) {
      return toSummary(svc.updateIntegration(principal, i.integrationId, { ...(i.name ? { name: i.name } : {}), ...(i.config ? { config: i.config } : {}), ...(i.credentials ? { credentials: i.credentials } : {}) }));
    },
  },
  {
    name: "integrations.add_endpoint", title: "Add a custom endpoint", ...edit, effect: "draft",
    description: "Adds or replaces a custom endpoint on a draft Custom API integration: method (GET, or POST only for read APIs that need it), path, field picks as JSONPath with roles (value, label, time, status, column), shape and a refresh of at least 10 seconds.",
    input: z.object({ integrationId: z.string(), endpoint: customEndpointSchema }),
    output: z.object({ endpoints: z.array(z.object({ id: z.string(), label: z.string(), shape })) }),
    async handler({ principal }, i: { integrationId: string; endpoint: unknown }) {
      return { endpoints: svc.addEndpoint(principal, i.integrationId, i.endpoint).map((e) => ({ id: e.id, label: e.label, shape: e.shape as "stat" })) };
    },
  },
  {
    name: "integrations.add_command", title: "Add a command", ...edit, effect: "draft",
    description: "Adds or changes a command on a Custom API integration you created (or any, if you act for the owner): an id such as lamp.toggle, a label, a description, the method (POST, PUT, PATCH or DELETE), a path, optional query, an optional secret key for auth, non-secret headers only, an optional JSON body with {{ params.<name> }} placeholders, a params JSON schema and a risk of low or medium. It is saved as a draft listed under \"This integration can change\"; only the user can publish it, and nothing runs until a control on a published app uses it.",
    input: z.object({ integrationId: z.string(), command: customCommandSchema }),
    output: z.object({ pending: z.array(z.object({ id: z.string(), label: z.string(), risk: z.enum(["low", "medium"]), change: z.enum(["added", "changed"]) })) }),
    async handler({ principal }, i: { integrationId: string; command: unknown }) {
      const v = addCommand(principal, i.integrationId, i.command);
      return { pending: v.pending.map((c) => ({ id: c.id, label: c.label, risk: c.risk, change: c.change })) };
    },
  },
  {
    name: "integrations.request_credentials", title: "Ask the user for credentials", ...edit, effect: "none",
    description: "Returns a link to the draft's credentials page in Atrium, where the signed-in user pastes the key (or confirms a saved credential you propose in `credentials`) and publishes. The link expires after 24 hours and stops working once the secrets are saved. Give it to the user and wait.",
    input: z.object({ integrationId: z.string(), credentials: credentialPicksInput }),
    output: z.object({ credentialsUrl: z.string(), expiresAt: z.string() }),
    async handler({ principal }, i: { integrationId: string; credentials?: Record<string, string> }) { return svc.requestCredentials(principal, i.integrationId, env().ATRIUM_PUBLIC_URL, i.credentials); },
  },
  {
    name: "integrations.test", title: "Test a connection", ...edit, effect: "none",
    description: "Runs the connection test with the stored credentials and returns only the health result: status, latency, version and a message. Use it to fix the config and retry.",
    input: z.object({ integrationId: z.string() }),
    output: healthOut,
    async handler({ principal }, i: { integrationId: string }) {
      const v = svc.getIntegration(principal, i.integrationId);
      const r = await svc.testConnection(principal, { packageId: v.packageId, config: v.config, secrets: {}, integrationId: v.id });
      if (r.ok) return healthOut.parse(r.health);
      return { status: "down" as const, latencyMs: r.latencyMs, message: `${r.heading}: ${r.error.message}${r.error.hint ? ` ${r.error.hint}` : ""}` };
    },
  },
  {
    name: "packages.create", title: "Create a declarative package", ...edit, effect: "draft",
    description: "Creates a declarative package (no code) for a service Atrium has never seen: a name, description, optional secret fields (key, label, plain-English hint, auth placement), endpoint records with field picks, and optional command records (commands.json). It is saved as a draft for the user to review; commands wait under \"This integration can change\" until the user publishes them.",
    input: z.object({ name: z.string(), description: z.string().optional(), hosts: z.array(z.string()).optional(), secrets: z.array(z.object({ key: z.string(), label: z.string(), hint: z.string(), auth: z.record(z.string(), z.unknown()) })).optional(), endpoints: z.array(customEndpointSchema).min(1), commands: z.array(customCommandSchema).max(50).optional() }),
    output: z.object({ id: z.string(), name: z.string(), status: z.string().optional() }),
    async handler({ principal }, i: unknown) { const c = svc.saveDeclarativePackage(principal, i); return { id: c.id, name: c.name, ...(c.status ? { status: c.status } : {}) }; },
  },
  {
    name: "packages.update", title: "Update a declarative package", ...edit, effect: "draft",
    description: "Replaces a declarative package's definition (same fields as packages.create). Agents can only change draft packages.",
    input: z.object({ id: z.string(), name: z.string(), description: z.string().optional(), hosts: z.array(z.string()).optional(), secrets: z.array(z.object({ key: z.string(), label: z.string(), hint: z.string(), auth: z.record(z.string(), z.unknown()) })).optional(), endpoints: z.array(customEndpointSchema).min(1), commands: z.array(customCommandSchema).max(50).optional() }),
    output: z.object({ id: z.string(), name: z.string(), status: z.string().optional() }),
    async handler({ principal }, i: { id: string } & Record<string, unknown>) {
      const { id, ...rest } = i;
      const existing = getRegistry().packages.get(id);
      if (principal.kind !== "user" && existing?.status !== "draft") throw new Error("Agents can only change draft packages.");
      const c = svc.saveDeclarativePackage(principal, rest, { update: id });
      return { id: c.id, name: c.name, ...(c.status ? { status: c.status } : {}) };
    },
  },
];

// Amendment 10 (A10.4, A10.8): the data catalogue for agents with atrium:edit. Reads, things and
// live values only; never config or secrets.
integrationTools.push(
  {
    name: "data.search", title: "Search the data catalogue", ...edit, effect: "none",
    description: "Searches every read of every connected service you may use, one result per thing (\"CPU in use\" for each machine, plus \"Every machine\"). Every word of `q` must match the read, the thing, the service or its group. `fits` is a component type (stat, chart, table, gauge, list, status, service-tile...): results that fit it come first and `fits[i]` says which do. Each item's `key` and `params` are what a binding needs (apps.bindData takes the key); `history` names the read that charts a value over time. `services` lists each service with its kind, open address and headline stats. `pending` names services whose things did not arrive within 3 seconds. Never returns config or secrets.",
    input: z.object({ q: z.string().max(200).optional(), fits: z.string().max(60).optional(), integrationId: z.string().max(100).optional(), measure: z.enum(MEASURES).optional(), all: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional() }),
    output: catalogueOut,
    async handler({ principal }, i: { q?: string; fits?: string; integrationId?: string; measure?: (typeof MEASURES)[number]; all?: boolean; limit?: number }) {
      if (!mayUseCatalogue(principal)) throw new Error("Searching the data catalogue needs the atrium:edit scope and a member or owner account.");
      return catalogueOut.parse(await buildCatalogue(principal, i));
    },
  },
  {
    name: "data.peek", title: "Peek at catalogue values", ...edit, effect: "none",
    description: "Returns the current value of up to 20 reads (integrationId, endpointId and params from data.search) through Atrium's shared cache, within 3 seconds. Each answer has the item's key and either the shaped data or an error in words. Never returns config or secrets.",
    input: peekIn,
    output: peekOut,
    async handler({ principal }, i: { items: { integrationId: string; endpointId: string; params: Record<string, unknown> }[] }) {
      if (!mayUseCatalogue(principal)) throw new Error("Peeking at data needs the atrium:edit scope and a member or owner account.");
      return peekOut.parse(await peek(principal, i.items));
    },
  },
);

integrationTools.push(...credentialTools);

export const tools = integrationTools;
