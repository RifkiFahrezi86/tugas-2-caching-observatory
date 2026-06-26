const http = require("node:http");
const os = require("node:os");
const { performance } = require("node:perf_hooks");

const port = Number(process.env.PORT || 3000);
const edgeRegion = process.env.EDGE_REGION || "edge";
const edgeLabel = process.env.EDGE_LABEL || "Edge POP";
const edgeLatencyMs = Number(process.env.EDGE_LATENCY_MS || 25);
const edgeTtlMs = Number(process.env.EDGE_TTL_MS || 20000);
const originBaseUrl = process.env.ORIGIN_BASE_URL || "http://127.0.0.1:3000";

const cache = new Map();
let stats = {
  hits: 0,
  misses: 0,
  originFetches: 0,
};
let history = [];

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logEvent(event, details = {}) {
  history = [{ time: nowIso(), event, details }, ...history].slice(0, 60);
  const parts = Object.entries(details).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  console.log(
    `[${nowIso()}] ${edgeLabel} ${event}${parts.length ? ` ${parts.join(" ")}` : ""}`,
  );
}

function readCache(slug) {
  const entry = cache.get(slug);
  if (!entry) return { hit: false, reason: "miss" };
  if (entry.expiresAt <= Date.now()) {
    cache.delete(slug);
    return { hit: false, reason: "expired" };
  }
  return {
    hit: true,
    payload: clone(entry.payload),
    ttlMs: Math.max(0, entry.expiresAt - Date.now()),
  };
}

function writeCache(slug, payload) {
  cache.set(slug, {
    payload: clone(payload),
    expiresAt: Date.now() + edgeTtlMs,
    cachedAt: Date.now(),
  });
}

async function fetchOriginAsset(slug) {
  stats.originFetches += 1;
  const response = await fetch(`${originBaseUrl}/api/origin/content/${slug}`, {
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`Origin asset ${slug} gagal diambil (HTTP ${response.status}).`);
  }

  const payload = await response.json();
  return payload.asset;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  try {
    if (req.method === "GET" && requestUrl.pathname === "/health") {
      sendJson(res, 200, { ok: true, region: edgeRegion, label: edgeLabel });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/status") {
      sendJson(res, 200, {
        ok: true,
        region: edgeRegion,
        label: edgeLabel,
        hostname: os.hostname(),
        edgeLatencyMs,
        edgeTtlMs,
        stats,
        cacheEntries: Array.from(cache.entries()).map(([slug, entry]) => ({
          slug,
          version: entry.payload.version,
          expiresInMs: Math.max(0, entry.expiresAt - Date.now()),
        })),
        history,
      });
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/reset") {
      cache.clear();
      stats = { hits: 0, misses: 0, originFetches: 0 };
      history = [];
      logEvent("edge-reset");
      sendJson(res, 200, { ok: true, region: edgeRegion });
      return;
    }

    const match = requestUrl.pathname.match(/^\/api\/content\/([^/]+)$/);
    if (req.method === "GET" && match) {
      const slug = decodeURIComponent(match[1]);
      const started = performance.now();
      const hit = readCache(slug);

      if (hit.hit) {
        stats.hits += 1;
        await wait(edgeLatencyMs);
        logEvent("edge-cache-hit", { slug, version: hit.payload.version, ttlMs: Math.round(hit.ttlMs) });
        sendJson(res, 200, {
          ok: true,
          region: edgeRegion,
          label: edgeLabel,
          source: "edge-cache",
          cacheLayer: "cdn-edge",
          latencyMs: Math.round((performance.now() - started) * 10) / 10,
          asset: hit.payload,
          note: `Konten ${slug} dilayani langsung dari ${edgeLabel}.`,
        });
        return;
      }

      stats.misses += 1;
      await wait(edgeLatencyMs);
      const asset = await fetchOriginAsset(slug);
      writeCache(slug, asset);
      logEvent("edge-cache-miss", { slug, reason: hit.reason, version: asset.version });
      sendJson(res, 200, {
        ok: true,
        region: edgeRegion,
        label: edgeLabel,
        source: "origin",
        cacheLayer: "cdn-fill",
        latencyMs: Math.round((performance.now() - started) * 10) / 10,
        asset,
        note: `Miss di ${edgeLabel}, konten diambil dari origin lalu disimpan di edge.`,
      });
      return;
    }

    sendJson(res, 404, { ok: false, error: "Route tidak ditemukan" });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : "Gagal memproses edge cache.",
    });
  }
});

server.listen(port, () => {
  logEvent("edge-started", {
    port,
    edgeRegion,
    edgeLatencyMs,
    originBaseUrl,
  });
});
