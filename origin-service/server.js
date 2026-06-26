const http = require("node:http");
const os = require("node:os");
const { performance } = require("node:perf_hooks");
const { createClient } = require("redis");

const port = Number(process.env.PORT || 3000);
const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const databaseDelayMs = Number(process.env.DATABASE_DELAY_MS || 240);
const originAssetDelayMs = Number(process.env.ORIGIN_ASSET_DELAY_MS || 340);
const localCacheTtlMs = Number(process.env.LOCAL_CACHE_TTL_MS || 12000);
const localCacheMaxEntries = Number(process.env.LOCAL_CACHE_MAX_ENTRIES || 4);
const redisCacheTtlSec = Number(process.env.REDIS_CACHE_TTL_SEC || 18);
const writeBackFlushMs = Number(process.env.WRITE_BACK_FLUSH_MS || 2200);
const refreshAheadWindowMs = Number(process.env.REFRESH_AHEAD_WINDOW_MS || 1600);

const edgeUrls = {
  jakarta: process.env.EDGE_JAKARTA_URL || "http://127.0.0.1:3101",
  singapore: process.env.EDGE_SINGAPORE_URL || "http://127.0.0.1:3102",
};

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function buildRecord(key, title, category, summary) {
  return {
    key,
    title,
    category,
    summary,
    version: 1,
    updatedAt: nowIso(),
  };
}

function seedCatalog() {
  return {
    "catalog:popular": buildRecord(
      "catalog:popular",
      "Popular Catalog",
      "dashboard",
      "Dataset hot-key untuk demonstrasi read-heavy traffic.",
    ),
    "profile:student": buildRecord(
      "profile:student",
      "Student Profile",
      "profile",
      "Data profil mahasiswa yang sering diminta dashboard.",
    ),
    "article:redis": buildRecord(
      "article:redis",
      "Redis Deep Dive",
      "article",
      "Membahas cache global berbasis in-memory untuk akses cepat.",
    ),
    "article:cdn": buildRecord(
      "article:cdn",
      "CDN Playbook",
      "article",
      "Konten statis yang cocok dipindahkan ke edge cache.",
    ),
    "report:latency": buildRecord(
      "report:latency",
      "Latency Report",
      "report",
      "Laporan ringkas untuk membandingkan sebelum dan sesudah cache.",
    ),
    "session:cart": buildRecord(
      "session:cart",
      "Cart Snapshot",
      "session",
      "Snapshot ringan yang cocok untuk cache sementara.",
    ),
  };
}

function seedAssets() {
  return {
    "landing-page": {
      slug: "landing-page",
      title: "Landing Page Bundle",
      version: 1,
      sizeKb: 420,
      updatedAt: nowIso(),
      body: "Hero image, stylesheet, dan copywriting utama untuk home page.",
    },
    "course-outline": {
      slug: "course-outline",
      title: "Course Outline PDF",
      version: 1,
      sizeKb: 188,
      updatedAt: nowIso(),
      body: "Dokumen outline mata kuliah untuk simulasi asset CDN.",
    },
  };
}

function createStats() {
  return {
    scenariosRun: 0,
    local: {
      hits: 0,
      misses: 0,
      sets: 0,
      invalidations: 0,
      evictions: 0,
    },
    redis: {
      hits: 0,
      misses: 0,
      sets: 0,
      invalidations: 0,
    },
    db: {
      reads: 0,
      writes: 0,
      assetReads: 0,
    },
    writeBack: {
      bufferedWrites: 0,
      flushedWrites: 0,
    },
  };
}

function createLocalCache(maxEntries) {
  const store = new Map();

  return {
    get(key) {
      const entry = store.get(key);

      if (!entry) {
        return { hit: false, reason: "miss" };
      }

      if (entry.expiresAt <= Date.now()) {
        store.delete(key);
        return { hit: false, reason: "expired" };
      }

      store.delete(key);
      store.set(key, { ...entry, lastAccessedAt: Date.now() });

      return {
        hit: true,
        value: clone(entry.value),
        ttlMs: Math.max(0, entry.expiresAt - Date.now()),
      };
    },

    set(key, value, ttlMs, meta = {}) {
      if (store.has(key)) {
        store.delete(key);
      }

      store.set(key, {
        value: clone(value),
        expiresAt: Date.now() + ttlMs,
        cachedAt: Date.now(),
        lastAccessedAt: Date.now(),
        meta,
      });

      let evicted = null;
      while (store.size > maxEntries) {
        const oldestKey = store.keys().next().value;
        const oldest = store.get(oldestKey);
        store.delete(oldestKey);
        evicted = {
          key: oldestKey,
          version: oldest?.value?.version || null,
        };
      }

      return { evicted };
    },

    delete(key) {
      return store.delete(key);
    },

    clear() {
      store.clear();
    },

    entries() {
      return Array.from(store.entries()).map(([key, entry]) => ({
        key,
        version: entry.value.version,
        expiresInMs: Math.max(0, entry.expiresAt - Date.now()),
        cachedAt: entry.cachedAt,
      }));
    },
  };
}

