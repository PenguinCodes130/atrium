// The shared read cache: an LRU of 500 entries in front of the endpoint_cache table (section 10).
import type { ReadResult } from "@/core/contracts";
import { canonicalJson, cacheKey, type SourceRef } from "./keys";
import type { CacheEntry, GoodResult } from "./types";

export interface CacheBacking {
  load(key: string): CacheEntry | undefined;
  save(entry: CacheEntry): void;
  removeIntegration(integrationId: string): void;
}

export class MemoryBacking implements CacheBacking {
  readonly rows = new Map<string, CacheEntry>();
  load(key: string) { return this.rows.get(key); }
  save(e: CacheEntry) { this.rows.set(e.key, structuredClone(e)); }
  removeIntegration(id: string) { for (const [k, v] of this.rows) if (v.integrationId === id) this.rows.delete(k); }
}

export class ReadCache {
  private lru = new Map<string, CacheEntry>();
  constructor(private backing: CacheBacking, private capacity = 500) {}

  get(key: string): CacheEntry | undefined {
    let e = this.lru.get(key);
    if (e) {
      this.lru.delete(key);
      this.lru.set(key, e);
      return e;
    }
    e = this.backing.load(key);
    if (e) this.remember(e);
    return e;
  }

  getFor(s: SourceRef): CacheEntry | undefined {
    return this.get(cacheKey(s));
  }

  /** Records one attempt; a good result also becomes the last good value. */
  record(s: SourceRef, result: ReadResult): CacheEntry {
    const key = cacheKey(s);
    const prev = this.get(key);
    const entry: CacheEntry = {
      key,
      integrationId: s.integrationId,
      endpointId: s.endpointId,
      params: canonicalJson(s.params ?? null),
      lastGood: result.ok ? (result as GoodResult) : (prev?.lastGood ?? null),
      lastAttempt: result,
      fetchedAt: result.ok ? result.fetchedAt : (prev?.fetchedAt ?? null),
      sourceTimestamp: result.ok ? result.sourceTimestamp : (prev?.sourceTimestamp ?? null),
    };
    this.remember(entry);
    this.backing.save(entry);
    return entry;
  }

  removeIntegration(id: string) {
    for (const [k, v] of this.lru) if (v.integrationId === id) this.lru.delete(k);
    this.backing.removeIntegration(id);
  }

  size() { return this.lru.size; }

  private remember(e: CacheEntry) {
    this.lru.delete(e.key);
    this.lru.set(e.key, e);
    while (this.lru.size > this.capacity) {
      const oldest = this.lru.keys().next().value as string;
      this.lru.delete(oldest);
    }
  }
}
