import { useEffect, useState } from "react";
import { IconArrowsMaximize } from "@tabler/icons-react";
import { errorText, expandVolume, formatMemory, prometheusTarget, volumeExpandInfo, volumeHistory, volumeUsage, type Series, type VolumeStats } from "../api";
import { useReadOnly } from "../readOnly";
import LineChart from "./LineChart";
import ConfirmDialog from "./ConfirmDialog";

interface Props {
  namespace: string;
  name: string;
  production: boolean;
  context: string;
}

const REFRESH_MS = 30_000;
const RANGES: [string, number][] = [
  ["24h", 24 * 60],
  ["7d", 7 * 24 * 60],
  ["30d", 30 * 24 * 60],
];

/** How full a claim is, how it filled up over time, and growing it. */
export default function VolumeView({ namespace, name, production, context }: Props) {
  const readOnly = useReadOnly();
  const [stats, setStats] = useState<VolumeStats | null | undefined>(undefined);
  const [source, setSource] = useState("");
  const [history, setHistory] = useState<Series[] | null>(null);
  const [range, setRange] = useState(RANGES[1][1]);
  const [hasProm, setHasProm] = useState(false);
  const [info, setInfo] = useState<Awaited<ReturnType<typeof volumeExpandInfo>> | null>(null);
  const [size, setSize] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const loadInfo = () => volumeExpandInfo(namespace, name).then(setInfo, () => {});
  useEffect(() => {
    const load = () =>
      volumeUsage([namespace]).then(
        (u) => (setSource(u.source), setStats(u.volumes.find((v) => v.claim === name) ?? null)),
        () => setStats(null),
      );
    void load();
    void loadInfo();
    prometheusTarget().then((t) => setHasProm(!!t), () => {});
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namespace, name]);

  useEffect(() => {
    if (!hasProm) return;
    setHistory(null);
    volumeHistory(namespace, name, range).then((h) => setHistory(h.used), () => setHistory([]));
  }, [hasProm, namespace, name, range]);

  async function expand() {
    setConfirming(false);
    setStatus(null);
    try {
      await expandVolume(namespace, name, size.trim());
      setStatus({ ok: true, text: `Requested ${size.trim()}. The driver grows the volume; some only finish after the pod restarts.` });
      setSize("");
      void loadInfo();
    } catch (e) {
      setStatus({ ok: false, text: errorText(e) });
    }
  }

  const pct = (used: number, total: number) => (total > 0 ? Math.min(100, (used / total) * 100) : 0);
  const tone = (p: number) => (p >= 95 ? "bad" : p >= 85 ? "warn" : "");

  return (
    <div className="node-overview">
      {stats === undefined ? (
        <div className="empty">Loading…</div>
      ) : stats === null ? (
        <div className="empty">
          No usage reported for this volume. Only volume types that measure themselves (CSI drivers such as EBS, local volumes) report it, through Prometheus or the kubelet.
        </div>
      ) : (
        <div className="capacity">
          <Bar label="Space" used={stats.usedBytes} total={stats.capacityBytes} detail={`${formatMemory(stats.usedBytes)} used · ${formatMemory(stats.availableBytes)} free · ${formatMemory(stats.capacityBytes)} capacity`} tone={tone(pct(stats.usedBytes, stats.capacityBytes))} />
          {stats.inodes !== null && stats.inodesUsed !== null && (
            <Bar label="Inodes" used={stats.inodesUsed} total={stats.inodes} detail={`${stats.inodesUsed.toLocaleString()} of ${stats.inodes.toLocaleString()} files`} tone={tone(pct(stats.inodesUsed, stats.inodes))} />
          )}
          <span className="faint volume-source">from {source}</span>
        </div>
      )}

      {hasProm && (
        <div className="charts">
          <section className="chart-block">
            <header className="volume-chart-head">
              <strong>Used</strong> <span className="faint">history from Prometheus</span>
              <span className="spacer" />
              <div className="segmented">
                {RANGES.map(([label, minutes]) => (
                  <button key={label} className={range === minutes ? "active" : ""} onClick={() => setRange(minutes)}>
                    {label}
                  </button>
                ))}
              </div>
            </header>
            {history === null ? (
              <div className="empty">Loading…</div>
            ) : history.length === 0 ? (
              <div className="empty">Prometheus has no history for this volume.</div>
            ) : (
              <LineChart series={history} refs={stats ? [{ label: "capacity", value: stats.capacityBytes, kind: "limit" }] : []} format={formatMemory} height={140} />
            )}
          </section>
        </div>
      )}

      <div className="node-section">
        <div className="related-title">Expand</div>
        {info && (
          <div className="volume-expand">
            <span className="faint">
              Requests {info.requested || "?"}
              {info.storageClass && ` · StorageClass ${info.storageClass}`}
            </span>
            {info.expandable ? (
              <>
                <input placeholder="new size, e.g. 20Gi" value={size} onChange={(e) => setSize(e.target.value)} disabled={readOnly} spellCheck={false} />
                <button disabled={readOnly || !size.trim()} title={readOnly ? "Read-only mode" : undefined} onClick={() => setConfirming(true)}>
                  <IconArrowsMaximize size={14} /> Expand
                </button>
              </>
            ) : (
              <span className="warn">{info.storageClass ? `${info.storageClass} does not allow expansion.` : "No StorageClass: cannot be expanded."}</span>
            )}
          </div>
        )}
        {status && <div className={status.ok ? "ok" : "bad"}>{status.text}</div>}
      </div>

      {confirming && (
        <ConfirmDialog
          title={`Expand ${name} to ${size.trim()}?`}
          message={`Volumes can only grow: this cannot be undone on ${context}.`}
          confirmLabel="Expand"
          typeToConfirm={production ? name : undefined}
          onConfirm={() => void expand()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

function Bar({ label, used, total, detail, tone }: { label: string; used: number; total: number; detail: string; tone: string }) {
  const p = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  return (
    <div className="capacity-row">
      <div className="capacity-head">
        <strong>
          {label} <span className={tone || "faint"}>{Math.round(p)}%</span>
        </strong>
        <span className="faint">{detail}</span>
      </div>
      <div className="capacity-bar volume-bar">
        <span className={`capacity-used ${tone}`} style={{ width: `${p}%` }} />
      </div>
    </div>
  );
}