let catalogStore = seedCatalog();
let assetStore = seedAssets();
let stats = createStats();
let eventLog = [];

const localCache = createLocalCache(localCacheMaxEntries);
const writeBackBuffer = new Map();
const refreshAheadInFlight = new Set();

let flushInProgress = false;

function logEvent(event, details = {}) {
  const entry = {
    time: nowIso(),
    event,
    details,
  };

  eventLog = [entry, ...eventLog].slice(0, 100);

  const parts = Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);

  console.log(
    `[${entry.time}] origin-service ${event}${parts.length ? ` ${parts.join(" ")}` : ""}`,
  );
}

const redisClient = createClient({ url: redisUrl });
redisClient.on("error", (error) => {
  logEvent("redis-error", { message: error.message });
});

const redisReady = redisClient
  .connect()
  .then(async () => {
    await redisClient.flushDb();
    logEvent("redis-connected", { redisUrl });
  })
  .catch((error) => {
    logEvent("redis-connect-failed", { message: error.message });
    throw error;
  });

function makeRedisItemKey(key) {
  return `cache:item:${key}`;
}

async function ensureRedis() {
  await redisReady;
  return redisClient;
}

async function clearRedisCache() {
  const client = await ensureRedis();
  const keys = await client.keys("cache:item:*");

  if (keys.length) {
    await client.del(keys);
  }
}

async function getRedisEntries() {
  const client = await ensureRedis();
  const keys = await client.keys("cache:item:*");

  if (!keys.length) {
    return [];
  }

  const rows = [];
  for (const key of keys.sort()) {
    const [value, ttl] = await Promise.all([client.get(key), client.ttl(key)]);
    if (!value) continue;

    const parsed = JSON.parse(value);
    rows.push({
      key: key.replace(/^cache:item:/, ""),
      version: parsed.version,
      ttlSec: ttl,
    });
  }

  return rows;
}

async function getLocalCached(key) {
  const result = localCache.get(key);

  if (result.hit) {
    stats.local.hits += 1;
    logEvent("local-cache-hit", { key, ttlMs: Math.round(result.ttlMs), version: result.value.version });
  } else {
    stats.local.misses += 1;
    logEvent("local-cache-miss", { key, reason: result.reason });
  }

  return result;
}

function setLocalCached(key, value, note) {
  stats.local.sets += 1;
  const { evicted } = localCache.set(key, value, localCacheTtlMs, { note });

  logEvent("local-cache-set", { key, version: value.version, note });

  if (evicted) {
    stats.local.evictions += 1;
    logEvent("local-cache-evicted", evicted);
  }
}

async function invalidateLocalKey(key) {
  const deleted = localCache.delete(key);
  if (deleted) {
    stats.local.invalidations += 1;
    logEvent("local-cache-invalidated", { key });
  }
}

async function getRedisCached(key) {
  const client = await ensureRedis();
  await wait(28);
  const cached = await client.get(makeRedisItemKey(key));

  if (!cached) {
    stats.redis.misses += 1;
    logEvent("redis-cache-miss", { key });
    return { hit: false };
  }

  const ttlSec = await client.ttl(makeRedisItemKey(key));
  const value = JSON.parse(cached);
  stats.redis.hits += 1;
  logEvent("redis-cache-hit", { key, ttlSec, version: value.version });

  return {
    hit: true,
    value,
    ttlMs: Math.max(0, ttlSec * 1000),
  };
}

async function setRedisCached(key, value, ttlSec, note) {
  const client = await ensureRedis();
  await wait(20);
  await client.set(makeRedisItemKey(key), JSON.stringify(value), { EX: ttlSec });
  stats.redis.sets += 1;
  logEvent("redis-cache-set", { key, version: value.version, ttlSec, note });
}

