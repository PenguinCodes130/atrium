import { z } from "zod";
import { body, detectOut, handle, send } from "@/features/integrations/api";
import { detect } from "@/features/integrations/detect";
import { HostError } from "@/features/integrations/host/errors";
import { galleryOrder } from "@/features/integrations/registry";
import { getRegistry } from "@/features/integrations/runtime";

export const dynamic = "force-dynamic";
const input = z.object({ url: z.string().min(1).max(4096) });

export function POST(req: Request) {
  return handle(req, "member", async () => {
    const { url } = await body(req, input);
    try {
      return send(detectOut, await detect(url, galleryOrder(getRegistry()), req.signal));
    } catch (err) {
      if (err instanceof HostError) return send(detectOut, { url, matches: [], error: err.adapterError });
      throw err;
    }
  });
}
