import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconLock, IconLockOpen, IconTruckDelivery } from "@tabler/icons-react";
import { cordon, drain, errorText, formatCpu, formatMemory, nodeHistory, nodeSummary, prometheusTarget, type DrainReport, type NodeHistory, type NodeSummary } from "../api";
import LineChart from "./LineChart";
import ConfirmDialog from "./ConfirmDialog";
import { useReadOnly } from "../readOnly";
import TypeToConfirm, { confirms } from "./TypeToConfirm";
import { usePoll } from "../usePoll";

interface Props {
  name: string;
  production: boolean;
  context: string;
}

const REFRESH_MS = 10_000;

/** A node's capacity against what pods request and actually use, its health, and cordon/drain. */
export default function NodeOverview({ name, production, context }: Props) {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<NodeSummary | null>(null);
  const [history, setHistory] = useState<NodeHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<DrainReport | null>(null);
  const [result, setResult] = useState<DrainReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmCordon, setConfirmCordon] = useState(false);
  const readOnly = useReadOnly();

  const load = () => nodeSummary(name).then((s) => (setSummary(s), setError(null)), (e) => setError(errorText(e)));
  usePoll(load, REFRESH_MS, [name]);
  useEffect(() => {
    prometheusTarget().then(
      (target) => {
        if (target) nodeHistory(name, 360).then(setHistory, () => {});
      },
      () => {},
    );
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

  if (!summary) return error ? <div className="error-bar">{error}</div> : <div className="empty">{t("common.loading")}</div>;
  const s = summary;

  return (
    <div className="node-overview">
      {error && <div className="error-bar">{error}</div>}
      <div className="node-actions">
        {s.unschedulable ? <span className="warn">{t("nodes.cordoned")}</span> : <span className="faint">{t("nodes.schedulable")}</span>}
        <span className="spacer" />
        <button disabled={busy || readOnly} onClick={() => (s.unschedulable ? void act(() => cordon(name, false)) : setConfirmCordon(true))}>
          {s.unschedulable ? <IconLockOpen size={14} /> : <IconLock size={14} />} {s.unschedulable ? t("nodes.uncordon") : t("nodes.cordon")}
        </button>
        <button disabled={busy || readOnly} onClick={() => void act(async () => setPreview(await drain(name, null, true)))}>
          <IconTruckDelivery size={14} /> {t("nodes.drainEllipsis")}
        </button>
      </div>

      <div className="capacity">
        <Capacity label="CPU" total={s.cpuAllocatableMillis} requested={s.cpuRequestedMillis} used={s.cpuUsageMillis} format={formatCpu} />
        <Capacity label={t("nodes.memory")} total={s.memoryAllocatableBytes} requested={s.memoryRequestedBytes} used={s.memoryUsageBytes} format={formatMemory} />
        <Capacity label="Pods" total={s.maxPods} requested={s.pods} used={null} format={(v) => String(Math.round(v))} />
      </div>

      {history && (
        <div className="charts">
          <section className="chart-block">
            <header>
              <strong>CPU</strong> <span className="faint">{t("nodes.last6h", { source: history.source })}</span>
            </header>
            <LineChart series={history.cpu} refs={[{ label: t("nodes.allocatable"), value: s.cpuAllocatableMillis / 1000, kind: "limit" }]} format={(v) => formatCpu(v * 1000)} height={120} />
          </section>
          <section className="chart-block">
            <header>
              <strong>{t("nodes.memory")}</strong> <span className="faint">{t("nodes.workingSet")}</span>
            </header>
            <LineChart series={history.memory} refs={[{ label: t("nodes.allocatable"), value: s.memoryAllocatableBytes, kind: "limit" }]} format={formatMemory} height={120} />
          </section>
        </div>
      )}

      <div className="node-section">
        <div className="related-title">{t("nodes.conditions")}</div>
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
          <div className="related-title">{t("nodes.taints")}</div>
          {s.taints.map((taint) => (
            <code key={taint} className="node-taint">
              {taint}
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
          title={t("nodes.cordonTitle", { name })}
          message={t("nodes.cordonMessage", { cluster: context })}
          confirmLabel={t("nodes.cordon")}
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
            <h3>{t("nodes.drainResult", { name })}</h3>
            <DrainList report={result} done />
            <div className="modal-actions">
              <button className="primary" onClick={() => setResult(null)}>
                {t("common.close")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Capacity({ label, total, requested, used, format }: { label: string; total: number; requested: number; used: number | null; format: (v: number) => string }) {
  const { t } = useTranslation();
  const pct = (v: number) => (total > 0 ? Math.min(100, (v / total) * 100) : 0);
  return (
    <div className="capacity-row">
      <div className="capacity-head">
        <strong>{label}</strong>
        <span className="faint">
          {[
            t("nodes.requested", { value: format(requested), pct: Math.round(pct(requested)) }),
            used !== null && t("nodes.used", { value: format(used), pct: Math.round(pct(used)) }),
            t("nodes.allocatableValue", { value: format(total) }),
          ]
            .filter(Boolean)
            .join(" · ")}
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
  const { t } = useTranslation();
  return (
    <div className="drain-list">
      <div>
        <strong>{done ? t("nodes.evicted") : t("nodes.willBeEvicted")}</strong> <span className="faint">{report.evicted.length}</span>
      </div>
      {report.evicted.map((p) => (
        <code key={p}>{p}</code>
      ))}
      {report.failed.length > 0 && (
        <>
          <div className="bad">
            <strong>{t("nodes.notEvicted")}</strong> {report.failed.length}
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
            <strong>{t("nodes.leftAlone")}</strong> <span className="faint">{report.skipped.length}</span>
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
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  const ok = !production || confirms(typed, name);
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h3>{t("nodes.drainTitle", { name })}</h3>
        <p>{t("nodes.drainMessage", { cluster: context })}</p>
        <DrainList report={preview} />
        {production && <TypeToConfirm expected={name} value={typed} onChange={setTyped} />}
        <div className="modal-actions">
          <button onClick={onCancel}>{t("common.cancel")}</button>
          <button className="danger" disabled={!ok} onClick={onConfirm}>
            {t("nodes.drain")}
          </button>
        </div>
      </div>
    </div>
  );
}