async function invalidateRedisKey(key) {
  const client = await ensureRedis();
  await wait(14);
  const removed = await client.del(makeRedisItemKey(key));
  if (removed) {
    stats.redis.invalidations += 1;
    logEvent("redis-cache-invalidated", { key });
  }
}

async function fetchCatalogRecord(key, source) {
  const record = catalogStore[key];
  if (!record) {
    throw new Error(`Data ${key} tidak ditemukan di database simulasi.`);
  }

  await wait(databaseDelayMs);
  stats.db.reads += 1;
  logEvent("db-read", { key, source, version: record.version });
  return clone(record);
}

async function writeCatalogRecord(key, patch, source) {
  const current = catalogStore[key];
  if (!current) {
    throw new Error(`Data ${key} tidak ditemukan untuk proses tulis.`);
  }

  await wait(Math.max(140, Math.round(databaseDelayMs * 0.75)));
  const next = {
    ...current,
    ...patch,
    version: current.version + 1,
    updatedAt: nowIso(),
  };

  catalogStore[key] = next;
  stats.db.writes += 1;
  logEvent("db-write", { key, source, version: next.version });
  return clone(next);
}

async function fetchOriginAsset(slug) {
  const asset = assetStore[slug];
  if (!asset) {
    throw new Error(`Asset ${slug} tidak ditemukan.`);
  }

  await wait(originAssetDelayMs);
  stats.db.assetReads += 1;
  logEvent("origin-asset-read", { slug, version: asset.version });
  return clone(asset);
}

function summarizeScenario({
  scenario,
  label,
  category,
  headline,
  traces,
  notes,
  extra = {},
}) {
  const latencies = traces.map((trace) => trace.latencyMs);
  const hits = traces.filter((trace) =>
    ["local-cache", "redis-cache", "edge-cache", "write-buffer"].includes(trace.source),
  ).length;
  const coldTrace = traces[0] || { latencyMs: 0 };
  const hotLatencies = traces.slice(1).map((trace) => trace.latencyMs);

  return {
    scenario,
    label,
    category,
    headline,
    averageLatencyMs: round1(average(latencies)),
    coldLatencyMs: round1(coldTrace.latencyMs),
    fastestMs: round1(Math.min(...latencies)),
    slowestMs: round1(Math.max(...latencies)),
    hitRate: traces.length ? round1((hits / traces.length) * 100) : 0,
    hotSpeedupPct: hotLatencies.length
      ? round1(((coldTrace.latencyMs - average(hotLatencies)) / coldTrace.latencyMs) * 100)
      : 0,
    metrics: clone(stats),
    traces,
    notes,
    ...extra,
  };
}

function scenarioTrace(step, operation, key, result, latencyMs) {
  return {
    step,
    operation,
    key,
    source: result.source,
    cacheLayer: result.cacheLayer,
    latencyMs: round1(latencyMs),
    version: result.value?.version || result.version || null,
    note: result.note,
  };
}

async function measureOperation(operation) {
  const started = performance.now();
  const result = await operation();
  return {
    result,
    latencyMs: performance.now() - started,
  };
}

async function readWithoutCache(key) {
  const value = await fetchCatalogRecord(key, "baseline-db");
  return {
    source: "database",
    cacheLayer: "db",
    value,
    note: "Semua request langsung menuju database.",
  };
}

async function readCacheAsideLocal(key) {
  const local = await getLocalCached(key);
  if (local.hit) {
    return {
      source: "local-cache",
      cacheLayer: "memcached-style",
      value: local.value,
      note: "Hit di cache lokal per-node, mirip konsep Memcached.",
    };
  }

  const value = await fetchCatalogRecord(key, "cache-aside-local");
  setLocalCached(key, value, "cache-aside-local");
  return {
    source: "database",
    cacheLayer: "local-fill",
    value,
    note: "Miss di local cache, data diambil dari database lalu disimpan.",
  };
}

async function readCacheAsideRedis(key) {
  const redis = await getRedisCached(key);
  if (redis.hit) {
    return {
      source: "redis-cache",
      cacheLayer: "redis",
      value: redis.value,
      note: "Hit pada cache global Redis.",
    };
  }

  const value = await fetchCatalogRecord(key, "cache-aside-redis");
  await setRedisCached(key, value, redisCacheTtlSec, "cache-aside-redis");
  return {
    source: "database",
    cacheLayer: "redis-fill",
    value,
    note: "Miss di Redis, database menjadi sumber kebenaran.",
  };
}

