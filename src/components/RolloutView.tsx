import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DiffEditor } from "@monaco-editor/react";
import { age, errorText, rollback, rolloutStatus, type RevisionInfo, type RolloutStatus } from "../api";
import { useCurrentTheme } from "../theme";
import ConfirmDialog from "./ConfirmDialog";

const REFRESH_MS = 5_000;

interface Props {
  namespace: string;
  name: string;
  production: boolean;
  context: string;
}

/** Replica counts, the revision history, a diff of any revision against the current one, and rollback. */
export default function RolloutView({ namespace, name, production, context }: Props) {
  const { t } = useTranslation();
  const monacoTheme = useCurrentTheme().monaco;
  const [status, setStatus] = useState<RolloutStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compare, setCompare] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<RevisionInfo | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = () =>
    rolloutStatus(namespace, name).then(
      (s) => (setStatus(s), setError(null), setNow(Date.now())),
      (e) => setError(errorText(e)),
    );
  useEffect(() => {
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namespace, name]);

  async function doRollback(r: RevisionInfo) {
    setConfirm(null);
    try {
      await rollback(namespace, name, r.revision);
      setNotice(t("workloads.rollout.rollingBack", { revision: r.revision }));
      setCompare(null);
      void load();
    } catch (e) {
      setError(errorText(e));
    }
  }

  if (!status) return error ? <div className="error-bar">{error}</div> : <div className="empty">{t("common.loading")}</div>;
  const current = status.revisions.find((r) => r.current);
  const other = status.revisions.find((r) => r.revision === compare);
  const progressing = status.updated < status.replicas || status.ready < status.replicas;

  return (
    <div className="rollout">
      {error && <div className="error-bar">{error}</div>}
      <div className="rollout-stats">
        <Stat label={t("workloads.rollout.desired")} value={status.replicas} />
        <Stat label={t("workloads.rollout.ready")} value={status.ready} tone={status.ready < status.replicas ? "warn" : "ok"} />
        <Stat label={t("workloads.rollout.upToDate")} value={status.updated} tone={status.updated < status.replicas ? "warn" : "ok"} />
        <Stat label={t("workloads.rollout.available")} value={status.available} />
        <div className="rollout-state">
          {status.paused ? <span className="warn">{t("workloads.rollout.paused")}</span> : progressing ? <span className="warn">{t("workloads.rollout.rollingOut")}</span> : <span className="ok">{t("workloads.rollout.stable")}</span>}
          {notice && <span className="faint"> · {notice}</span>}
        </div>
      </div>

      <div className="revisions">
        {status.revisions.map((r) => (
          <div key={r.revision} className={`revision ${r.current ? "current" : ""} ${compare === r.revision ? "selected" : ""}`}>
            <span className="revision-number">#{r.revision}</span>
            <span className="revision-images" title={r.images.join("\n")}>
              {r.images.join(", ")}
            </span>
            <span className="faint">{r.changeCause ?? ""}</span>
            <span className="faint">{age(r.created, now)}</span>
            <span className="faint">{t("workloads.rollout.pods", { count: r.replicas })}</span>
            {r.current ? (
              <span className="revision-badge">{t("workloads.rollout.current")}</span>
            ) : (
              <span className="revision-actions">
                <button onClick={() => setCompare(compare === r.revision ? null : r.revision)}>{compare === r.revision ? t("workloads.rollout.hideDiff") : t("workloads.rollout.diff")}</button>
                <button onClick={() => setConfirm(r)}>{t("workloads.rollout.rollBack")}</button>
              </span>
            )}
          </div>
        ))}
      </div>

      {other && current && (
        <div className="rollout-diff">
          <div className="yaml-toolbar">
            <strong>{t("workloads.rollout.compare", { from: other.revision, to: current.revision })}</strong>
            <span className="faint">{t("workloads.rollout.podTemplate")}</span>
          </div>
          <div className="yaml-editor">
            <DiffEditor
              original={other.templateYaml}
              modified={current.templateYaml}
              language="yaml"
              theme={monacoTheme}
              options={{ readOnly: true, renderSideBySide: false, minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false }}
            />
          </div>
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          title={t("workloads.rollout.rollBackTitle", { name, revision: confirm.revision })}
          message={t("workloads.rollout.rollBackMessage", { revision: confirm.revision, images: confirm.images.join(", "), cluster: context })}
          confirmLabel={t("workloads.rollout.rollBack")}
          typeToConfirm={production ? name : undefined}
          onConfirm={() => void doRollback(confirm)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "ok" | "warn" }) {
  return (
    <div className="meter">
      <span className="meter-label">{label}</span>
      <span className={`meter-value ${tone ?? ""}`}>{value}</span>
    </div>
  );
}
