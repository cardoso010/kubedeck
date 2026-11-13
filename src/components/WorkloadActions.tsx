import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconPlayerPause, IconPlayerPlay, IconRefresh, IconStack2 } from "@tabler/icons-react";
import { errorText, rolloutRestart, scale, setPaused } from "../api";
import ConfirmDialog from "./ConfirmDialog";

interface Props {
  kindKey: string;
  namespace: string;
  name: string;
  /** Current desired replicas (deployments, statefulsets). */
  replicas: number | null;
  paused: boolean;
  production: boolean;
  context: string;
  onError: (message: string) => void;
}

const SCALABLE = ["deployments", "statefulsets"];
type Pending = { action: "restart" } | { action: "scale"; replicas: number } | { action: "pause"; paused: boolean };

/** Restart, scale and pause/resume buttons for the drawer header. */
export default function WorkloadActions({ kindKey, namespace, name, replicas, paused, production, context, onError }: Props) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<Pending | null>(null);
  const [scaling, setScaling] = useState(false);
  const [target, setTarget] = useState(String(replicas ?? 1));
  const [busy, setBusy] = useState(false);

  async function run(p: Pending) {
    setPending(null);
    setBusy(true);
    try {
      if (p.action === "restart") await rolloutRestart(kindKey, namespace, name);
      else if (p.action === "scale") await scale(kindKey, namespace, name, p.replicas);
      else await setPaused(namespace, name, p.paused);
      setScaling(false);
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const describe = (p: Pending) =>
    p.action === "restart"
      ? { title: t("workloads.actions.restartTitle", { name }), message: t("workloads.actions.restartMessage", { cluster: context }), label: t("workloads.actions.restart") }
      : p.action === "scale"
        ? { title: t("workloads.actions.scaleTitle", { name, replicas: p.replicas }), message: t("workloads.actions.scaleMessage", { from: replicas, to: p.replicas, cluster: context }), label: t("workloads.actions.scale") }
        : p.paused
          ? { title: t("workloads.actions.pauseTitle", { name }), message: t("workloads.actions.pauseMessage"), label: t("workloads.actions.pause") }
          : { title: t("workloads.actions.resumeTitle", { name }), message: t("workloads.actions.resumeMessage"), label: t("workloads.actions.resume") };

  return (
    <>
      {SCALABLE.includes(kindKey) &&
        (scaling ? (
          <span className="scale-form">
            <input type="number" min={0} max={1000} value={target} onChange={(e) => setTarget(e.target.value)} aria-label={t("workloads.actions.replicas")} autoFocus />
            <button className="primary" disabled={busy || target === "" || Number(target) === replicas} onClick={() => setPending({ action: "scale", replicas: Number(target) })}>
              {t("workloads.actions.scale")}
            </button>
            <button onClick={() => setScaling(false)}>{t("common.cancel")}</button>
          </span>
        ) : (
          <button disabled={busy} onClick={() => (setTarget(String(replicas ?? 1)), setScaling(true))} title={t("workloads.actions.scaleHint")}>
            <IconStack2 size={14} /> {replicas ?? "?"}
          </button>
        ))}
      {kindKey === "deployments" && (
        <button disabled={busy} onClick={() => setPending({ action: "pause", paused: !paused })} title={paused ? t("workloads.actions.resumeHint") : t("workloads.actions.pauseHint")}>
          {paused ? <IconPlayerPlay size={14} /> : <IconPlayerPause size={14} />} {paused ? t("workloads.actions.resume") : t("workloads.actions.pause")}
        </button>
      )}
      <button disabled={busy} onClick={() => setPending({ action: "restart" })} title={t("workloads.actions.restartHint")}>
        <IconRefresh size={14} /> {t("workloads.actions.restart")}
      </button>
      {pending && (
        <ConfirmDialog
          {...(() => {
            const d = describe(pending);
            return { title: d.title, message: d.message, confirmLabel: d.label };
          })()}
          typeToConfirm={production ? name : undefined}
          onConfirm={() => void run(pending)}
          onCancel={() => setPending(null)}
        />
      )}
    </>
  );
}