async function readThroughRedis(key) {
  const redis = await getRedisCached(key);
  if (redis.hit) {
    return {
      source: "redis-cache",
      cacheLayer: "read-through",
      value: redis.value,
      note: "Cache service menangani pengambilan data secara otomatis.",
    };
  }

  const value = await fetchCatalogRecord(key, "read-through");
  await setRedisCached(key, value, redisCacheTtlSec, "read-through-loader");
  return {
    source: "database",
    cacheLayer: "read-through-loader",
    value,
    note: "Read-through loader mengisi cache setelah miss.",
  };
}

function scheduleRefreshAhead(key) {
  if (refreshAheadInFlight.has(key)) {
    return;
  }

  refreshAheadInFlight.add(key);
  logEvent("refresh-ahead-scheduled", { key });

  setTimeout(async () => {
    try {
      const fresh = await fetchCatalogRecord(key, "refresh-ahead-worker");
      await setRedisCached(key, fresh, 3, "refresh-ahead-worker");
      logEvent("refresh-ahead-complete", { key, version: fresh.version });
    } catch (error) {
      logEvent("refresh-ahead-failed", { key, message: error.message });
    } finally {
      refreshAheadInFlight.delete(key);
    }
  }, 40).unref?.();
}

async function readRefreshAhead(key) {
  const redis = await getRedisCached(key);
  if (redis.hit) {
    if (redis.ttlMs <= refreshAheadWindowMs) {
      scheduleRefreshAhead(key);
      return {
        source: "redis-cache",
        cacheLayer: "refresh-ahead",
        value: redis.value,
        note: "Hit di Redis, refresh ahead dijadwalkan sebelum TTL habis.",
      };
    }

    return {
      source: "redis-cache",
      cacheLayer: "refresh-ahead",
      value: redis.value,
      note: "Hit di Redis dan TTL masih aman.",
    };
  }

  const value = await fetchCatalogRecord(key, "refresh-ahead-prime");
  await setRedisCached(key, value, 3, "refresh-ahead-prime");
  return {
    source: "database",
    cacheLayer: "refresh-ahead-prime",
    value,
    note: "Miss awal lalu cache disiapkan dengan TTL pendek.",
  };
}

async function writeThrough(key) {
  const updated = await writeCatalogRecord(
    key,
    {
      summary: `Write-through commit tersimpan aman. (${nowIso()})`,
    },
    "write-through",
  );

  setLocalCached(key, updated, "write-through-update");
  await setRedisCached(key, updated, redisCacheTtlSec, "write-through-update");

  return {
    source: "database",
    cacheLayer: "write-through",
    value: updated,
    note: "Database dan cache diperbarui bersamaan.",
  };
}

async function flushWriteBackBuffer(trigger) {
  if (flushInProgress || !writeBackBuffer.size) {
    return;
  }

  flushInProgress = true;
  logEvent("write-back-flush-start", { trigger, bufferedKeys: Array.from(writeBackBuffer.keys()) });

  try {
    for (const [key, patch] of Array.from(writeBackBuffer.entries())) {
      const updated = await writeCatalogRecord(key, patch, "write-back-flush");
      setLocalCached(key, updated, "write-back-flush");
      await setRedisCached(key, updated, redisCacheTtlSec, "write-back-flush");
      writeBackBuffer.delete(key);
      stats.writeBack.flushedWrites += 1;
      logEvent("write-back-flushed", { key, version: updated.version });
    }
  } finally {
    flushInProgress = false;
  }
}

setInterval(() => {
  void flushWriteBackBuffer("interval");
}, writeBackFlushMs).unref();

async function writeBack(key) {
  const current = clone(catalogStore[key]);
  if (!current) {
    throw new Error(`Data ${key} tidak ditemukan untuk write-back.`);
  }

  await wait(16);
  const buffered = {
    summary: `Write-back buffered, sinkronisasi tertunda. (${nowIso()})`,
  };

  writeBackBuffer.set(key, buffered);
  stats.writeBack.bufferedWrites += 1;

  const preview = {
    ...current,
    ...buffered,
    version: current.version + 1,
    updatedAt: nowIso(),
  };

  setLocalCached(key, preview, "write-back-buffer");
  logEvent("write-back-buffered", { key, pendingVersion: preview.version });

  return {
    source: "write-buffer",
    cacheLayer: "write-back",
    value: preview,
    note: "Tulisan cepat masuk buffer lebih dulu, database menyusul.",
  };
}

