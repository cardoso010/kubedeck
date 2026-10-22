import { useEffect, useMemo, useState } from "react";
import * as api from "./api";
import type { Connected, Contexts, KindInfo, Row, Target } from "./api";
import { useStream } from "./useStream";
import ResourceTable from "./components/ResourceTable";
import DetailsPanel from "./components/DetailsPanel";
import HelmView from "./components/HelmView";
import PortForwardsView from "./components/PortForwardsView";
import KindNav from "./components/KindNav";
import NamespacePicker from "./components/NamespacePicker";
import UpdateNotice from "./components/UpdateNotice";
import Hotbar from "./components/Hotbar";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { METRIC_COLUMNS, useMetrics } from "./useMetrics";


/** The namespace selection is remembered per cluster context (per viewer, best effort). */
const savedNamespaces = (context: string): string[] | null => {
  try {
    const raw = localStorage.getItem(`kubedeck.namespaces.${context}`);
    return raw ? (JSON.parse(raw) as string[]) : null;
  } catch {
    return null;
  }
};
const saveNamespaces = (context: string, selected: string[]) => {
  try {
    localStorage.setItem(`kubedeck.namespaces.${context}`, JSON.stringify(selected));
  } catch {
    // Storage unavailable: the selection just is not remembered.
  }
};
/** Views in the sidebar that are not Kubernetes kinds. */
const HELM = "helm";
const FORWARDS = "port-forwards";

