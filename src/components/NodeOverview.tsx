import { useEffect, useState } from "react";
import { IconLock, IconLockOpen, IconTruckDelivery } from "@tabler/icons-react";
import { cordon, drain, errorText, formatCpu, formatMemory, nodeHistory, nodeSummary, prometheusTarget, type DrainReport, type NodeHistory, type NodeSummary } from "../api";
import LineChart from "./LineChart";
import ConfirmDialog from "./ConfirmDialog";

interface Props {
  name: string;
  production: boolean;
  context: string;
}

const REFRESH_MS = 10_000;

/** A node's capacity against what pods request and actually use, its health, and cordon/drain. */
export default function NodeOverview({ name, production, context }: Props) {
  const [summary, setSummary] = useState<NodeSummary | null>(null);
  const [history, setHistory] = useState<NodeHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<DrainReport | null>(null);
  const [result, setResult] = useState<DrainReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmCordon, setConfirmCordon] = useState(false);

  const load = () => nodeSummary(name).then((s) => (setSummary(s), setError(null)), (e) => setError(errorText(e)));
  useEffect(() => {
    void load();
    const timer = setInterval(load, REFRESH_MS);
    prometheusTarget().then(
      (t) => {
        if (t) nodeHistory(name, 360).then(setHistory, () => {});
      },
      () => {},
    );
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (!summary) return error ? <div className="error-bar">{error}</div> : <div className="empty">Loading…</div>;
  const s = summary;

  return (
    <div className="node-overview">
      {error && <div className="error-bar">{error}</div>}
      <div className="node-actions">
        {s.unschedulable ? <span className="warn">Cordoned: no new pods are scheduled here.</span> : <span className="faint">Schedulable</span>}
        <span className="spacer" />
        <button disabled={busy} onClick={() => (s.unschedulable ? void act(() => cordon(name, false)) : setConfirmCordon(true))}>
          {s.unschedulable ? <IconLockOpen size={14} /> : <IconLock size={14} />} {s.unschedulable ? "Uncordon" : "Cordon"}
        </button>
        <button disabled={busy} onClick={() => void act(async () => setPreview(await drain(name, null, true)))}>
          <IconTruckDelivery size={14} /> Drain…
        </button>
      </div>

      <div className="capacity">
        <Capacity label="CPU" total={s.cpuAllocatableMillis} requested={s.cpuRequestedMillis} used={s.cpuUsageMillis} format={formatCpu} />
        <Capacity label="Memory" total={s.memoryAllocatableBytes} requested={s.memoryRequestedBytes} used={s.memoryUsageBytes} format={formatMemory} />
        <Capacity label="Pods" total={s.maxPods} requested={s.pods} used={null} format={(v) => String(Math.round(v))} />
      </div>

      {history && (
        <div className="charts">
          <section className="chart-block">
            <header>
              <strong>CPU</strong> <span className="faint">last 6h · {history.source}</span>
            </header>
            <LineChart series={history.cpu} refs={[{ label: "allocatable", value: s.cpuAllocatableMillis / 1000, kind: "limit" }]} format={(v) => formatCpu(v * 1000)} height={120} />
          </section>
          <section className="chart-block">
            <header>
              <strong>Memory</strong> <span className="faint">working set</span>
            </header>
            <LineChart series={history.memory} refs={[{ label: "allocatable", value: s.memoryAllocatableBytes, kind: "limit" }]} format={formatMemory} height={120} />
          </section>
        </div>
      )}

      <div className="node-section">
        <div className="related-title">Conditions</div>
        {s.conditions.map((c) => (
          <div key={c.type} className={`node-condition ${c.bad ? "bad" : ""}`}>
            <span className={`status-dot ${c.bad ? "bad" : "ok"}`} />
            <strong>{c.type}</strong>
            <span className="faint">{c.status}</span>
            <span className="faint node-condition-message">{c.message}</span>
          </div>
        ))}
      </div>
      {s.taints.length > 0 && (
        <div className="node-section">
          <div className="related-title">Taints</div>
          {s.taints.map((t) => (
            <code key={t} className="node-taint">
              {t}
            </code>
          ))}
        </div>
      )}
      <div className="node-section node-info">
        {s.info.map(([k, v]) => (
          <div key={k}>
            <span className="faint">{k}</span>
            <span>{v}</span>
          </div>
        ))}
      </div>

      {confirmCordon && (
        <ConfirmDialog
          title={`Cordon ${name}?`}
          message={`No new pods will be scheduled on this node of ${context}. Pods already there keep running.`}
          confirmLabel="Cordon"
          typeToConfirm={production ? name : undefined}
          onConfirm={() => (setConfirmCordon(false), void act(() => cordon(name, true)))}
          onCancel={() => setConfirmCordon(false)}
        />
      )}
      {preview && (
        <DrainDialog
          name={name}
          preview={preview}
          production={production}
          context={context}
          onCancel={() => setPreview(null)}
          onConfirm={() => {
            setPreview(null);
            void act(async () => setResult(await drain(name, null, false)));
          }}
        />
      )}
      {result && (
        <div className="modal-backdrop" onClick={() => setResult(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Drain of {name}</h3>
            <DrainList report={result} done />
            <div className="modal-actions">
              <button className="primary" onClick={() => setResult(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Capacity({ label, total, requested, used, format }: { label: string; total: number; requested: number; used: number | null; format: (v: number) => string }) {
  const pct = (v: number) => (total > 0 ? Math.min(100, (v / total) * 100) : 0);
  return (
    <div className="capacity-row">
      <div className="capacity-head">
        <strong>{label}</strong>
        <span className="faint">
          requested {format(requested)} ({Math.round(pct(requested))}%){used !== null && ` · used ${format(used)} (${Math.round(pct(used))}%)`} · allocatable {format(total)}
        </span>
      </div>
      <div className="capacity-bar">
        <span className="capacity-requested" style={{ width: `${pct(requested)}%` }} />
        {used !== null && <span className={`capacity-used ${pct(used) > 85 ? "bad" : pct(used) > 70 ? "warn" : ""}`} style={{ width: `${pct(used)}%` }} />}
      </div>
    </div>
  );
}

function DrainList({ report, done = false }: { report: DrainReport; done?: boolean }) {
  return (
    <div className="drain-list">
      <div>
        <strong>{done ? "Evicted" : "Will be evicted"}</strong> <span className="faint">{report.evicted.length}</span>
      </div>
      {report.evicted.map((p) => (
        <code key={p}>{p}</code>
      ))}
      {report.failed.length > 0 && (
        <>
          <div className="bad">
            <strong>Not evicted</strong> {report.failed.length}
          </div>
          {report.failed.map(([p, why]) => (
            <div key={p}>
              <code>{p}</code> <span className="faint">{why}</span>
            </div>
          ))}
        </>
      )}
      {report.skipped.length > 0 && (
        <>
          <div>
            <strong>Left alone</strong> <span className="faint">{report.skipped.length}</span>
          </div>
          {report.skipped.map(([p, why]) => (
            <div key={p}>
              <code>{p}</code> <span className="faint">{why}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function DrainDialog({ name, preview, production, context, onConfirm, onCancel }: { name: string; preview: DrainReport; production: boolean; context: string; onConfirm: () => void; onCancel: () => void }) {
  const [typed, setTyped] = useState("");
  const ok = !production || typed === name;
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h3>Drain {name}?</h3>
        <p>
          The node is cordoned, then each pod below is evicted on {context}. PodDisruptionBudgets are respected, so some evictions may be refused.
        </p>
        <DrainList report={preview} />
        {production && (
          <label className="field">
            <span>
              Type <code>{name}</code> to confirm
            </span>
            <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
          </label>
        )}
        <div className="modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="danger" disabled={!ok} onClick={onConfirm}>
            Drain
          </button>
        </div>
      </div>
    </div>
  );
}
