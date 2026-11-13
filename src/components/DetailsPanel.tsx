import { useState } from "react";
import { useTranslation } from "react-i18next";
import { deleteResource, errorText, type KindInfo, type RelatedItem, type Row, type Target } from "../api";
import ConfirmDialog from "./ConfirmDialog";
import YamlEditor from "./YamlEditor";
import LogsView, { type LogSource } from "./LogsView";
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
import VolumeView from "./VolumeView";
import { IconLayoutBottombar, IconLock } from "@tabler/icons-react";
import { useDock } from "../dock";
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

type Tab = "overview" | "volume" | "data" | "metrics" | "rollout" | "logs" | "terminal" | "events" | "related" | "explain" | "yaml";

/** Kinds whose pods' logs can be merged into one stream. */
const WORKLOADS = ["deployments", "statefulsets", "daemonsets", "jobs"];

/** Tabs specific to a kind, shown before the ones every object has. */
const FIRST_TABS: Record<string, Tab[]> = {
  pods: ["metrics", "logs", "terminal"],
  deployments: ["rollout", "logs"],
  nodes: ["overview"],
  secrets: ["data"],
  persistentvolumeclaims: ["volume"],
};

function tabsFor(kindKey: string): Tab[] {
  const first = FIRST_TABS[kindKey] ?? (WORKLOADS.includes(kindKey) ? ["logs" as Tab] : []);
  // Secrets are never sent to Claude.
  const explain: Tab[] = kindKey === "secrets" ? [] : ["explain"];
  return [...first, "events", "related", ...explain, "yaml"];
}

export default function DetailsPanel({ kind, row, target, context, production, kinds, onNavigate, onClose }: Props) {
  const { t } = useTranslation();
  const isPod = kind.key === "pods";
  const tabs = tabsFor(kind.key);
  const [tab, setTab] = useState<Tab>(tabs[0]);
  // null: every container on the metrics tab, the first one for logs and the terminal.
  const [container, setContainer] = useState<string | null>(null);
  const oneContainer = container ?? row.containers[0] ?? null;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readOnly = useReadOnly();
  const dock = useDock();
  const logSource = (): LogSource =>
    isPod
      ? { kind: "pod", namespace: row.namespace!, pod: row.name, container: oneContainer, restarts: Number(row.cells[2] ?? 0) || 0 }
      : { kind: "workload", kindKey: kind.key, namespace: row.namespace!, name: row.name };
  function toDock() {
    if (!dock || !row.namespace) return;
    const where = `${row.name}${isPod && oneContainer && row.containers.length > 1 ? `/${oneContainer}` : ""}`;
    if (tab === "terminal") dock({ id: `term:${row.namespace}/${where}:${Date.now()}`, kind: "terminal", title: t("resources.details.shell", { name: where }), namespace: row.namespace, pod: row.name, container: oneContainer });
    else dock({ id: `logs:${kind.key}/${row.namespace}/${where}`, kind: "logs", title: t("resources.details.logs", { name: where }), source: logSource() });
  }

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
          {row.namespace && <span className="muted">{t("resources.details.in", { namespace: row.namespace })}</span>}
        </div>
        <div className="details-actions">
          {readOnly && (
            <span className="details-lock" title={t("resources.details.readOnlyHint")}>
              <IconLock size={12} /> {t("resources.details.readOnly")}
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
            {t("common.delete")}
          </button>
          <button onClick={onClose} aria-label={t("common.close")}>
            ✕
          </button>
        </div>
      </header>
      <nav className="tabs">
        {tabs.map((key) => (
          <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>
            {t(`resources.details.tabs.${key}`)}
          </button>
        ))}
        {isPod && ["metrics", "logs", "terminal"].includes(tab) && row.containers.length > 1 && (
          <select className="container-select" value={tab === "metrics" ? (container ?? "") : (container ?? row.containers[0])} onChange={(e) => setContainer(e.target.value || null)}>
            {tab === "metrics" && <option value="">{t("resources.details.allContainers")}</option>}
            {row.containers.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        )}
        {dock && (tab === "logs" || (tab === "terminal" && !readOnly)) && (
          <button className="link details-dock" onClick={toDock} title={t("resources.details.openInDockHint")}>
            <IconLayoutBottombar size={13} /> {t("resources.details.openInDock")}
          </button>
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
            source={logSource()}
          />
        )}
        {tab === "events" && <EventsView namespace={row.namespace} uid={row.uid} />}
        {tab === "volume" && row.namespace && <VolumeView namespace={row.namespace} name={row.name} production={production} context={context} />}
        {tab === "data" && row.namespace && <SecretData namespace={row.namespace} name={row.name} production={production} />}
        {tab === "overview" && <NodeOverview name={row.name} production={production} context={context} />}
        {tab === "related" && <RelatedView kindKey={kind.key} namespace={row.namespace} name={row.name} kinds={kinds} onOpen={onNavigate} />}
        {tab === "explain" && <ExplainView kindKey={kind.key} namespace={row.namespace} name={row.name} production={production} />}
        {tab === "terminal" && row.namespace && <TerminalView key={oneContainer} namespace={row.namespace} pod={row.name} container={oneContainer} />}
      </div>
      {confirmDelete && (
        <ConfirmDialog
          title={t("resources.details.deleteTitle", { name: row.name })}
          message={t("resources.details.deleteMessage", { kind: kind.label.replace(/s$/, ""), cluster: context }) + (isPod ? t("resources.details.deletePodNote") : "")}
          confirmLabel={t("common.delete")}
          typeToConfirm={production ? row.name : undefined}
          onConfirm={remove}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </section>
  );
}
