import { startTransition, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Activity,
  ArrowRightLeft,
  Boxes,
  Cloud,
  Clock3,
  Database,
  Globe,
  Layers3,
  Play,
  RefreshCw,
  Server,
  Zap,
} from "lucide-react";
import { ControlPanel } from "./components/cache-lab/ControlPanel";
import { fetchCatalog, fetchStatus, resetSimulation, runSimulation } from "./components/cache-lab/api";
import type {
  CatalogResponse,
  EdgeStatus,
  EventEntry,
  ScenarioOption,
  ScenarioSelection,
  SimulationResult,
  StatusPayload,
  TraceItem,
} from "./components/cache-lab/types";
import { Badge } from "./components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";

type BannerTone = "idle" | "running" | "success" | "error";

const DEFAULT_SELECTION: ScenarioSelection = {
  scenario: "cache-aside-redis",
  requestCount: 6,
  key: "catalog:popular",
  slug: "landing-page",
};

const SOURCE_STYLES: Record<string, string> = {
  database: "border-[#d98f4a] bg-[#fff0df] text-[#874215]",
  "local-cache": "border-[#2d8a61] bg-[#eaf7ef] text-[#16543a]",
  "redis-cache": "border-[#2c7da0] bg-[#e8f4fa] text-[#16506a]",
  "edge-cache": "border-[#5c72d8] bg-[#eef1ff] text-[#35459a]",
  origin: "border-[#b86134] bg-[#fff1e9] text-[#7c3412]",
  "write-buffer": "border-[#8e5db7] bg-[#f4eefe] text-[#5a3384]",
};

const FAMILY_STYLES: Record<string, string> = {
  read: "bg-[#eef7f0] text-[#17533a] border-[#c9dfd0]",
  write: "bg-[#fff1e8] text-[#8a3f1f] border-[#f0cbb8]",
  consistency: "bg-[#f6f0ff] text-[#5d3a86] border-[#ded1f2]",
  capacity: "bg-[#fff7e7] text-[#8c6622] border-[#f0dfa9]",
  cdn: "bg-[#ebf4ff] text-[#295b8f] border-[#c7daf2]",
};

const BANNER_STYLES: Record<BannerTone, string> = {
  idle: "border-[#d8ccb9] bg-white/70 text-[#6f6458]",
  running: "border-[#b7d7d3] bg-[#eef8f6] text-[#13514d]",
  success: "border-[#c9ddcd] bg-[#eef8ef] text-[#245437]",
  error: "border-[#efc2b2] bg-[#fff2ec] text-[#8d3416]",
};

