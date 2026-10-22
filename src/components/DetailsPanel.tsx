import { useState } from "react";
import { deleteResource, errorText, type KindInfo, type Row, type Target } from "../api";
import ConfirmDialog from "./ConfirmDialog";
import YamlEditor from "./YamlEditor";
import LogsView from "./LogsView";
import TerminalView from "./TerminalView";
import PortForwardButtons from "./PortForwardButtons";
import PodMetrics from "./PodMetrics";

interface Props {
  kind: KindInfo;
  row: Row;
  target: Target;
  context: string;
  production: boolean;
  onClose: () => void;
}

type Tab = "metrics" | "yaml" | "logs" | "terminal";

export default function DetailsPanel({ kind, row, target, context, production, onClose }: Props) {
  const isPod = kind.key === "pods";
  const [tab, setTab] = useState<Tab>(isPod ? "metrics" : "yaml");
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
          <button className="danger" onClick={() => setConfirmDelete(true)}>
            Delete
          </button>
          <button onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
      </header>
      <nav className="tabs">
        {isPod && (
          <button className={tab === "metrics" ? "active" : ""} onClick={() => setTab("metrics")}>
            Metrics
          </button>
        )}
        {isPod && (
          <button className={tab === "logs" ? "active" : ""} onClick={() => setTab("logs")}>
            Logs
          </button>
        )}
        {isPod && (
          <button className={tab === "terminal" ? "active" : ""} onClick={() => setTab("terminal")}>
            Terminal
          </button>
        )}
        <button className={tab === "yaml" ? "active" : ""} onClick={() => setTab("yaml")}>
          YAML
        </button>
        {isPod && tab !== "yaml" && row.containers.length > 1 && (
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
        {tab === "logs" && row.namespace && <LogsView key={oneContainer} namespace={row.namespace} pod={row.name} container={oneContainer} />}
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
