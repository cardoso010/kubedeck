import { useState } from "react";
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
      ? { title: `Restart ${name}?`, message: `Every pod is replaced, a few at a time, on ${context}.`, label: "Restart" }
      : p.action === "scale"
        ? { title: `Scale ${name} to ${p.replicas}?`, message: `From ${replicas} to ${p.replicas} replicas on ${context}.`, label: "Scale" }
        : { title: `${p.paused ? "Pause" : "Resume"} ${name}?`, message: p.paused ? "Changes to the pod template will not roll out until you resume." : "Pending template changes roll out now.", label: p.paused ? "Pause" : "Resume" };

  return (
    <>
      {SCALABLE.includes(kindKey) &&
        (scaling ? (
          <span className="scale-form">
            <input type="number" min={0} max={1000} value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Replicas" autoFocus />
            <button className="primary" disabled={busy || target === "" || Number(target) === replicas} onClick={() => setPending({ action: "scale", replicas: Number(target) })}>
              Scale
            </button>
            <button onClick={() => setScaling(false)}>Cancel</button>
          </span>
        ) : (
          <button disabled={busy} onClick={() => (setTarget(String(replicas ?? 1)), setScaling(true))} title="Change the number of replicas">
            <IconStack2 size={14} /> {replicas ?? "?"}
          </button>
        ))}
      {kindKey === "deployments" && (
        <button disabled={busy} onClick={() => setPending({ action: "pause", paused: !paused })} title={paused ? "Resume rollouts" : "Pause rollouts"}>
          {paused ? <IconPlayerPlay size={14} /> : <IconPlayerPause size={14} />} {paused ? "Resume" : "Pause"}
        </button>
      )}
      <button disabled={busy} onClick={() => setPending({ action: "restart" })} title="Replace every pod (rollout restart)">
        <IconRefresh size={14} /> Restart
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