function fmtMs(ms: number) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${ms.toFixed(1)} ms`;
}

function fmtPct(value: number) {
  return `${value.toFixed(1)}%`;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("id-ID");
}

function sourceLabel(source: string) {
  switch (source) {
    case "database":
      return "Database";
    case "local-cache":
      return "Local Cache";
    case "redis-cache":
      return "Redis";
    case "edge-cache":
      return "CDN Edge";
    case "origin":
      return "Origin";
    case "write-buffer":
      return "Write Buffer";
    default:
      return source;
  }
}

function metricValue(value: number | undefined) {
  if (value === undefined) return "-";
  return value.toLocaleString("id-ID");
}

function StatCard({
  label,
  value,
  detail,
  accent,
}: {
  label: string;
  value: string;
  detail: string;
  accent: string;
}) {
  return (
    <Card className="gap-0 border-[#dfd3c2] bg-white/80 shadow-[0_12px_36px_rgba(36,26,18,0.07)]">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-[#8b7354]">{label}</p>
            <p className="mt-2 text-3xl font-semibold tracking-tight text-[#1f2a21]">{value}</p>
            <p className="mt-2 text-sm leading-6 text-[#6f6559]">{detail}</p>
          </div>
          <span className={`mt-1 size-3 rounded-full ${accent}`} />
        </div>
      </CardContent>
    </Card>
  );
}

function CacheEntriesCard({
  title,
  subtitle,
  entries,
  footer,
}: {
  title: string;
  subtitle: string;
  entries: Array<{ key: string; version: number; ttl: string }>;
  footer: string;
}) {
  return (
    <Card className="gap-0 border-[#dfd3c2] bg-white/78">
      <CardHeader className="pb-4">
        <CardTitle className="text-xl text-[#1f2a21]">{title}</CardTitle>
        <CardDescription className="text-[#6f6559]">{subtitle}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {entries.length ? (
          entries.map((entry) => (
            <div
              key={entry.key}
              className="rounded-2xl border border-[#ece2d4] bg-[#fffaf3] px-4 py-3 text-sm"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium text-[#2c3b31]">{entry.key}</span>
                <span className="text-[#866f52]">v{entry.version}</span>
              </div>
              <p className="mt-1 text-[#7c7367]">TTL {entry.ttl}</p>
            </div>
          ))
        ) : (
          <div className="rounded-2xl border border-dashed border-[#d7cbb9] bg-[#fbf6ee] px-4 py-6 text-sm text-[#7c7367]">
            Cache masih kosong. Jalankan simulasi agar entry muncul di sini.
          </div>
        )}
        <p className="text-xs leading-6 uppercase tracking-[0.18em] text-[#8a7457]">{footer}</p>
      </CardContent>
    </Card>
  );
}

function TraceRow({ trace, maxLatency }: { trace: TraceItem; maxLatency: number }) {
  const width = Math.max(12, (trace.latencyMs / Math.max(maxLatency, 1)) * 100);
  const sourceStyle = SOURCE_STYLES[trace.source] || "border-[#d7cbb9] bg-[#f7f1e8] text-[#6c6257]";

  return (
    <div className="rounded-[1.25rem] border border-[#e7dccd] bg-[#fffaf4] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-full bg-[#efe4d2] text-sm font-semibold text-[#3e4a41]">
            {trace.step}
          </span>
          <div>
            <p className="font-medium text-[#213026]">{trace.key}</p>
            <p className="text-sm text-[#786e61]">{trace.operation.toUpperCase()} via {trace.cacheLayer}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={sourceStyle}>
            {sourceLabel(trace.source)}
          </Badge>
          <span className="text-sm font-semibold text-[#1f2a21]">{fmtMs(trace.latencyMs)}</span>
        </div>
      </div>

      <div className="mt-4 h-2.5 rounded-full bg-[#efe6d9]">
        <div className="h-2.5 rounded-full bg-gradient-to-r from-[#134e4a] via-[#d67a34] to-[#f0c25b]" style={{ width: `${width}%` }} />
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-[#6f6559]">
        <span>{trace.note}</span>
        <span>{trace.version ? `versi ${trace.version}` : "tanpa versi"}</span>
      </div>
    </div>
  );
}

function EdgeCard({ edge }: { edge: EdgeStatus }) {
  return (
    <Card className="gap-0 border-[#dae0ef] bg-white/82">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-xl text-[#203b5b]">{edge.label || edge.region}</CardTitle>
            <CardDescription className="text-[#5e7493]">
              {edge.online ? `Latency edge ${edge.edgeLatencyMs} ms` : edge.error || "Offline"}
            </CardDescription>
          </div>
          <Badge
            variant="outline"
            className={edge.online ? "border-[#bad1f0] bg-[#edf5ff] text-[#315b8e]" : "border-[#ebc8bb] bg-[#fff2ec] text-[#8d3416]"}
          >
            {edge.online ? "online" : "offline"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm text-[#4c5f79]">
        <div className="grid grid-cols-3 gap-2 rounded-2xl bg-[#f4f8ff] p-3">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-[#7490b4]">Hits</p>
            <p className="mt-1 text-lg font-semibold text-[#234871]">{metricValue(edge.stats?.hits)}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-[#7490b4]">Misses</p>
            <p className="mt-1 text-lg font-semibold text-[#234871]">{metricValue(edge.stats?.misses)}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-[#7490b4]">Origin</p>
            <p className="mt-1 text-lg font-semibold text-[#234871]">{metricValue(edge.stats?.originFetches)}</p>
          </div>
        </div>
        <div className="grid gap-2">
          {(edge.cacheEntries || []).length ? (
            edge.cacheEntries?.map((entry) => (
              <div key={entry.slug} className="rounded-2xl border border-[#dde7f6] bg-[#fbfdff] px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-[#25476f]">{entry.slug}</span>
                  <span>v{entry.version}</span>
                </div>
                <p className="mt-1 text-xs uppercase tracking-[0.18em] text-[#7390b2]">
                  expires in {fmtMs(entry.expiresInMs)}
                </p>
              </div>
            ))
          ) : (
            <div className="rounded-2xl border border-dashed border-[#dae2ef] bg-[#fbfdff] px-4 py-4 text-[#6e83a0]">
              Belum ada asset yang menginap di edge region ini.
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function EventCard({ event }: { event: EventEntry }) {
  return (
    <div className="rounded-2xl border border-[#e7dccd] bg-[#fffaf4] px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="font-medium capitalize text-[#243126]">{event.event.replace(/-/g, " ")}</p>
        <span className="text-xs uppercase tracking-[0.18em] text-[#8b7354]">{fmtTime(event.time)}</span>
      </div>
      <p className="mt-2 break-all text-sm text-[#6d6458]">
        {Object.entries(event.details).length
          ? Object.entries(event.details)
              .map(([key, value]) => `${key}: ${String(value)}`)
              .join(" | ")
          : "Tidak ada detail tambahan."}
      </p>
    </div>
  );
}

export default function App() {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [selection, setSelection] = useState<ScenarioSelection>(DEFAULT_SELECTION);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [running, setRunning] = useState(false);
  const [booting, setBooting] = useState(true);
  const [banner, setBanner] = useState<{ tone: BannerTone; label: string }>({
    tone: "idle",
    label: "Menunggu data awal dari service simulasi caching.",
  });

  const activeScenario = useMemo<ScenarioOption | null>(() => {
    return catalog?.scenarios.find((scenario) => scenario.key === selection.scenario) || null;
  }, [catalog, selection.scenario]);

  const maxLatency = useMemo(() => {
    if (!result?.traces.length) return 1;
    return Math.max(...result.traces.map((trace) => trace.latencyMs));
  }, [result]);

  useEffect(() => {
    let active = true;

    async function bootstrap() {
      setBooting(true);
      setBanner({ tone: "running", label: "Memuat katalog simulasi dan status cache..." });

      try {
        const [catalogPayload, statusPayload] = await Promise.all([fetchCatalog(), fetchStatus()]);
        if (!active) return;

        const nextSelection = {
          scenario:
            catalogPayload.scenarios.find((entry) => entry.key === DEFAULT_SELECTION.scenario)?.key ||
            catalogPayload.scenarios[0]?.key ||
            DEFAULT_SELECTION.scenario,
          requestCount: catalogPayload.defaults.requestCount,
          key: catalogPayload.defaults.key,
          slug: catalogPayload.defaults.slug,
        };

        startTransition(() => {
          setCatalog(catalogPayload);
          setStatus(statusPayload);
          setSelection(nextSelection);
        });

        const runPayload = await runSimulation(nextSelection);
        if (!active) return;

        startTransition(() => {
          setResult(runPayload.result);
          setStatus(runPayload.status);
        });
        setBanner({ tone: "success", label: `${runPayload.result.label} siap untuk dipresentasikan.` });
      } catch (error) {
        if (!active) return;

        setBanner({
          tone: "error",
          label: error instanceof Error ? error.message : "Gagal memuat dashboard caching.",
        });
      } finally {
        if (active) {
          setBooting(false);
        }
      }
    }

    void bootstrap();

    return () => {
      active = false;
    };
  }, []);

  const executeScenario = async (nextSelection = selection) => {
    setRunning(true);
    setBanner({ tone: "running", label: `Menjalankan skenario ${activeScenario?.label || nextSelection.scenario}...` });

    try {
      const payload = await runSimulation(nextSelection);
      startTransition(() => {
        setResult(payload.result);
        setStatus(payload.status);
      });
      setBanner({ tone: "success", label: `${payload.result.label} selesai. Analisis terbaru sudah tampil.` });
    } catch (error) {
      setBanner({
        tone: "error",
        label: error instanceof Error ? error.message : "Gagal menjalankan simulasi.",
      });
    } finally {
      setRunning(false);
    }
  };

  const refresh = async () => {
    setBanner({ tone: "running", label: "Mengambil status cache terbaru dari service..." });
    try {
      const payload = await fetchStatus();
      setStatus(payload);
      setBanner({ tone: "idle", label: "Snapshot cache diperbarui tanpa menjalankan skenario baru." });
    } catch (error) {
      setBanner({
        tone: "error",
        label: error instanceof Error ? error.message : "Gagal mengambil status cache.",
      });
    }
  };

  const reset = async () => {
    setRunning(true);
    setBanner({ tone: "running", label: "Mereset local cache, Redis, dan edge POP..." });
    try {
      const payload = await resetSimulation();
      setStatus(payload);
      setResult(null);
      setBanner({ tone: "idle", label: "Cache kosong kembali. Pilih skenario dan jalankan ulang." });
    } catch (error) {
      setBanner({
        tone: "error",
        label: error instanceof Error ? error.message : "Gagal mereset simulasi.",
      });
    } finally {
      setRunning(false);
    }
  };

  const observatoryCards = [
    {
      icon: Layers3,
      label: "L1 Local Cache",
      description: "Cache per-node bergaya Memcached untuk hit tercepat, tetapi tidak dibagi ke node lain.",
    },
    {
      icon: Database,
      label: "L2 Redis Cache",
      description: "Cache global lintas instance untuk hot key dan konsistensi baca yang lebih baik.",
    },
    {
      icon: Cloud,
      label: "CDN Edge",
      description: "Asset statis disalin ke POP regional agar konten dekat dengan user.",
    },
    {
      icon: ArrowRightLeft,
      label: "Invalidation & Eviction",
      description: "TTL, refresh ahead, invalidation, dan LRU eviction dibuka transparan untuk demo dosen.",
    },
  ];

  const datasetPreview = status?.dataset.slice(0, 4) || [];

  return (
    <div className="min-h-screen text-[#1b251e]">
      <div className="mx-auto w-full max-w-[1480px] px-4 py-8 sm:px-6 lg:px-8">
        <header className="relative overflow-hidden rounded-[2rem] border border-[#dfd2c0] bg-[linear-gradient(135deg,rgba(255,250,244,0.92),rgba(250,241,227,0.95))] p-6 shadow-[0_28px_60px_rgba(46,35,24,0.08)] sm:p-8">
          <div className="absolute inset-y-0 right-0 hidden w-[34%] bg-[radial-gradient(circle_at_top,rgba(19,78,74,0.16),transparent_48%),radial-gradient(circle_at_bottom,rgba(214,122,52,0.22),transparent_42%)] lg:block" />
          <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <div className="flex items-center gap-3 text-xs uppercase tracking-[0.3em] text-[#8b6d4e]">
                <Zap className="size-4" />
                Scalable System Design - Caching & CDN Observatory
              </div>
              <h1 className="mt-4 text-4xl leading-tight text-[#1b251e] sm:text-5xl">
                Simulasi strategi caching yang siap dipresentasikan di localhost dan terminal.
              </h1>
              <p className="mt-4 max-w-2xl text-base leading-8 text-[#675d52] sm:text-lg">
                Dashboard ini mengikuti pola pengerjaan TUGAS 1, tetapi tema dan mekanismenya diganti total
                ke dunia cache: cache aside, read through, write through, write back, refresh ahead,
                invalidation, eviction, dan CDN edge.
              </p>
            </div>

            <div className={`flex min-h-14 items-center gap-3 rounded-2xl border px-4 py-3 shadow-sm ${BANNER_STYLES[banner.tone]}`}>
              {banner.tone === "running" ? <RefreshCw className="size-4 animate-spin" /> : <Activity className="size-4" />}
              <span className="max-w-sm text-sm leading-6">{banner.label}</span>
            </div>
          </div>
        </header>

        <section className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {observatoryCards.map((card, index) => (
            <motion.div
              key={card.label}
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08 * index, duration: 0.35 }}
            >
              <Card className="h-full gap-0 border-[#dfd2c0] bg-white/76">
                <CardContent className="p-5">
                  <span className="grid size-12 place-items-center rounded-2xl bg-[#edf5f1] text-[#134e4a]">
                    <card.icon className="size-6" />
                  </span>
                  <h2 className="mt-4 text-2xl text-[#1f2a21]">{card.label}</h2>
                  <p className="mt-3 text-sm leading-7 text-[#6f6559]">{card.description}</p>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </section>

        <main className="mt-8 grid gap-6 xl:grid-cols-[1.02fr_1.38fr]">
          <div className="grid gap-6">
            <ControlPanel
              value={selection}
              scenarios={catalog?.scenarios || []}
              items={catalog?.items || []}
              assets={catalog?.cdnAssets || []}
              running={running || booting || !catalog}
              onChange={setSelection}
              onRun={() => void executeScenario()}
              onRefresh={() => void refresh()}
              onReset={() => void reset()}
            />

            <Card className="gap-0 border-[#dfd2c0] bg-white/80">
              <CardHeader>
                <div className="flex items-center gap-2 text-xs uppercase tracking-[0.22em] text-[#8b6f4e]">
                  <Play className="size-4" />
                  Scenario Focus
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <CardTitle className="text-2xl text-[#1f2a21]">
                    {activeScenario?.label || "Pilih skenario"}
                  </CardTitle>
                  {activeScenario ? (
                    <Badge variant="outline" className={FAMILY_STYLES[activeScenario.family] || FAMILY_STYLES.read}>
                      {activeScenario.family}
                    </Badge>
                  ) : null}
                </div>
                <CardDescription className="text-[#6f6559]">
                  {activeScenario?.description || "Data skenario akan tampil setelah katalog terbaca."}
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3">
                {datasetPreview.map((item) => (
                  <div key={item.key} className="rounded-2xl border border-[#ece2d4] bg-[#fffaf3] px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium text-[#203025]">{item.title}</span>
                      <Badge variant="outline" className="border-[#dfd2c0] bg-white/70 text-[#7b6d5b]">
                        v{item.version}
                      </Badge>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-[#6f6559]">{item.summary}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-6">
            <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <StatCard
                label="Average Latency"
                value={result ? fmtMs(result.averageLatencyMs) : "-"}
                detail="Rata-rata waktu tanggap pada skenario terakhir."
                accent="bg-[#134e4a]"
              />
              <StatCard
                label="Hit Rate"
                value={result ? fmtPct(result.hitRate) : "-"}
                detail="Persentase request yang berhasil dilayani cache."
                accent="bg-[#d67a34]"
              />
              <StatCard
                label="Hot Speedup"
                value={result ? fmtPct(result.hotSpeedupPct) : "-"}
                detail="Percepatan request panas dibanding cold miss pertama."
                accent="bg-[#b8441f]"
              />
              <StatCard
                label="DB Reads"
                value={result ? metricValue(result.metrics.db.reads) : "-"}
                detail="Semakin kecil angkanya, semakin besar beban yang dihemat cache."
                accent="bg-[#3b6d83]"
              />
            </section>

            <Card className="gap-0 border-[#dfd2c0] bg-white/82">
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-xs uppercase tracking-[0.22em] text-[#8b6f4e]">
                      <Clock3 className="size-4" />
                      Result Timeline
                    </div>
                    <CardTitle className="mt-2 text-3xl text-[#1f2a21]">
                      {result?.label || "Belum ada hasil simulasi"}
                    </CardTitle>
                    <CardDescription className="mt-2 text-[#6f6559]">
                      {result?.headline || "Jalankan simulasi untuk melihat perpindahan request antar lapisan cache."}
                    </CardDescription>
                  </div>
                  {result ? (
                    <div className="rounded-2xl border border-[#e8dccd] bg-[#fffaf3] px-4 py-3 text-sm text-[#6f6559]">
                      <p>Cold miss: {fmtMs(result.coldLatencyMs)}</p>
                      <p>Fastest: {fmtMs(result.fastestMs)}</p>
                      <p>Slowest: {fmtMs(result.slowestMs)}</p>
                    </div>
                  ) : null}
                </div>
              </CardHeader>
              <CardContent className="grid gap-4">
                <AnimatePresence mode="wait">
                  {result ? (
                    <motion.div
                      key={result.scenario}
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={{ duration: 0.28 }}
                      className="grid gap-4"
                    >
                      {result.traces.map((trace) => (
                        <TraceRow key={`${result.scenario}-${trace.step}-${trace.key}`} trace={trace} maxLatency={maxLatency} />
                      ))}
                    </motion.div>
                  ) : (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="rounded-[1.5rem] border border-dashed border-[#d7cbb9] bg-[#fbf6ee] px-6 py-10 text-center text-[#6f6559]">
                      Hasil simulasi akan muncul di sini setelah skenario dijalankan.
                    </motion.div>
                  )}
                </AnimatePresence>
              </CardContent>
            </Card>

            <section className="grid gap-6 xl:grid-cols-2">
              <CacheEntriesCard
                title="L1 Local Memory"
                subtitle="Menjelaskan konsep Memcached-style cache pada sisi aplikasi."
                entries={(status?.caches.local.entries || []).map((entry) => ({
                  key: entry.key,
                  version: entry.version,
                  ttl: fmtMs(entry.expiresInMs),
                }))}
                footer={`hit ${metricValue(status?.caches.local.stats.hits)} | miss ${metricValue(status?.caches.local.stats.misses)} | eviction ${metricValue(status?.caches.local.stats.evictions)}`}
              />
              <CacheEntriesCard
                title="L2 Redis Cache"
                subtitle="Cache global untuk beberapa instance aplikasi atau service." 
                entries={(status?.caches.redis.entries || []).map((entry) => ({
                  key: entry.key,
                  version: entry.version,
                  ttl: `${entry.ttlSec}s`,
                }))}
                footer={`hit ${metricValue(status?.caches.redis.stats.hits)} | miss ${metricValue(status?.caches.redis.stats.misses)} | invalidation ${metricValue(status?.caches.redis.stats.invalidations)}`}
              />
            </section>

            <section className="grid gap-6 xl:grid-cols-2">
              <Card className="gap-0 border-[#dbe3f0] bg-white/82">
                <CardHeader>
                  <div className="flex items-center gap-2 text-xs uppercase tracking-[0.22em] text-[#6f8db1]">
                    <Globe className="size-4" />
                    CDN Regions
                  </div>
                  <CardTitle className="text-2xl text-[#203b5b]">Edge POP Snapshot</CardTitle>
                  <CardDescription className="text-[#5f7695]">
                    Bandingkan efek edge cache Jakarta dan Singapore untuk distribusi konten statis.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4">
                  {(status?.edges || []).map((edge) => (
                    <EdgeCard key={edge.region} edge={edge} />
                  ))}
                </CardContent>
              </Card>

              <Card className="gap-0 border-[#dfd2c0] bg-white/82">
                <CardHeader>
                  <div className="flex items-center gap-2 text-xs uppercase tracking-[0.22em] text-[#8b6f4e]">
                    <Boxes className="size-4" />
                    Lecture Notes
                  </div>
                  <CardTitle className="text-2xl text-[#1f2a21]">Poin yang bisa dijelaskan ke dosen</CardTitle>
                  <CardDescription className="text-[#6f6559]">
                    Ringkas, langsung relevan dengan slide PPT dan hasil simulasi terakhir.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 text-sm leading-7 text-[#675d52]">
                  {(result?.notes || [
                    "Cache hit menurunkan latency karena data tidak perlu kembali ke database.",
                    "Redis cocok sebagai cache global, sedangkan local cache cocok untuk hit tercepat per node.",
                    "CDN edge menyimpan konten statis lebih dekat ke pengguna sehingga latency antar region berbeda.",
                  ]).map((note) => (
                    <div key={note} className="rounded-2xl border border-[#ece2d4] bg-[#fffaf3] px-4 py-3">
                      {note}
                    </div>
                  ))}
                  {result?.consistency ? (
                    <div className="rounded-2xl border border-[#ece2d4] bg-[#fffaf3] px-4 py-3">
                      Mode konsistensi skenario ini: <strong>{result.consistency}</strong>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            </section>

            <section className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
              <Card className="gap-0 border-[#dfd2c0] bg-white/82">
                <CardHeader>
                  <div className="flex items-center gap-2 text-xs uppercase tracking-[0.22em] text-[#8b6f4e]">
                    <Server className="size-4" />
                    Origin Activity
                  </div>
                  <CardTitle className="text-2xl text-[#1f2a21]">Log event service</CardTitle>
                  <CardDescription className="text-[#6f6559]">
                    Event ini akan sinkron dengan log terminal container saat Anda demo di localhost.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3">
                  {(status?.recentEvents || []).slice(0, 10).map((event) => (
                    <EventCard key={`${event.time}-${event.event}`} event={event} />
                  ))}
                </CardContent>
              </Card>

              <Card className="gap-0 border-[#dfd2c0] bg-white/82">
                <CardHeader>
                  <div className="flex items-center gap-2 text-xs uppercase tracking-[0.22em] text-[#8b6f4e]">
                    <Activity className="size-4" />
                    System Counters
                  </div>
                  <CardTitle className="text-2xl text-[#1f2a21]">Infra snapshot</CardTitle>
                  <CardDescription className="text-[#6f6559]">
                    Counter ini membantu menjelaskan dampak cache terhadap beban database dan write path.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 text-sm">
                  <div className="rounded-2xl border border-[#ece2d4] bg-[#fffaf3] px-4 py-4">
                    <p className="text-xs uppercase tracking-[0.18em] text-[#8a7457]">Database</p>
                    <p className="mt-2 text-[#263227]">Reads: {metricValue(status?.database.reads)}</p>
                    <p className="text-[#263227]">Writes: {metricValue(status?.database.writes)}</p>
                    <p className="text-[#263227]">Asset reads: {metricValue(status?.database.assetReads)}</p>
                  </div>
                  <div className="rounded-2xl border border-[#ece2d4] bg-[#fffaf3] px-4 py-4">
                    <p className="text-xs uppercase tracking-[0.18em] text-[#8a7457]">Write Back Buffer</p>
                    <p className="mt-2 text-[#263227]">Buffered writes: {metricValue(status?.writeBack.bufferedWrites)}</p>
                    <p className="text-[#263227]">Flushed writes: {metricValue(status?.writeBack.flushedWrites)}</p>
                    <p className="text-[#263227]">Pending keys: {metricValue(status?.caches.writeBackBuffer.length)}</p>
                  </div>
                  <div className="rounded-2xl border border-[#ece2d4] bg-[#fffaf3] px-4 py-4">
                    <p className="text-xs uppercase tracking-[0.18em] text-[#8a7457]">Config</p>
                    <p className="mt-2 text-[#263227]">DB delay: {metricValue(status?.config.databaseDelayMs)} ms</p>
                    <p className="text-[#263227]">Local TTL: {metricValue(status?.config.localCacheTtlMs)} ms</p>
                    <p className="text-[#263227]">Redis TTL: {metricValue(status?.config.redisCacheTtlSec)} s</p>
                  </div>
                </CardContent>
              </Card>
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}
