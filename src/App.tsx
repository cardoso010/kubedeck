import { useEffect, useMemo, useState } from "react";
import * as api from "./api";
import type { Connected, Contexts, KindInfo, Row, Target } from "./api";
import { useStream } from "./useStream";
import ResourceTable from "./components/ResourceTable";
import DetailsPanel from "./components/DetailsPanel";
import HelmView from "./components/HelmView";
import PortForwardsView from "./components/PortForwardsView";

const ALL = "__all__";
/** Views in the sidebar that are not Kubernetes kinds. */
const HELM = "helm";
const FORWARDS = "port-forwards";

export default function App() {
  const [contexts, setContexts] = useState<Contexts | null>(null);
  const [kinds, setKinds] = useState<KindInfo[]>([]);
  const [conn, setConn] = useState<Connected | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [namespace, setNamespace] = useState<string>(ALL);
  const [kindKey, setKindKey] = useState("pods");
  const [rows, setRows] = useState<Map<string, Row> | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Row | null>(null);

  useEffect(() => {
    api.listKinds().then(setKinds);
    api.listContexts().then(setContexts, (e) => setError(`Could not read kubeconfig: ${api.errorText(e)}`));
  }, []);

  async function choose(context: string) {
    setConnecting(true);
    setError(null);
    setConn(null);
    setSelected(null);
    try {
      const c = await api.connect(context);
      setConn(c);
      const ns = await api.listNamespaces();
      setNamespaces(ns);
      setNamespace(ns.includes(c.defaultNamespace) ? c.defaultNamespace : ALL);
    } catch (e) {
      setError(`Could not connect to ${context}: ${api.errorText(e)}`);
    } finally {
      setConnecting(false);
    }
  }

  const kind = kinds.find((k) => k.key === kindKey);
  const ns = kind?.namespaced && namespace !== ALL ? namespace : null;
  const selectedNamespace = namespace !== ALL ? namespace : null;

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
          return api.watchResources(kind.key, ns, (msg) => {
            if (msg.type === "error") return setWatchError(msg.message);
            setWatchError(null);
            if (queue.push(msg) === 1) requestAnimationFrame(flush);
          });
        }
      : null,
    (e) => setWatchError(api.errorText(e)),
    [conn, kind?.key, ns],
  );

  // Keep the details panel pointing at the live version of the selected row.
  const selectedRow = selected && rows ? (rows.get(selected.uid) ?? null) : null;
  const target: Target | null = selectedRow && kind ? { kindKey: kind.key, namespace: selectedRow.namespace, name: selectedRow.name } : null;
  const rowList = useMemo(() => (rows ? [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)) : []), [rows]);
  const prod = conn ? api.isProduction(conn.context) : false;

  return (
    <div className={`app ${prod ? "prod" : ""}`}>
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
        <label className="field">
          <span>Namespace</span>
          <select value={namespace} disabled={!conn || kindKey === FORWARDS || (kind !== undefined && !kind.namespaced)} onChange={(e) => setNamespace(e.target.value)}>
            <option value={ALL}>All namespaces</option>
            {namespaces.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <nav className="kinds">
          {kinds.map((k) => (
            <button key={k.key} className={k.key === kindKey ? "active" : ""} disabled={!conn} onClick={() => setKindKey(k.key)}>
              {k.label}
            </button>
          ))}
          <div className="nav-separator" />
          <button className={kindKey === HELM ? "active" : ""} disabled={!conn} onClick={() => setKindKey(HELM)}>
            Helm Releases
          </button>
          <button className={kindKey === FORWARDS ? "active" : ""} disabled={!conn} onClick={() => setKindKey(FORWARDS)}>
            Port Forwards
          </button>
        </nav>
        {conn && (
          <div className="conn-info">
            {conn.serverVersion}
            {prod && <div className="prod-badge">PRODUCTION</div>}
          </div>
        )}
      </aside>

      <main className="main">
        {prod && <div className="prod-banner">Connected to a production cluster ({conn?.context}). Changes affect real workloads.</div>}
        {error && <div className="error-bar">{error}</div>}
        {!conn ? (
          <div className="empty">{connecting ? "Connecting…" : "Choose a cluster context to start."}</div>
        ) : kindKey === HELM ? (
          <div className="workspace">
            <HelmView key={conn.context} namespace={selectedNamespace} production={prod} context={conn.context} />
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
              showNamespace={kind.namespaced && ns === null}
              selectedUid={selectedRow?.uid ?? null}
              onSelect={setSelected}
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