async function invalidateEverywhere(key) {
  await Promise.all([invalidateLocalKey(key), invalidateRedisKey(key)]);
}

async function resetEdges() {
  const tasks = Object.entries(edgeUrls).map(async ([region, url]) => {
    try {
      await fetch(`${url}/api/reset`, {
        method: "POST",
        signal: AbortSignal.timeout(3000),
      });
      logEvent("edge-reset", { region });
    } catch (error) {
      logEvent("edge-reset-failed", { region, message: error.message });
    }
  });

  await Promise.all(tasks);
}

async function fetchEdgeStatus(region, url) {
  try {
    const response = await fetch(`${url}/api/status`, {
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    return {
      region,
      online: true,
      ...payload,
    };
  } catch (error) {
    return {
      region,
      online: false,
      error: error.message,
    };
  }
}

async function buildStatusPayload() {
  const edges = await Promise.all(
    Object.entries(edgeUrls).map(([region, url]) => fetchEdgeStatus(region, url)),
  );

  return {
    ok: true,
    service: {
      name: "Caching Origin Service",
      hostname: os.hostname(),
      port,
    },
    config: {
      databaseDelayMs,
      originAssetDelayMs,
      localCacheTtlMs,
      localCacheMaxEntries,
      redisCacheTtlSec,
      writeBackFlushMs,
      refreshAheadWindowMs,
    },
    dataset: Object.values(catalogStore),
    caches: {
      local: {
        entries: localCache.entries(),
        stats: stats.local,
      },
      redis: {
        entries: await getRedisEntries(),
        stats: stats.redis,
      },
      writeBackBuffer: Array.from(writeBackBuffer.entries()).map(([key, patch]) => ({ key, patch })),
    },
    database: stats.db,
    writeBack: stats.writeBack,
    edges,
    recentEvents: eventLog,
  };
}

async function resetSimulationState(reason, includeEdges = true) {
  catalogStore = seedCatalog();
  assetStore = seedAssets();
  stats = createStats();
  eventLog = [];
  localCache.clear();
  writeBackBuffer.clear();
  refreshAheadInFlight.clear();
  await clearRedisCache();
  if (includeEdges) {
    await resetEdges();
  }
  logEvent("simulation-reset", { reason, includeEdges });
}

async function runBaselineScenario(requestCount, key) {
  const traces = [];
  for (let step = 1; step <= requestCount; step += 1) {
    const measured = await measureOperation(() => readWithoutCache(key));
    traces.push(scenarioTrace(step, "read", key, measured.result, measured.latencyMs));
    await wait(70);
  }

  return summarizeScenario({
    scenario: "baseline-db",
    label: "Tanpa Cache",
    category: "read",
    headline: "Seluruh request menekan database secara langsung.",
    traces,
    notes: [
      "Pola ini sederhana tetapi paling mahal saat traffic read-heavy meningkat.",
      "Cocok sebagai baseline pembanding sebelum cache diaktifkan.",
    ],
  });
}

async function runCacheAsideLocalScenario(requestCount, key) {
  const traces = [];
  for (let step = 1; step <= requestCount; step += 1) {
    const measured = await measureOperation(() => readCacheAsideLocal(key));
    traces.push(scenarioTrace(step, "read", key, measured.result, measured.latencyMs));
    await wait(65);
  }

  return summarizeScenario({
    scenario: "cache-aside-local",
    label: "Cache Aside - Local Memory",
    category: "read",
    headline: "Hit berikutnya datang dari cache lokal per-node.",
    traces,
    notes: [
      "Merepresentasikan konsep Memcached-style cache yang cepat namun tidak dibagi antar node.",
      "Saat node restart, cache lokal ikut hilang sehingga perlu warm-up ulang.",
    ],
  });
}

async function runCacheAsideRedisScenario(requestCount, key) {
  const traces = [];
  for (let step = 1; step <= requestCount; step += 1) {
    const measured = await measureOperation(() => readCacheAsideRedis(key));
    traces.push(scenarioTrace(step, "read", key, measured.result, measured.latencyMs));
    await wait(65);
  }

  return summarizeScenario({
    scenario: "cache-aside-redis",
    label: "Cache Aside - Redis",
    category: "read",
    headline: "Cache global Redis mengurangi beban database lintas node.",
    traces,
    notes: [
      "Redis cocok untuk cache bersama ketika aplikasi memiliki lebih dari satu instance.",
      "Hit rate tinggi membuat database hanya menangani cold miss saja.",
    ],
  });
}

async function runReadThroughScenario(requestCount, key) {
  const traces = [];
  for (let step = 1; step <= requestCount; step += 1) {
    const measured = await measureOperation(() => readThroughRedis(key));
    traces.push(scenarioTrace(step, "read", key, measured.result, measured.latencyMs));
    await wait(65);
  }

  return summarizeScenario({
    scenario: "read-through",
    label: "Read Through",
    category: "read",
    headline: "Aplikasi melihat cache sebagai satu pintu baca.",
    traces,
    notes: [
      "Logika miss di-handle oleh cache loader sehingga kode aplikasi lebih tipis.",
      "Strategi ini tetap perlu invalidation yang rapi saat data berubah.",
    ],
  });
}

async function runWriteThroughScenario(key) {
  const traces = [];
  const writeMeasured = await measureOperation(() => writeThrough(key));
  traces.push(scenarioTrace(1, "write", key, writeMeasured.result, writeMeasured.latencyMs));

  for (let step = 2; step <= 4; step += 1) {
    const measured = await measureOperation(() => readCacheAsideRedis(key));
    traces.push(scenarioTrace(step, "read", key, measured.result, measured.latencyMs));
    await wait(70);
  }

  return summarizeScenario({
    scenario: "write-through",
    label: "Write Through",
    category: "write",
    headline: "Write lebih lambat, tetapi cache dan database konsisten seketika.",
    traces,
    notes: [
      "Strategi ini bagus untuk data yang harus segera terbaca konsisten setelah update.",
      "Trade-off-nya adalah latency write bertambah karena dua layer diperbarui bersama.",
    ],
    extra: {
      consistency: "strong-ish",
    },
  });
}

async function runWriteBackScenario(key) {
  const traces = [];
  const bufferedWrite = await measureOperation(() => writeBack(key));
  traces.push(scenarioTrace(1, "write", key, bufferedWrite.result, bufferedWrite.latencyMs));

  const immediateRead = await measureOperation(() => readCacheAsideLocal(key));
  traces.push(scenarioTrace(2, "read", key, immediateRead.result, immediateRead.latencyMs));

  await wait(writeBackFlushMs + 260);
  await flushWriteBackBuffer("scenario-write-back");

  const afterFlush = await measureOperation(() => readCacheAsideRedis(key));
  traces.push(scenarioTrace(3, "read", key, afterFlush.result, afterFlush.latencyMs));

  return summarizeScenario({
    scenario: "write-back",
    label: "Write Back",
    category: "write",
    headline: "Write sangat cepat karena database disinkronkan belakangan.",
    traces,
    notes: [
      "Cocok untuk beban tulis tinggi yang dapat menerima eventual consistency.",
      "Ada risiko kehilangan data jika buffer gagal sebelum flush terjadi.",
    ],
    extra: {
      consistency: "eventual",
    },
  });
}

async function runRefreshAheadScenario(key) {
  const traces = [];

  const first = await measureOperation(() => readRefreshAhead(key));
  traces.push(scenarioTrace(1, "read", key, first.result, first.latencyMs));

  await wait(1700);
  const second = await measureOperation(() => readRefreshAhead(key));
  traces.push(scenarioTrace(2, "read", key, second.result, second.latencyMs));

  await wait(1250);
  const third = await measureOperation(() => readRefreshAhead(key));
  traces.push(scenarioTrace(3, "read", key, third.result, third.latencyMs));

  return summarizeScenario({
    scenario: "refresh-ahead",
    label: "Refresh Ahead",
    category: "consistency",
    headline: "Hot key direfresh sebelum expired agar miss tidak muncul di jam sibuk.",
    traces,
    notes: [
      "Refresh ahead efektif untuk data populer dengan pola akses berulang.",
      "Background refresh menambah beban kecil tetapi menjaga user tetap mendapat hit.",
    ],
  });
}

async function runInvalidationScenario(key) {
  const traces = [];

  const warmLocal = await measureOperation(() => readCacheAsideLocal(key));
  traces.push(scenarioTrace(1, "read", key, warmLocal.result, warmLocal.latencyMs));

  const warmRedis = await measureOperation(() => readCacheAsideRedis(key));
  traces.push(scenarioTrace(2, "read", key, warmRedis.result, warmRedis.latencyMs));

  await writeCatalogRecord(
    key,
    { summary: `Database berubah dan cache lama harus dibuang. (${nowIso()})` },
    "manual-update-before-invalidation",
  );
  await invalidateEverywhere(key);

  const refreshed = await measureOperation(() => readCacheAsideRedis(key));
  traces.push(scenarioTrace(3, "read", key, refreshed.result, refreshed.latencyMs));

  return summarizeScenario({
    scenario: "invalidation",
    label: "Cache Invalidation",
    category: "consistency",
    headline: "Setelah data sumber berubah, key cache dibersihkan agar tidak stale.",
    traces,
    notes: [
      "Invalidation penting untuk menjaga data terbaru tampil ke user.",
      "Tanpa invalidation, user berisiko membaca versi lama lebih lama dari yang diinginkan.",
    ],
  });
}

async function runEvictionScenario() {
  const traces = [];
  const keys = [
    "catalog:popular",
    "profile:student",
    "article:redis",
    "article:cdn",
    "report:latency",
  ];

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const measured = await measureOperation(() => readCacheAsideLocal(key));
    traces.push(scenarioTrace(index + 1, "read", key, measured.result, measured.latencyMs));
    await wait(55);
  }

  const rebound = await measureOperation(() => readCacheAsideLocal("catalog:popular"));
  traces.push(scenarioTrace(6, "read", "catalog:popular", rebound.result, rebound.latencyMs));

  return summarizeScenario({
    scenario: "eviction-lru",
    label: "Cache Eviction - LRU",
    category: "capacity",
    headline: "Saat kapasitas kecil terlampaui, entri terlama dikeluarkan lebih dulu.",
    traces,
    notes: [
      "Simulasi ini memakai kapasitas local cache yang sengaja kecil agar eviction terlihat jelas.",
      "Policy LRU umum dipakai untuk menjaga item hot tetap bertahan lebih lama di cache.",
    ],
    extra: {
      evictedEntries: stats.local.evictions,
    },
  });
}

async function runCdnScenario(region, slug) {
  const edgeUrl = edgeUrls[region];
  if (!edgeUrl) {
    throw new Error(`Region CDN ${region} tidak dikenal.`);
  }

  await resetEdges();

  const traces = [];
  for (let step = 1; step <= 3; step += 1) {
    const started = performance.now();
    const response = await fetch(`${edgeUrl}/api/content/${slug}`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`Edge ${region} gagal menjawab (HTTP ${response.status}).`);
    }

    const payload = await response.json();
    traces.push({
      step,
      operation: "cdn-fetch",
      key: slug,
      source: payload.source,
      cacheLayer: payload.cacheLayer,
      latencyMs: round1(performance.now() - started),
      version: payload.asset.version,
      note: payload.note,
    });

    await wait(65);
  }

  const edgeStatus = await fetchEdgeStatus(region, edgeUrl);

  return summarizeScenario({
    scenario: `cdn-${region}`,
    label: `CDN Edge - ${region === "jakarta" ? "Jakarta" : "Singapore"}`,
    category: "cdn",
    headline: "Request pertama mengambil dari origin, request berikutnya dilayani edge cache.",
    traces,
    notes: [
      "CDN menaruh konten statis lebih dekat ke user sehingga latency menurun.",
      "Perbedaan region menunjukkan edge terdekat biasanya memberi respons lebih cepat.",
    ],
    extra: {
      edgeStatus,
    },
  });
}

