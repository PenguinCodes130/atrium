// Agent tools for saved credentials (architecture v3 Amendment 2). One read tool: names, kinds,
// servers and usage, never a value. No tool creates, rotates, reads or deletes a credential, and
// none adds a server: agents can only propose a credential for a draft (integrations.create,
// integrations.update, integrations.request_credentials take `credentials`).
import "server-only";
import { z } from "zod";
import type { ToolDef } from "@/core/contracts";
import { listCredentials } from "./service";

const credentialSummary = z.object({
  id: z.string(), name: z.string(), kind: z.enum(["token", "username-password", "proxmox-token"]),
  fields: z.array(z.object({ key: z.string(), set: z.boolean() })),
  lockedOrigins: z.array(z.string()),
  usedBy: z.array(z.object({ integrationId: z.string(), name: z.string() })),
  createdAt: z.string(), lastUsedAt: z.string().optional(),
});

/** Secret field key to saved credential id, for the integration tools' `credentials` input. */
export const credentialPicksInput = z.record(z.string(), z.string().max(100)).optional()
  .describe("Optional saved credentials by secret field key, from credentials.list, for example { \"token\": \"<credential id>\" }. The kind must fit the field: bearer, header and query fields take a token; Basic auth takes a username and password; Proxmox takes a Proxmox API token.");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const credentialTools: ToolDef<any, any>[] = [
  {
    name: "credentials.list", title: "List saved credentials",
    scope: "atrium:read", effect: "none", surfaces: ["palette", "builtin-agent", "mcp"], minRole: "viewer",
    description: "Lists the saved credentials you may use: id, name, kind (token, username-password, proxmox-token), which fields are set, the servers each is locked to (empty means it locks to the first integration that uses it), which integrations use it and when it was last used. Never returns a value. To use one, pass its id in `credentials` on integrations.create, integrations.update or integrations.request_credentials; the user publishes, and only the user can allow it on a new server.",
    input: z.object({}),
    output: z.object({ credentials: z.array(credentialSummary) }),
    async handler({ principal }) {
      return { credentials: listCredentials(principal).map((c) => credentialSummary.parse({ ...c, fields: c.fields.map((f) => ({ key: f.key, set: f.set })) })) };
    },
  },
];
