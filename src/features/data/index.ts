// data: the shared cache, refresh scheduler and page data stream (architecture v2 section 10).
// Server exports. Browser code imports "@/features/data/client" and "@/features/data/ui" instead.
import "server-only";
export { dataRuntime, cachedWidgetData, readThrough, forgetIntegration } from "./runtime";
export { registerDataSources, dataSources, resetDataSources, createPageStream, streamSourceOf } from "./stream";
export type { StreamSource, DataSourceResolver, StreamOptions } from "./stream";
export { refreshIntegrationNow } from "./runtime";
export { cacheKey, canonicalJson } from "./keys";
export type { SourceRef } from "./keys";
export type { WidgetData, SourceData, CacheEntry } from "./types";
export { dataState, widgetData } from "./state";
