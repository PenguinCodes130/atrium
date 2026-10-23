// Runs one recipe read on an integration's own adapter context (A9.1, A9.4): promql and label-values
// reads through the Prometheus package's query API calls, http reads through the generic runner
// (GET only, settings URL-encoded). Never cached here; errors become a ReadResult like any read.
import "server-only";
import type { AdapterContext, AdapterError, CustomEndpoint, ReadResult } from "@/core/contracts";
import { createGenericAdapter } from "@/packages/declarative/runner";
import { runPromRead } from "@/packages/prometheus/generic";
import type { ResolvedRead } from "./store";

const errorOf = (err: unknown): AdapterError => {
  const e = (err as { adapterError?: AdapterError })?.adapterError;
  return e?.code ? e : { code: "bad_response", message: "The read failed in an unexpected way.", hint: "Check the address and try again." };
};

export async function runRecipeRead(ctx: AdapterContext, r: ResolvedRead, params: Record<string, unknown>, opts: { packageId: string; auth?: string }): Promise<ReadResult> {
  const fetchedAt = ctx.now().toISOString();
  const req = r.read.request;
  try {
    if (req.kind === "http") {
      const ep: CustomEndpoint = {
        id: r.read.id, label: r.read.label, method: "GET", path: req.path, ...(req.query ? { query: req.query } : {}),
        ...(opts.auth ? { auth: opts.auth } : {}), fields: r.read.fields ?? [], shape: r.read.shape, refreshSec: Math.max(r.read.refreshSec ?? 60, 10),
        ...(r.read.params ? { params: r.read.params } : {}), ...(r.read.format ? { format: r.read.format } : {}), ...(r.read.columnFormats ? { columnFormats: r.read.columnFormats } : {}),
      };
      return await createGenericAdapter([ep]).read(ctx, ep.id, params);
    }
    if (opts.packageId !== "prometheus") return { ok: false, error: { code: "config", message: "This read is a Prometheus query, and this integration is not Prometheus." }, fetchedAt };
    const { data } = await runPromRead(ctx, r.read, params, r.record);
    return { ok: true, data, sourceTimestamp: fetchedAt, fetchedAt };
  } catch (err) {
    return { ok: false, error: errorOf(err), fetchedAt };
  }
}
