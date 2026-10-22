import { useState } from "react";
import { deleteResource, errorText, type KindInfo, type Row, type Target } from "../api";
import ConfirmDialog from "./ConfirmDialog";
import YamlEditor from "./YamlEditor";
import LogsView from "./LogsView";
import TerminalView from "./TerminalView";
import PortForwardButtons from "./PortForwardButtons";
import PodMetrics from "./PodMetrics";
import EventsView from "./EventsView";
import RolloutView from "./RolloutView";
import WorkloadActions from "./WorkloadActions";

interface Props {
  kind: KindInfo;
  row: Row;
  target: Target;
  context: string;
  production: boolean;
  onClose: () => void;
}

type Tab = "metrics" | "rollout" | "logs" | "terminal" | "events" | "yaml";

/** Kinds whose pods' logs can be merged into one stream. */
const WORKLOADS = ["deployments", "statefulsets", "daemonsets", "jobs"];

function tabsFor(kindKey: string): [Tab, string][] {
  if (kindKey === "pods")
    return [
      ["metrics", "Metrics"],
      ["logs", "Logs"],
      ["terminal", "Terminal"],
      ["events", "Events"],
      ["yaml", "YAML"],
    ];
  if (kindKey === "deployments")
    return [
      ["rollout", "Rollout"],
      ["logs", "Logs"],
      ["events", "Events"],
      ["yaml", "YAML"],
    ];
  if (WORKLOADS.includes(kindKey))
    return [
      ["logs", "Logs"],
      ["events", "Events"],
      ["yaml", "YAML"],
    ];
  return [
    ["events", "Events"],
    ["yaml", "YAML"],
  ];
}

export default function DetailsPanel({ kind, row, target, context, production, onClose }: Props) {
  const isPod = kind.key === "pods";
  const tabs = tabsFor(kind.key);
  const [tab, setTab] = useState<Tab>(tabs[0][0]);
  // null: every container on the metrics tab, the first one for logs and the terminal.
  const [container, setContainer] = useState<string | null>(null);
  const oneContainer = container ?? row.containers[0] ?? null;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setConfirmDelete(false);
    try {
      await deleteResource(target);
      onClose();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <section className="details">
      <header className="details-header">
        <div className="details-title">
          <span className="kind-chip">{kind.label.replace(/s$/, "")}</span>
          <strong title={row.name}>{row.name}</strong>
          {row.namespace && <span className="muted">in {row.namespace}</span>}
        </div>
        <div className="details-actions">
          {["deployments", "statefulsets", "daemonsets"].includes(kind.key) && row.namespace && (
            <WorkloadActions
              kindKey={kind.key}
              namespace={row.namespace}
              name={row.name}
              replicas={row.replicas ?? null}
              paused={row.paused ?? false}
              production={production}
              context={context}
              onError={setError}
            />
          )}
          <button className="danger" onClick={() => setConfirmDelete(true)}>
            Delete
          </button>
          <button onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
      </header>
      <nav className="tabs">
        {tabs.map(([key, label]) => (
          <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
        {isPod && ["metrics", "logs", "terminal"].includes(tab) && row.containers.length > 1 && (
          <select className="container-select" value={tab === "metrics" ? (container ?? "") : (container ?? row.containers[0])} onChange={(e) => setContainer(e.target.value || null)}>
            {tab === "metrics" && <option value="">All containers</option>}
            {row.containers.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        )}
      </nav>
      {(isPod || kind.key === "services") && row.namespace && (
        <PortForwardButtons kind={isPod ? "pod" : "service"} namespace={row.namespace} name={row.name} ports={row.ports} />
      )}
      {error && <div className="error-bar">{error}</div>}
      <div className="details-body">
        {tab === "yaml" && <YamlEditor target={target} production={production} />}
        {tab === "metrics" && row.namespace && <PodMetrics namespace={row.namespace} pod={row.name} container={container} />}
        {tab === "rollout" && row.namespace && <RolloutView namespace={row.namespace} name={row.name} production={production} context={context} />}
        {tab === "logs" && row.namespace && (
          <LogsView
            key={oneContainer}
            source={
              isPod
                ? { kind: "pod", namespace: row.namespace, pod: row.name, container: oneContainer, restarts: Number(row.cells[2] ?? 0) || 0 }
                : { kind: "workload", kindKey: kind.key, namespace: row.namespace, name: row.name }
            }
          />
        )}
        {tab === "events" && <EventsView namespace={row.namespace} uid={row.uid} />}
        {tab === "terminal" && row.namespace && <TerminalView key={oneContainer} namespace={row.namespace} pod={row.name} container={oneContainer} />}
      </div>
      {confirmDelete && (
        <ConfirmDialog
          title={`Delete ${row.name}?`}
          message={`This deletes the ${kind.label.replace(/s$/, "")} from ${context}.${isPod ? " If a controller owns it, a replacement pod is created." : ""}`}
          confirmLabel="Delete"
          typeToConfirm={production ? row.name : undefined}
          onConfirm={remove}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </section>
  );
}
