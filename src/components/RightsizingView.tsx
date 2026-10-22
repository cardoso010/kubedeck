import { useEffect, useMemo, useState } from "react";
import { errorText, formatCpu, formatMemory, rightsizing, type KindInfo, type RightsizeRow } from "../api";

interface Props {
  namespaces: string[];
  kinds: KindInfo[];
  onOpen: (kindKey: string, namespace: string, name: string) => void;
}

const MI = 1024 * 1024;
/** Headroom over the observed peak when suggesting a request. */
const HEADROOM = 1.2;

type Verdict = "over" | "under" | "none" | "ok" | "nodata";

/** Suggested request: observed usage plus headroom, rounded up, never tiny. */
const suggestCpu = (used: number) => Math.max(10, Math.ceil((used * HEADROOM) / 5) * 5);
const suggestMemory = (used: number) => Math.max(32 * MI, Math.ceil((used * HEADROOM) / (8 * MI)) * 8 * MI);

function verdict(request: number | null, used: number | null, suggested: number | null, minWaste: number): Verdict {
  if (request === null) return "none";
  if (used === null || suggested === null) return "nodata";
  if (used > request) return "under";
  if (request > suggested * 2 && request - suggested >= minWaste) return "over";
  return "ok";
}

const LABEL: Record<Verdict, string> = { over: "over-provisioned", under: "above request", none: "no request", ok: "ok", nodata: "no data" };
const TONE: Record<Verdict, string> = { over: "warn", under: "bad", none: "warn", ok: "ok", nodata: "faint" };

interface Analysed extends RightsizeRow {
  cpu: { suggested: number | null; verdict: Verdict; reclaim: number };
  memory: { suggested: number | null; verdict: Verdict; reclaim: number };
}

function analyse(r: RightsizeRow): Analysed {
  const cpuSuggested = r.cpuUsageMillis === null ? null : suggestCpu(r.cpuUsageMillis);
  const memSuggested = r.memoryUsageBytes === null ? null : suggestMemory(r.memoryUsageBytes);
  const cpuVerdict = verdict(r.cpuRequestMillis, r.cpuUsageMillis, cpuSuggested, 50);
  const memVerdict = verdict(r.memoryRequestBytes, r.memoryUsageBytes, memSuggested, 64 * MI);
  return {
    ...r,
    cpu: { suggested: cpuSuggested, verdict: cpuVerdict, reclaim: cpuVerdict === "over" ? (r.cpuRequestMillis! - cpuSuggested!) * r.pods : 0 },
    memory: { suggested: memSuggested, verdict: memVerdict, reclaim: memVerdict === "over" ? (r.memoryRequestBytes! - memSuggested!) * r.pods : 0 },
  };
}

/** Requests against real usage per workload container, with suggested requests. */
export default function RightsizingView({ namespaces, kinds, onOpen }: Props) {
  const [data, setData] = useState<{ source: string; rows: RightsizeRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyIssues, setOnlyIssues] = useState(true);
  const [query, setQuery] = useState("");
  const nsKey = namespaces.join(",");

  useEffect(() => {
    let stale = false;
    setData(null);
    setError(null);
    rightsizing(namespaces).then(
      (d) => !stale && setData(d),
      (e) => !stale && setError(errorText(e)),
    );
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nsKey]);

  const rows = useMemo(() => (data?.rows ?? []).map(analyse), [data]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) => !onlyIssues || r.cpu.verdict !== "ok" || r.memory.verdict !== "ok")
      .filter((r) => !onlyIssues || !(r.cpu.verdict === "nodata" && r.memory.verdict === "nodata"))
      .filter((r) => !q || `${r.namespace} ${r.workload} ${r.container}`.toLowerCase().includes(q))
      .sort((a, b) => b.cpu.reclaim / 1000 + b.memory.reclaim / (1024 * MI) - (a.cpu.reclaim / 1000 + a.memory.reclaim / (1024 * MI)));
  }, [rows, onlyIssues, query]);

  const total = (f: (r: Analysed) => number | null) => rows.reduce((sum, r) => sum + (f(r) ?? 0) * r.pods, 0);
  const label = (key: string) => kinds.find((k) => k.key === key)?.label.replace(/s$/, "") ?? key;

  return (
    <section className="table rightsizing">
      <header className="table-toolbar">
        <h2>Rightsizing</h2>
        <span className="count">{data ? `${shown.length} of ${rows.length} containers` : "loading…"}</span>
        <div className="table-actions">
          <label className="check">
            <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} /> only what needs attention
          </label>
          <input placeholder="Filter…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </header>
      {error && <div className="error-bar">{error}</div>}
      {data && (
        <div className="rs-summary">
          <Stat label="CPU requested" value={formatCpu(total((r) => r.cpuRequestMillis))} />
          <Stat label="CPU used (peak)" value={formatCpu(total((r) => r.cpuUsageMillis))} />
          <Stat label="CPU reclaimable" value={formatCpu(rows.reduce((s, r) => s + r.cpu.reclaim, 0))} tone="warn" />
          <Stat label="Memory requested" value={formatMemory(total((r) => r.memoryRequestBytes))} />
          <Stat label="Memory used (peak)" value={formatMemory(total((r) => r.memoryUsageBytes))} />
          <Stat label="Memory reclaimable" value={formatMemory(rows.reduce((s, r) => s + r.memory.reclaim, 0))} tone="warn" />
          <span className="faint rs-source">
            {data.source}. Suggested request = peak × {HEADROOM}.
          </span>
        </div>
      )}
      <div className="rs-table">
        <div className="rs-row head">
          <div>Workload</div>
          <div>Container</div>
          <div>Pods</div>
          <div>CPU request → suggested</div>
          <div>CPU used</div>
          <div>Memory request → suggested</div>
          <div>Memory used</div>
        </div>
        {shown.map((r) => (
          <button key={`${r.namespace}/${r.kindKey}/${r.workload}/${r.container}`} className="rs-row" onClick={() => onOpen(r.kindKey, r.namespace, r.workload)}>
            <div className="rs-workload">
              <span className="kind-chip">{label(r.kindKey)}</span>
              <span className="faint">{r.namespace}/</span>
              {r.workload}
            </div>
            <div>{r.container}</div>
            <div>{r.pods}</div>
            <Cell request={r.cpuRequestMillis} suggested={r.cpu.suggested} verdict={r.cpu.verdict} format={formatCpu} />
            <div>{r.cpuUsageMillis === null ? "—" : formatCpu(r.cpuUsageMillis)}</div>
            <Cell request={r.memoryRequestBytes} suggested={r.memory.suggested} verdict={r.memory.verdict} format={formatMemory} />
            <div>{r.memoryUsageBytes === null ? "—" : formatMemory(r.memoryUsageBytes)}</div>
          </button>
        ))}
        {data && shown.length === 0 && <div className="empty">{onlyIssues ? "Every container's requests match its usage." : "No running pods in the selected namespaces."}</div>}
      </div>
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rs-stat">
      <span className="faint">{label}</span>
      <strong className={tone}>{value}</strong>
    </div>
  );
}

function Cell({ request, suggested, verdict, format }: { request: number | null; suggested: number | null; verdict: Verdict; format: (v: number) => string }) {
  return (
    <div className="rs-cell">
      <span>{request === null ? "—" : format(request)}</span>
      {suggested !== null && verdict !== "ok" && <span className="faint">→ {format(suggested)}</span>}
      <span className={`rs-verdict ${TONE[verdict]}`}>{LABEL[verdict]}</span>
    </div>
  );
}