async function runScenario(payload) {
  const scenario = payload?.scenario || "cache-aside-redis";
  const requestCount = Math.max(3, Math.min(8, Number(payload?.requestCount || 6)));
  const key = payload?.key || "catalog:popular";
  const slug = payload?.slug || "landing-page";

  await resetSimulationState(`scenario:${scenario}`, scenario.startsWith("cdn-"));
  stats.scenariosRun += 1;

  switch (scenario) {
    case "baseline-db":
      return runBaselineScenario(requestCount, key);
    case "cache-aside-local":
      return runCacheAsideLocalScenario(requestCount, key);
    case "cache-aside-redis":
      return runCacheAsideRedisScenario(requestCount, key);
    case "read-through":
      return runReadThroughScenario(requestCount, key);
    case "write-through":
      return runWriteThroughScenario(key);
    case "write-back":
      return runWriteBackScenario(key);
    case "refresh-ahead":
      return runRefreshAheadScenario(key);
    case "invalidation":
      return runInvalidationScenario(key);
    case "eviction-lru":
      return runEvictionScenario();
    case "cdn-jakarta":
      return runCdnScenario("jakarta", slug);
    case "cdn-singapore":
      return runCdnScenario("singapore", slug);
    default:
      throw new Error(`Scenario ${scenario} belum didukung.`);
  }
}

