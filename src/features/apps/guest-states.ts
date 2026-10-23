// The source states a guest's components are resolved with (gauntlet w2-r2 item 5). Pure.
import type { AppDocument } from "@/core/contracts";
import { unmappedPackage } from "./doc";

/** What a guest, a viewer, or anyone who cannot add integrations sees on an unconnected card. */
export const NOT_CONNECTED_MESSAGE = "Not connected yet";

/** The source states a guest's resolver uses: unconnected sources say so; connected ones are fresh or empty. */
export function guestSourceStates(doc: AppDocument, data: Record<string, unknown> = {}, opts: { connectedToo?: boolean } = {}): Record<string, { state: "fresh" | "empty"; error?: { code: string; message: string } }> {
  const out: Record<string, { state: "fresh" | "empty"; error?: { code: string; message: string } }> = {};
  for (const s of doc.dataSources) {
    if (unmappedPackage(s.integrationId)) out[s.name] = { state: "empty", error: { code: "unmapped", message: NOT_CONNECTED_MESSAGE } };
    else if (opts.connectedToo) out[s.name] = { state: data[s.name] === undefined ? "empty" : "fresh" };
  }
  return out;
}
