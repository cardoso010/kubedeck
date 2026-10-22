import { useEffect, useMemo, useState } from "react";
import { errorText, formatCpu, formatMemory, formatRate, podHistory, podUsage, prometheusTarget, type ContainerUsage, type PodHistory, type PodUsage, type Series } from "../api";
import LineChart, { type RefLine } from "./LineChart";

interface Props {
  namespace: string;
  pod: string;
  /** Container picked in the drawer header; null shows them all. */
  container: string | null;
}

const RANGES = [
  { label: "15m", minutes: 15 },
  { label: "1h", minutes: 60 },
  { label: "6h", minutes: 360 },
  { label: "24h", minutes: 1440 },
  { label: "7d", minutes: 10080 },
];
const USAGE_EVERY_MS = 10_000;
const HISTORY_EVERY_MS = 30_000;
/** Live mode keeps this many samples (~30 min at 10s). */
const LIVE_MAX = 180;

const percent = (used: number | null, of: number | null) => (used !== null && of ? Math.round((used / of) * 100) : null);

/**
 * CPU and memory against requests and limits, restarts and the last termination, plus
 * charts: history from Prometheus when the cluster has one, otherwise live samples from
 * metrics-server collected while this tab is open.
 */
export default function PodMetrics({ namespace, pod, container }: Props) {
  const [usage, setUsage] = useState<PodUsage | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [prometheus, setPrometheus] = useState<string | null | undefined>(undefined);
  const [minutes, setMinutes] = useState(60);
  const [history, setHistory] = useState<PodHistory | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [live, setLive] = useState<{ t: number; containers: ContainerUsage[] }[]>([]);

  useEffect(() => {
    prometheusTarget().then(setPrometheus, () => setPrometheus(null));
  }, []);

  // Current usage; in live mode each sample also feeds the charts.
  useEffect(() => {
    let stopped = false;
    const tick = () =>
      podUsage(namespace, pod).then(
        (u) => {
          if (stopped) return;
          setUsage(u);
          setUsageError(null);
          if (u.metricsServer) setLive((prev) => [...prev, { t: Date.now() / 1000, containers: u.containers }].slice(-LIVE_MAX));
        },
        (e) => !stopped && setUsageError(errorText(e)),
      );
    void tick();
    const timer = setInterval(tick, USAGE_EVERY_MS);
    return () => ((stopped = true), clearInterval(timer));
  }, [namespace, pod]);

  useEffect(() => {
    if (!prometheus) return;
    let stopped = false;
    const load = () =>
      podHistory(namespace, pod, minutes).then(
        (h) => !stopped && (setHistory(h), setHistoryError(null)),
        (e) => !stopped && setHistoryError(errorText(e)),
      );
    void load();
    const timer = setInterval(load, HISTORY_EVERY_MS);
    return () => ((stopped = true), clearInterval(timer));
  }, [prometheus, namespace, pod, minutes]);

  const containers = usage?.containers ?? [];
  const shown = container ? containers.filter((c) => c.name === container) : containers;
  const onlyOne = shown.length === 1 ? shown[0] : null;
  const pick = (list: Series[]) => (container ? list.filter((s) => s.name === container) : list);

  // Live series built from the metrics-server samples.
  const liveSeries = useMemo(() => {
    const build = (value: (c: ContainerUsage) => number | null) =>
      shown.map((c) => ({
        name: c.name,
        points: live.flatMap((s) => {
          const v = s.containers.find((x) => x.name === c.name);
          const n = v ? value(v) : null;
          return n === null ? [] : [[s.t, n] as [number, number]];
        }),
      }));
    return { cpu: build((c) => (c.cpuMillis === null ? null : c.cpuMillis / 1000)), memory: build((c) => c.memoryBytes) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, container, usage]);

  const cpu = history ? pick(history.cpu) : liveSeries.cpu;
  const memory = history ? pick(history.memory) : liveSeries.memory;
  // Requests and limits are drawn when one container is on the chart.
  const cpuRefs: RefLine[] = onlyOne
    ? [
        ...(onlyOne.cpuRequestMillis ? [{ label: "request", value: onlyOne.cpuRequestMillis / 1000, kind: "request" as const }] : []),
        ...(onlyOne.cpuLimitMillis ? [{ label: "limit", value: onlyOne.cpuLimitMillis / 1000, kind: "limit" as const }] : []),
      ]
    : [];
  const memoryRefs: RefLine[] = onlyOne
    ? [
        ...(onlyOne.memoryRequestBytes ? [{ label: "request", value: onlyOne.memoryRequestBytes, kind: "request" as const }] : []),
        ...(onlyOne.memoryLimitBytes ? [{ label: "limit", value: onlyOne.memoryLimitBytes, kind: "limit" as const }] : []),
      ]
    : [];

  return (
    <div className="pod-metrics">
      {usageError && <div className="error-bar">{usageError}</div>}

      <div className="usage-cards">
        {shown.map((c) => (
          <UsageCard key={c.name} c={c} showName={containers.length > 1} />
        ))}
        {usage && !usage.metricsServer && <div className="faint metrics-note">metrics-server is not available, so current usage is unknown.</div>}
      </div>

      <div className="metrics-toolbar">
        {prometheus === undefined ? (
          <span className="faint">Looking for Prometheus…</span>
        ) : prometheus ? (
          <>
            <span className="faint">
              History from <code>{prometheus}</code>
            </span>
            <div className="segmented">
              {RANGES.map((r) => (
                <button key={r.label} className={minutes === r.minutes ? "active" : ""} onClick={() => setMinutes(r.minutes)}>
                  {r.label}
                </button>
              ))}
            </div>
          </>
        ) : (
          <span className="faint">Live since this tab opened, every 10s. History, network and throttling need Prometheus in the cluster.</span>
        )}
      </div>
      {historyError && <div className="error-bar">{historyError}</div>}

      <div className="charts">
        <ChartBlock title="CPU" hint="cores">
          <LineChart series={cpu} refs={cpuRefs} format={(v) => formatCpu(v * 1000)} />
        </ChartBlock>
        <ChartBlock title="Memory" hint="working set">
          <LineChart series={memory} refs={memoryRefs} format={formatMemory} />
        </ChartBlock>
        {history && (
          <>
            <ChartBlock title="Network" hint="pod, per second">
              <LineChart series={history.network} format={formatRate} />
            </ChartBlock>
            <ChartBlock title="CPU throttling" hint="share of periods throttled by the CPU limit">
              <LineChart series={pick(history.throttling)} format={(v) => `${Math.round(v * 100)}%`} max={1} />
            </ChartBlock>
          </>
        )}
      </div>
    </div>
  );
}

function ChartBlock({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="chart-block">
      <header>
        <strong>{title}</strong> <span className="faint">{hint}</span>
      </header>
      {children}
    </section>
  );
}

function UsageCard({ c, showName }: { c: ContainerUsage; showName: boolean }) {
  const cpuPct = percent(c.cpuMillis, c.cpuLimitMillis ?? c.cpuRequestMillis);
  const memPct = percent(c.memoryBytes, c.memoryLimitBytes ?? c.memoryRequestBytes);
  const oom = c.lastTermination?.startsWith("OOMKilled");
  return (
    <div className="usage-card">
      {showName && <div className="usage-card-name">{c.name}</div>}
      <div className="usage-grid">
        <Meter
          label="CPU"
          value={c.cpuMillis === null ? "–" : formatCpu(c.cpuMillis)}
          detail={[c.cpuRequestMillis && `req ${formatCpu(c.cpuRequestMillis)}`, c.cpuLimitMillis && `lim ${formatCpu(c.cpuLimitMillis)}`].filter(Boolean).join(" · ") || "no request or limit"}
          pct={cpuPct}
          against={c.cpuLimitMillis ? "limit" : "request"}
        />
        <Meter
          label="Memory"
          value={c.memoryBytes === null ? "–" : formatMemory(c.memoryBytes)}
          detail={[c.memoryRequestBytes && `req ${formatMemory(c.memoryRequestBytes)}`, c.memoryLimitBytes && `lim ${formatMemory(c.memoryLimitBytes)}`].filter(Boolean).join(" · ") || "no request or limit"}
          pct={memPct}
          against={c.memoryLimitBytes ? "limit" : "request"}
        />
        <div className="meter">
          <span className="meter-label">Restarts</span>
          <span className={`meter-value ${c.restarts > 0 ? "warn" : ""}`}>{c.restarts}</span>
          <span className="meter-detail">{c.state}</span>
        </div>
        <div className="meter">
          <span className="meter-label">Last termination</span>
          <span className={`meter-value small ${oom ? "bad" : ""}`} title={c.lastTermination ?? undefined}>
            {c.lastTermination?.split(" at ")[0] ?? "none"}
          </span>
          <span className="meter-detail">{c.lastTermination?.split(" at ")[1] ? new Date(c.lastTermination.split(" at ")[1]).toLocaleString() : ""}</span>
        </div>
      </div>
    </div>
  );
}

function Meter({ label, value, detail, pct, against }: { label: string; value: string; detail: string; pct: number | null; against: string }) {
  const level = pct === null ? "" : pct >= 90 ? "bad" : pct >= 70 ? "warn" : "ok";
  return (
    <div className="meter">
      <span className="meter-label">{label}</span>
      <span className="meter-value">
        {value} {pct !== null && <span className={`meter-pct ${level}`} title={`of ${against}`}>{pct}%</span>}
      </span>
      <span className="meter-detail">{detail}</span>
      {pct !== null && (
        <span className="meter-bar">
          <span className={level} style={{ width: `${Math.min(pct, 100)}%` }} />
        </span>
      )}
    </div>
  );
}
