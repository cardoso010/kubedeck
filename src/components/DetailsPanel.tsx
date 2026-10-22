import { useState } from "react";
import { deleteResource, errorText, type KindInfo, type RelatedItem, type Row, type Target } from "../api";
import ConfirmDialog from "./ConfirmDialog";
import YamlEditor from "./YamlEditor";
import LogsView from "./LogsView";
import TerminalView from "./TerminalView";
import PortForwardButtons from "./PortForwardButtons";
import PodMetrics from "./PodMetrics";
import EventsView from "./EventsView";
import RolloutView from "./RolloutView";
import WorkloadActions from "./WorkloadActions";
import RelatedView from "./RelatedView";
import NodeOverview from "./NodeOverview";
import ExplainView from "./ExplainView";
import SecretData from "./SecretData";
import { IconLock } from "@tabler/icons-react";
import { useReadOnly } from "../readOnly";

interface Props {
  kind: KindInfo;
  row: Row;
  target: Target;
  context: string;
  production: boolean;
  kinds: KindInfo[];
  /** Opens another object (from the Related tab). */
  onNavigate: (item: RelatedItem) => void;
  onClose: () => void;
}

type Tab = "overview" | "data" | "metrics" | "rollout" | "logs" | "terminal" | "events" | "related" | "explain" | "yaml";

/** Kinds whose pods' logs can be merged into one stream. */
const WORKLOADS = ["deployments", "statefulsets", "daemonsets", "jobs"];

/** Tabs specific to a kind, shown before the ones every object has. */
const FIRST_TABS: Record<string, [Tab, string][]> = {
  pods: [
    ["metrics", "Metrics"],
    ["logs", "Logs"],
    ["terminal", "Terminal"],
  ],
  deployments: [
    ["rollout", "Rollout"],
    ["logs", "Logs"],
  ],
  nodes: [["overview", "Overview"]],
  secrets: [["data", "Data"]],
};

function tabsFor(kindKey: string): [Tab, string][] {
  const first = FIRST_TABS[kindKey] ?? (WORKLOADS.includes(kindKey) ? [["logs", "Logs"] as [Tab, string]] : []);
  // Secrets are never sent to Claude.
  const explain: [Tab, string][] = kindKey === "secrets" ? [] : [["explain", "Explain"]];
  return [...first, ["events", "Events"], ["related", "Related"], ...explain, ["yaml", "YAML"]];
}

export default function DetailsPanel({ kind, row, target, context, production, kinds, onNavigate, onClose }: Props) {
  const isPod = kind.key === "pods";
  const tabs = tabsFor(kind.key);
  const [tab, setTab] = useState<Tab>(tabs[0][0]);
  // null: every container on the metrics tab, the first one for logs and the terminal.
  const [container, setContainer] = useState<string | null>(null);
  const oneContainer = container ?? row.containers[0] ?? null;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readOnly = useReadOnly();

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
          {readOnly && (
            <span className="details-lock" title="Read-only mode: unlock the cluster in the top bar to make changes">
              <IconLock size={12} /> read-only
            </span>
          )}
          {!readOnly && ["deployments", "statefulsets", "daemonsets"].includes(kind.key) && row.namespace && (
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
          <button className="danger" disabled={readOnly} onClick={() => setConfirmDelete(true)}>
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
        {tab === "data" && row.namespace && <SecretData namespace={row.namespace} name={row.name} production={production} />}
        {tab === "overview" && <NodeOverview name={row.name} production={production} context={context} />}
        {tab === "related" && <RelatedView kindKey={kind.key} namespace={row.namespace} name={row.name} kinds={kinds} onOpen={onNavigate} />}
        {tab === "explain" && <ExplainView kindKey={kind.key} namespace={row.namespace} name={row.name} production={production} />}
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
