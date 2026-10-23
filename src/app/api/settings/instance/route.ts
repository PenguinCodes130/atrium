import { z } from "zod";
import { body, handle, send } from "@/features/settings/api";
import { getInstanceSettings, instanceSchema, updateInstanceSettings } from "@/features/settings/store";

export const dynamic = "force-dynamic";

// Owner only (Amendment 4 A4.4): instance name, audit retention, version retention.
export function GET(req: Request) {
  return handle(req, "owner", () => send(instanceSchema, getInstanceSettings()));
}

export function PUT(req: Request) {
  return handle(req, "owner", async (s) => {
    const r = updateInstanceSettings(s.principal, await body(req, z.record(z.string(), z.unknown())));
    return send(z.object({ settings: instanceSchema, changed: z.array(z.string()) }), r);
  });
}