function getCatalogPayload() {
  return {
    ok: true,
    defaults: {
      requestCount: 6,
      key: "catalog:popular",
      slug: "landing-page",
    },
    items: Object.values(catalogStore).map((item) => ({
      key: item.key,
      title: item.title,
      category: item.category,
    })),
    cdnAssets: Object.values(assetStore).map((asset) => ({
      slug: asset.slug,
      title: asset.title,
      sizeKb: asset.sizeKb,
    })),
    scenarios: [
      {
        key: "baseline-db",
        label: "Tanpa Cache",
        family: "read",
        description: "Semua request langsung ke database.",
      },
      {
        key: "cache-aside-local",
        label: "Cache Aside - Local Memory",
        family: "read",
        description: "Hit cache lokal per-node, cocok menjelaskan konsep Memcached-style.",
      },
      {
        key: "cache-aside-redis",
        label: "Cache Aside - Redis",
        family: "read",
        description: "Cache global bersama untuk beberapa instance aplikasi.",
      },
      {
        key: "read-through",
        label: "Read Through",
        family: "read",
        description: "Cache mengurus proses load dari database saat miss.",
      },
      {
        key: "write-through",
        label: "Write Through",
        family: "write",
        description: "Database dan cache diperbarui bersama untuk menjaga konsistensi.",
      },
      {
        key: "write-back",
        label: "Write Back",
        family: "write",
        description: "Write cepat karena sinkronisasi database dilakukan belakangan.",
      },
      {
        key: "refresh-ahead",
        label: "Refresh Ahead",
        family: "consistency",
        description: "Cache direfresh sebelum expired untuk hot key.",
      },
      {
        key: "invalidation",
        label: "Cache Invalidation",
        family: "consistency",
        description: "Key cache dibuang saat sumber data berubah.",
      },
      {
        key: "eviction-lru",
        label: "Eviction - LRU",
        family: "capacity",
        description: "Entry lama digeser saat memori cache penuh.",
      },
      {
        key: "cdn-jakarta",
        label: "CDN Edge - Jakarta",
        family: "cdn",
        description: "Edge cache dekat user dengan latency lebih kecil.",
      },
      {
        key: "cdn-singapore",
        label: "CDN Edge - Singapore",
        family: "cdn",
        description: "Edge cache region lain untuk menunjukkan variasi latency.",
      },
    ],
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Payload terlalu besar"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Body JSON tidak valid"));
      }
    });

    req.on("error", reject);
  });
}

