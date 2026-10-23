import type { AdapterError, DataState, ReadResult, ShapedData } from "@/core/contracts";

export type GoodResult = Extract<ReadResult, { ok: true }>;

export type CacheEntry = {
  key: string;
  integrationId: string;
  endpointId: string;
  params: string;
  lastGood: GoodResult | null;
  lastAttempt: ReadResult | null;
  fetchedAt: string | null;
  sourceTimestamp: string | null;
};

/** What a data source sends a page: shaped data and a state, nothing else (spec 3.7, v3 section 10). */
export type WidgetData = {
  state: DataState;
  data?: ShapedData;
  fetchedAt?: string;
  sourceTimestamp?: string;
  refreshSec: number;
  error?: Pick<AdapterError, "code" | "message" | "hint">;
};

/** v3 name: the value of one data source as the page stream sends it. */
export type SourceData = WidgetData;
