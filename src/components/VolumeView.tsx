import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconArrowsMaximize, IconBolt } from "@tabler/icons-react";
import { errorText, expandVolume, formatMemory, prometheusTarget, setVolumeAttributesClass, volumeExpandInfo, volumeHistory, volumeUsage, type ExpandInfo, type Series, type VolumeStats } from "../api";
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
  const { t } = useTranslation();
  const readOnly = useReadOnly();
  const [stats, setStats] = useState<VolumeStats | null | undefined>(undefined);
  const [source, setSource] = useState("");
  const [history, setHistory] = useState<Series[] | null>(null);
  const [range, setRange] = useState(RANGES[1][1]);
  const [hasProm, setHasProm] = useState(false);
  const [info, setInfo] = useState<ExpandInfo | null>(null);
  const [size, setSize] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [vac, setVac] = useState("");
  const [confirmingVac, setConfirmingVac] = useState(false);
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
      setStatus({ ok: true, text: t("storage.expandRequested", { size: size.trim() }) });
      setSize("");
      void loadInfo();
    } catch (e) {
      setStatus({ ok: false, text: errorText(e) });
    }
  }

  async function changeClass() {
    setConfirmingVac(false);
    setStatus(null);
    try {
      await setVolumeAttributesClass(namespace, name, vac);
      setStatus({ ok: true, text: t("storage.classRequested", { className: vac }) });
      setVac("");
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
        <div className="empty">{t("common.loading")}</div>
      ) : stats === null ? (
        <div className="empty">
          {t("storage.noUsage")}
        </div>
      ) : (
        <div className="capacity">
          <Bar label={t("storage.space")} used={stats.usedBytes} total={stats.capacityBytes} detail={t("storage.spaceDetail", { used: formatMemory(stats.usedBytes), free: formatMemory(stats.availableBytes), capacity: formatMemory(stats.capacityBytes) })} tone={tone(pct(stats.usedBytes, stats.capacityBytes))} />
          {stats.inodes !== null && stats.inodesUsed !== null && (
            <Bar label={t("storage.inodes")} used={stats.inodesUsed} total={stats.inodes} detail={t("storage.inodesDetail", { used: stats.inodesUsed.toLocaleString(), total: stats.inodes.toLocaleString() })} tone={tone(pct(stats.inodesUsed, stats.inodes))} />
          )}
          <span className="faint volume-source">{t("storage.from", { source })}</span>
        </div>
      )}

      {hasProm && (
        <div className="charts">
          <section className="chart-block">
            <header className="volume-chart-head">
              <strong>{t("storage.used")}</strong> <span className="faint">{t("storage.history")}</span>
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
              <div className="empty">{t("common.loading")}</div>
            ) : history.length === 0 ? (
              <div className="empty">{t("storage.noHistory")}</div>
            ) : (
              <LineChart series={history} refs={stats ? [{ label: t("storage.capacity"), value: stats.capacityBytes, kind: "limit" }] : []} format={formatMemory} height={140} />
            )}
          </section>
        </div>
      )}

      <div className="node-section">
        <div className="related-title">{t("storage.expandTitle")}</div>
        {info && (
          <div className="volume-expand">
            <span className="faint">
              {t("storage.requests", { size: info.requested || "?" })}
              {info.storageClass && ` · StorageClass ${info.storageClass}`}
            </span>
            {info.expandable ? (
              <>
                <input placeholder={t("storage.newSize")} value={size} onChange={(e) => setSize(e.target.value)} disabled={readOnly} spellCheck={false} />
                <button disabled={readOnly || !size.trim()} title={readOnly ? t("storage.readOnly") : undefined} onClick={() => setConfirming(true)}>
                  <IconArrowsMaximize size={14} /> {t("storage.expand")}
                </button>
              </>
            ) : (
              <span className="warn">{info.storageClass ? t("storage.notExpandable", { storageClass: info.storageClass }) : t("storage.noStorageClass")}</span>
            )}
          </div>
        )}
        {info && (info.attributesClasses.length > 0 || info.attributesClass) && (
          <>
            <div className="related-title">{t("storage.classTitle")}</div>
            <div className="volume-expand">
              <span className="faint">
                {info.currentAttributesClass ?? t("storage.noClass")}
                {info.attributesClass && info.attributesClass !== info.currentAttributesClass && ` → ${info.attributesClass}`}
                {info.modifyStatus && <span className={info.modifyStatus.startsWith("Infeasible") ? "bad" : "warn"}> · {info.modifyStatus}</span>}
              </span>
              <select value={vac} onChange={(e) => setVac(e.target.value)} disabled={readOnly}>
                <option value="">{t("storage.changeTo")}</option>
                {info.attributesClasses
                  .filter((c) => c !== info.attributesClass)
                  .map((c) => (
                    <option key={c}>{c}</option>
                  ))}
              </select>
              <button disabled={readOnly || !vac} title={readOnly ? t("storage.readOnly") : undefined} onClick={() => setConfirmingVac(true)}>
                <IconBolt size={14} /> {t("storage.change")}
              </button>
            </div>
          </>
        )}
        {status && <div className={status.ok ? "ok" : "bad"}>{status.text}</div>}
      </div>

      {confirmingVac && (
        <ConfirmDialog
          title={t("storage.confirmClass.title", { name, className: vac })}
          message={t("storage.confirmClass.message", { cluster: context })}
          confirmLabel={t("storage.confirmClass.confirm")}
          typeToConfirm={production ? name : undefined}
          onConfirm={() => void changeClass()}
          onCancel={() => setConfirmingVac(false)}
        />
      )}
      {confirming && (
        <ConfirmDialog
          title={t("storage.confirmExpand.title", { name, size: size.trim() })}
          message={t("storage.confirmExpand.message", { cluster: context })}
          confirmLabel={t("storage.expand")}
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
