// apps.bindData (A10.8): an agent's catalogue pick, exactly as the builder's picker makes it. The item key
// names the read and its thing; the read must be one the agent's person may bind; the result is a managed
// source (found or created) and the component's binding, in one batch. Never returns config or secrets.
import "server-only";
import type { AppDocument, DraftOp, Principal } from "@/core/contracts";
import { NotFound } from "@/core/errors";
import { canBindReads } from "@/features/integrations/commands";
import { getIntegrationRow } from "@/features/integrations/repo";
import { endpointsOf } from "@/features/integrations/runtime";
import { buildCatalogue } from "@/features/data/catalogue";
import { parseCatalogueKey } from "@/features/data/catalogue-key";
import { findNode } from "./doc";
import { FieldError } from "./errors";
import { addLineOps, bindItemOps, headlineTemplate, propKind, setAtPath, type BindResult, type PickItem } from "@/features/builder/direct-data";

export type BindDataInput = { nodeId: string; prop: string; itemKey: string; value?: string; refreshSec?: number };

/** The catalogue item for a key, as this person sees it (label and thing in words), or one built from the endpoint. */
async function itemFor(p: Principal, key: string): Promise<PickItem> {
  const parsed = parseCatalogueKey(key);
  if (!parsed) throw new FieldError("itemKey", "That is not a key from data.search.");
  const row = getIntegrationRow(parsed.integrationId);
  const ep = row && row.status === "active" && canBindReads(p, row) ? endpointsOf(row).find((e) => e.id === parsed.endpointId) : undefined;
  if (!row || !ep) throw new NotFound("That read does not exist.");
  try {
    const cat = await buildCatalogue(p, { integrationId: row.id, all: true, limit: 200 }, { budgetMs: 2500 });
    const hit = cat.items.find((i) => i.key === key);
    if (hit) return hit;
  } catch {
    /* the catalogue could not be read in time: fall back to the endpoint's own words */
  }
  return { integrationId: row.id, endpointId: ep.id, label: ep.label, params: parsed.params, shape: ep.shape, defaultRefreshSec: ep.defaultRefreshSec, minRefreshSec: ep.minRefreshSec, ...(ep.history ? { history: { endpointId: ep.history.endpointId, params: { ...parsed.params, ...(ep.history.params ?? {}) } } } : {}) };
}

export async function bindDataOps(p: Principal, doc: AppDocument, input: BindDataInput): Promise<BindResult & { ops: DraftOp[] }> {
  const at = findNode(doc, input.nodeId);
  if (!at) throw new NotFound("That component does not exist in the draft.");
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.\d+\.[A-Za-z][A-Za-z0-9_]*)?$/.test(input.prop)) throw new FieldError("prop", "prop is a prop name, or a list prop path like stats.0.value.");
  const item = await itemFor(p, input.itemKey);
  if (input.refreshSec !== undefined && input.refreshSec !== 0 && input.refreshSec < item.minRefreshSec) throw new FieldError("refreshSec", `This read refreshes at most every ${item.minRefreshSec} s.`);
  const r = input.prop === "lines" ? addLineOps(doc, input.nodeId, item) : bindItemOps(doc, input.nodeId, input.prop, item);
  if (!r) throw new FieldError("itemKey", input.prop === "lines" || propKind(at.node.type, input.prop) === "line" ? "A chart line needs values over time: pick a series read, or a value read that has a history." : "That read cannot be shown there.");
  let ops = r.ops;
  let template = r.template;
  // A template body of the agent's own ("value", "rows | count"), against the same source.
  if (input.value && input.prop !== "lines") {
    template = headlineTemplate(r.name, input.value);
    ops = ops.map((o) => (o.op === "node.update" && o.nodeId === input.nodeId ? { ...o, patch: { ...o.patch, props: setAtPath((o.patch.props ?? {}) as never, input.prop, { $bind: template }) } } : o));
  }
  if (input.refreshSec !== undefined) ops = ops.map((o) => (o.op === "node.update" && o.nodeId === input.nodeId ? { ...o, patch: { ...o.patch, refreshSec: input.refreshSec! } } : o));
  return { ...r, ops, template };
}