function notFound(res) {
  sendJson(res, 404, { ok: false, error: "Route tidak ditemukan" });
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  try {
    if (req.method === "GET" && requestUrl.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "origin-service" });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/catalog") {
      sendJson(res, 200, getCatalogPayload());
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/status") {
      sendJson(res, 200, await buildStatusPayload());
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/reset") {
      await resetSimulationState("manual-reset", true);
      sendJson(res, 200, await buildStatusPayload());
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/simulations/run") {
      const body = await parseBody(req);
      const result = await runScenario(body);
      sendJson(res, 200, { ok: true, result, status: await buildStatusPayload() });
      return;
    }

    const originAssetMatch = requestUrl.pathname.match(/^\/api\/origin\/content\/([^/]+)$/);
    if (req.method === "GET" && originAssetMatch) {
      const slug = decodeURIComponent(originAssetMatch[1]);
      const asset = await fetchOriginAsset(slug);
      sendJson(res, 200, {
        ok: true,
        asset,
        source: "origin",
        cacheLayer: "origin-store",
        note: "Origin menghasilkan asset statis untuk edge cache.",
      });
      return;
    }

    notFound(res);
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : "Terjadi kesalahan pada simulasi caching.",
    });
  }
});

server.listen(port, () => {
  logEvent("service-started", {
    port,
    databaseDelayMs,
    localCacheTtlMs,
    redisCacheTtlSec,
    hostname: os.hostname(),
  });
});