export default function App() {
  const [contexts, setContexts] = useState<Contexts | null>(null);
  const [kinds, setKinds] = useState<KindInfo[]>([]);
  const [conn, setConn] = useState<Connected | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [namespaces, setNamespaces] = useState<string[]>([]);
  /** Selected namespaces; empty means all of them. */
  const [selectedNs, setSelectedNs] = useState<string[]>([]);
  const [kindKey, setKindKey] = useState("pods");
  const [rows, setRows] = useState<Map<string, Row> | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Row | null>(null);

  useEffect(() => {
    api.listKinds().then(setKinds);
    api.listContexts().then(
      (c) => {
        setContexts(c);
        // Windows opened from the hotbar start connected to their cluster.
        const initial = (window as { __KUBEDECK_INITIAL_CONTEXT__?: string | null }).__KUBEDECK_INITIAL_CONTEXT__;
        if (initial && c.contexts.some((x) => x.name === initial)) void choose(initial);
      },
      (e) => setError(`Could not read kubeconfig: ${api.errorText(e)}`),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function choose(context: string) {
    setConnecting(true);
    setError(null);
    setConn(null);
    setSelected(null);
    try {
      const c = await api.connect(context);
      // The new cluster may have different custom resources.
      const k = await api.listKinds();
      setKinds(k);
      setKindKey((key) => (key === HELM || key === FORWARDS || k.some((x) => x.key === key) ? key : "pods"));
      setConn(c);
      // Cosmetic: never let the title fail a connection.
      try {
        getCurrentWindow()
          .setTitle(`${api.shortContextName(context)} — kubedeck`)
          .catch(() => {});
      } catch {
        // Not running inside a Tauri window.
      }
      const ns = await api.listNamespaces();
      setNamespaces(ns);
      const saved = savedNamespaces(context)?.filter((n) => ns.includes(n));
      setSelectedNs(saved ?? (ns.includes(c.defaultNamespace) ? [c.defaultNamespace] : []));
    } catch (e) {
      setError(`Could not connect to ${context}: ${api.errorText(e)}`);
    } finally {
      setConnecting(false);
    }
  }

  const kind = kinds.find((k) => k.key === kindKey);
  // Cluster-scoped kinds ignore the namespace selection.
  const scopedNs = useMemo(() => (kind?.namespaced ? selectedNs : []), [kind?.namespaced, selectedNs]);
  const nsKey = scopedNs.join(",");
  const metricCells = useMetrics(kindKey, scopedNs, conn);

  function chooseNamespaces(selected: string[]) {
    setSelectedNs(selected);
    if (conn) saveNamespaces(conn.context, selected);
  }

  useStream(
    conn && kind
      ? () => {
          setRows(null);
          setWatchError(null);
          setSelected(null);
          // Busy clusters send many events per second: apply them once per frame.
          let queue: api.WatchMsg[] = [];
          const flush = () => {
            const batch = queue;
            queue = [];
            setRows((prev) => {
              let next = new Map(prev ?? []);
              for (const msg of batch) {
                if (msg.type === "snapshot") next = new Map(msg.rows.map((r) => [r.uid, r]));
                else if (msg.type === "upsert") next.set(msg.row.uid, msg.row);
                else if (msg.type === "delete") next.delete(msg.uid);
              }
              return next;
            });
          };
          return api.watchResources(kind.key, scopedNs, (msg) => {
            if (msg.type === "error") return setWatchError(msg.message);
            setWatchError(null);
            if (queue.push(msg) === 1) requestAnimationFrame(flush);
          });
        }
      : null,
    (e) => setWatchError(api.errorText(e)),
    [conn, kind?.key, nsKey],
  );

  // Keep the details panel pointing at the live version of the selected row.
  const selectedRow = selected && rows ? (rows.get(selected.uid) ?? null) : null;
  const target: Target | null = selectedRow && kind ? { kindKey: kind.key, namespace: selectedRow.namespace, name: selectedRow.name } : null;
  const rowList = useMemo(() => (rows ? [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)) : []), [rows]);
  const prod = conn ? api.isProduction(conn.context) : false;

  return (
    <div className={`app ${prod ? "prod" : ""}`}>
      <Hotbar current={conn?.context ?? null} available={contexts?.contexts.map((c) => c.name) ?? []} onSwitch={(c) => c !== conn?.context && void choose(c)} />
      <aside className="sidebar">
        <div className="brand">kubedeck</div>
        <label className="field">
          <span>Cluster</span>
          <select value={conn?.context ?? ""} disabled={connecting} onChange={(e) => choose(e.target.value)}>
            <option value="" disabled>
              {contexts ? "Select a context…" : "Loading…"}
            </option>
            {contexts?.contexts.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
                {c.name === contexts.current ? "  (current)" : ""}
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          <span>Namespace</span>
          <NamespacePicker
            namespaces={namespaces}
            selected={selectedNs}
            disabled={!conn || kindKey === FORWARDS || (kind !== undefined && !kind.namespaced)}
            onChange={chooseNamespaces}
          />
        </div>
        <KindNav
          kinds={kinds}
          active={kindKey}
          disabled={!conn}
          onSelect={setKindKey}
          extras={[
            { key: HELM, label: "Helm Releases" },
            { key: FORWARDS, label: "Port Forwards" },
          ]}
        />
        {conn && (
          <div className="conn-info">
            {conn.serverVersion}
            {prod && <div className="prod-badge">PRODUCTION</div>}
          </div>
        )}
        <UpdateNotice />
      </aside>

      <main className="main">
        {prod && <div className="prod-banner">Connected to a production cluster ({conn?.context}). Changes affect real workloads.</div>}
        {error && <div className="error-bar">{error}</div>}
        {!conn ? (
          <div className="empty">{connecting ? "Connecting…" : "Choose a cluster context to start."}</div>
        ) : kindKey === HELM ? (
          <div className="workspace">
            <HelmView
              key={conn.context}
              namespaces={selectedNs}
              allNamespaces={namespaces}
              defaultNamespace={conn.defaultNamespace}
              production={prod}
              context={conn.context}
            />
          </div>
        ) : kindKey === FORWARDS ? (
          <div className="workspace">
            <PortForwardsView key={conn.context} />
          </div>
        ) : kind ? (
          <div className="workspace">
            <ResourceTable
              kind={kind}
              rows={rowList}
              loading={rows === null}
              error={watchError}
              showNamespace={kind.namespaced && scopedNs.length !== 1}
              selectedUid={selectedRow?.uid ?? null}
              onSelect={setSelected}
              extra={metricCells && { columns: METRIC_COLUMNS, cells: metricCells }}
            />
            {selectedRow && target && (
              <DetailsPanel
                key={selectedRow.uid}
                kind={kind}
                row={selectedRow}
                target={target}
                context={conn.context}
                production={prod}
                onClose={() => setSelected(null)}
              />
            )}
          </div>
        ) : null}
      </main>
    </div>
  );
}
