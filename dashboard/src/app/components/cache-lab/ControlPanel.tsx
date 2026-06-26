import { Activity, Play, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Separator } from "../ui/separator";
import type { AssetItem, CatalogItem, ScenarioOption, ScenarioSelection } from "./types";

interface ControlPanelProps {
  value: ScenarioSelection;
  scenarios: ScenarioOption[];
  items: CatalogItem[];
  assets: AssetItem[];
  running: boolean;
  onChange: (next: ScenarioSelection) => void;
  onRun: () => void;
  onRefresh: () => void;
  onReset: () => void;
}

function selectClasses() {
  return "border-input bg-input-background focus-visible:border-ring focus-visible:ring-ring/50 h-10 w-full rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-[3px]";
}

export function ControlPanel({
  value,
  scenarios,
  items,
  assets,
  running,
  onChange,
  onRun,
  onRefresh,
  onReset,
}: ControlPanelProps) {
  const activeScenario = scenarios.find((scenario) => scenario.key === value.scenario);
  const isCdn = value.scenario.startsWith("cdn-");
  const isReadBurst = [
    "baseline-db",
    "cache-aside-local",
    "cache-aside-redis",
    "read-through",
  ].includes(value.scenario);

  return (
    <Card className="gap-0 overflow-hidden border-[#d9cbb9] bg-white/80 shadow-[0_18px_50px_rgba(45,35,24,0.08)] backdrop-blur">
      <CardHeader className="border-b border-[#e7dccd] bg-[#fff8ef]/80">
        <div className="flex items-center gap-2 text-xs uppercase tracking-[0.24em] text-[#8b6f4e]">
          <Activity className="size-4" />
          Simulation Control
        </div>
        <CardTitle className="text-2xl text-[#1f2a21]">Run Caching Scenario</CardTitle>
        <CardDescription className="text-[#6f6559]">
          Pilih strategi cache dari PPT, jalankan skenario, lalu baca hit rate, latency, dan jejak
          cache yang dihasilkan.
        </CardDescription>
      </CardHeader>

      <CardContent className="grid gap-5 pt-5">
        <div className="grid gap-2">
          <Label htmlFor="scenario">Scenario</Label>
          <select
            id="scenario"
            className={selectClasses()}
            disabled={running}
            value={value.scenario}
            onChange={(event) => onChange({ ...value, scenario: event.target.value })}
          >
            {scenarios.map((scenario) => (
              <option key={scenario.key} value={scenario.key}>
                {scenario.label}
              </option>
            ))}
          </select>
          <p className="text-sm leading-6 text-[#7b6f62]">{activeScenario?.description}</p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="request-count">Jumlah Request</Label>
            <Input
              id="request-count"
              type="number"
              min={3}
              max={8}
              disabled={running || !isReadBurst}
              value={value.requestCount}
              onChange={(event) =>
                onChange({
                  ...value,
                  requestCount: Number(event.target.value) || 3,
                })
              }
            />
            <p className="text-xs text-[#8b7f71]">
              {isReadBurst
                ? "Dipakai untuk skenario read-heavy agar hit rate terlihat jelas."
                : "Untuk skenario ini jumlah langkah sudah ditentukan oleh workflow simulasi."}
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor={isCdn ? "asset-slug" : "dataset-key"}>
              {isCdn ? "CDN Asset" : "Dataset Key"}
            </Label>
            {isCdn ? (
              <select
                id="asset-slug"
                className={selectClasses()}
                disabled={running}
                value={value.slug}
                onChange={(event) => onChange({ ...value, slug: event.target.value })}
              >
                {assets.map((asset) => (
                  <option key={asset.slug} value={asset.slug}>
                    {asset.title}
                  </option>
                ))}
              </select>
            ) : (
              <select
                id="dataset-key"
                className={selectClasses()}
                disabled={running}
                value={value.key}
                onChange={(event) => onChange({ ...value, key: event.target.value })}
              >
                {items.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.title}
                  </option>
                ))}
              </select>
            )}
            <p className="text-xs text-[#8b7f71]">
              {isCdn
                ? "Asset ini diambil dari origin lalu di-cache di edge terdekat."
                : "Gunakan hot key seperti catalog populer untuk mendemonstrasikan cache hit."}
            </p>
          </div>
        </div>

        <Separator className="bg-[#e7dccd]" />

        <div className="grid gap-2.5 md:grid-cols-3">
          <Button onClick={onRun} disabled={running} className="h-11 bg-[#134e4a] text-[#f7f3ea] hover:bg-[#0f3f3c]">
            <Play className="size-4" />
            {running ? "Menjalankan..." : "Jalankan Simulasi"}
          </Button>
          <Button
            variant="outline"
            onClick={onRefresh}
            disabled={running}
            className="h-11 border-[#d2c4b4] bg-white/70 text-[#28433c] hover:bg-[#f7efe6]"
          >
            <RefreshCw className="size-4" />
            Refresh Status
          </Button>
          <Button
            variant="outline"
            onClick={onReset}
            disabled={running}
            className="h-11 border-[#d2c4b4] bg-white/70 text-[#6f2e1d] hover:bg-[#fff2eb]"
          >
            <Trash2 className="size-4" />
            Reset Cache
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
