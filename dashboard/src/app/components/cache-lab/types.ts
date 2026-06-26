export interface ScenarioOption {
  key: string;
  label: string;
  family: string;
  description: string;
}

export interface CatalogItem {
  key: string;
  title: string;
  category: string;
}

export interface AssetItem {
  slug: string;
  title: string;
  sizeKb: number;
}

export interface CatalogResponse {
  ok: boolean;
  defaults: {
    requestCount: number;
    key: string;
    slug: string;
  };
  items: CatalogItem[];
  cdnAssets: AssetItem[];
  scenarios: ScenarioOption[];
}

export interface LocalCacheEntry {
  key: string;
  version: number;
  expiresInMs: number;
  cachedAt: number;
}

export interface RedisCacheEntry {
  key: string;
  version: number;
  ttlSec: number;
}

export interface EventEntry {
  time: string;
  event: string;
  details: Record<string, unknown>;
}

export interface EdgeCacheEntry {
  slug: string;
  version: number;
  expiresInMs: number;
}

export interface EdgeStatus {
  region: string;
  online: boolean;
  label?: string;
  hostname?: string;
  edgeLatencyMs?: number;
  edgeTtlMs?: number;
  stats?: {
    hits: number;
    misses: number;
    originFetches: number;
  };
  cacheEntries?: EdgeCacheEntry[];
  history?: EventEntry[];
  error?: string;
}

export interface StatusPayload {
  ok: boolean;
  service: {
    name: string;
    hostname: string;
    port: number;
  };
  config: {
    databaseDelayMs: number;
    originAssetDelayMs: number;
    localCacheTtlMs: number;
    localCacheMaxEntries: number;
    redisCacheTtlSec: number;
    writeBackFlushMs: number;
    refreshAheadWindowMs: number;
  };
  dataset: Array<{
    key: string;
    title: string;
    category: string;
    summary: string;
    version: number;
    updatedAt: string;
  }>;
  caches: {
    local: {
      entries: LocalCacheEntry[];
      stats: {
        hits: number;
        misses: number;
        sets: number;
        invalidations: number;
        evictions: number;
      };
    };
    redis: {
      entries: RedisCacheEntry[];
      stats: {
        hits: number;
        misses: number;
        sets: number;
        invalidations: number;
      };
    };
    writeBackBuffer: Array<{
      key: string;
      patch: Record<string, string>;
    }>;
  };
  database: {
    reads: number;
    writes: number;
    assetReads: number;
  };
  writeBack: {
    bufferedWrites: number;
    flushedWrites: number;
  };
  edges: EdgeStatus[];
  recentEvents: EventEntry[];
}

export interface TraceItem {
  step: number;
  operation: string;
  key: string;
  source: string;
  cacheLayer: string;
  latencyMs: number;
  version: number | null;
  note: string;
}

export interface SimulationMetrics {
  scenariosRun: number;
  local: {
    hits: number;
    misses: number;
    sets: number;
    invalidations: number;
    evictions: number;
  };
  redis: {
    hits: number;
    misses: number;
    sets: number;
    invalidations: number;
  };
  db: {
    reads: number;
    writes: number;
    assetReads: number;
  };
  writeBack: {
    bufferedWrites: number;
    flushedWrites: number;
  };
}

export interface SimulationResult {
  scenario: string;
  label: string;
  category: string;
  headline: string;
  averageLatencyMs: number;
  coldLatencyMs: number;
  fastestMs: number;
  slowestMs: number;
  hitRate: number;
  hotSpeedupPct: number;
  metrics: SimulationMetrics;
  traces: TraceItem[];
  notes: string[];
  consistency?: string;
  edgeStatus?: EdgeStatus;
  evictedEntries?: number;
}

export interface RunResponse {
  ok: boolean;
  result: SimulationResult;
  status: StatusPayload;
}

export interface ScenarioSelection {
  scenario: string;
  requestCount: number;
  key: string;
  slug: string;
}
