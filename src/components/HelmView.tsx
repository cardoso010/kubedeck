import { useEffect, useMemo, useState } from "react";
import Editor from "@monaco-editor/react";
import { useCurrentTheme } from "../theme";
import { errorText, helmDetails, helmList, helmRollback, helmSearch, helmUninstall, splitChart, type HelmDetails, type HelmRelease, type KindInfo, type Row } from "../api";
import ResourceTable from "./ResourceTable";
import ConfirmDialog from "./ConfirmDialog";
import ChartForm from "./ChartForm";
import InstallChartDialog from "./InstallChartDialog";
import { useReadOnly } from "../readOnly";

const KIND: KindInfo = { key: "helm", label: "Helm Releases", namespaced: true, columns: ["Revision", "Status", "Chart", "App version"] };
const POLL_MS = 10_000;

const toRow = (r: HelmRelease): Row => ({
  uid: `${r.namespace}/${r.name}`,
  name: r.name,
  namespace: r.namespace,
  created: r.updated,
  cells: [r.revision, r.status, r.chart, r.appVersion],
  containers: [],
  ports: [],
});

/** Helm has no watch API, so releases are polled. */
interface Props {
  /** Selected namespaces; empty means all. */
  namespaces: string[];
  /** Every namespace of the cluster, offered as install targets. */
  allNamespaces: string[];
  defaultNamespace: string;
  production: boolean;
  context: string;
  /** Bumped by the command palette to open the install dialog. */
  installRequest?: number;
}

export default function HelmView({ namespaces, allNamespaces, defaultNamespace, production, context, installRequest = 0 }: Props) {
  const [releases, setReleases] = useState<HelmRelease[] | null>(null);
  const [installing, setInstalling] = useState(false);
  useEffect(() => {
    if (installRequest > 0) setInstalling(true);
  }, [installRequest]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const refresh = () =>
    helmList(namespaces).then(
      (r) => (setReleases(r), setError(null)),
      (e) => setError(errorText(e)),
    );

  useEffect(() => {
    setReleases(null);
    setSelected(null);
    void refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namespaces.join(",")]);

  const rows = useMemo(() => (releases ?? []).map(toRow).sort((a, b) => a.name.localeCompare(b.name)), [releases]);
  const release = releases?.find((r) => `${r.namespace}/${r.name}` === selected) ?? null;

  return (
    <>
      <ResourceTable
        kind={KIND}
        rows={rows}
        loading={releases === null && !error}
        error={error}
        errorPrefix="Helm"
        ageLabel="Updated"
        showNamespace={namespaces.length !== 1}
        selectedUid={selected}
        onSelect={(r) => setSelected(r.uid)}
        actions={
          <button className="primary" onClick={() => setInstalling(true)}>
            Install chart
          </button>
        }
      />
      {installing && (
        <InstallChartDialog
          namespaces={allNamespaces}
          defaultNamespace={namespaces.length === 1 ? namespaces[0] : defaultNamespace}
          production={production}
          context={context}
          onInstalled={refresh}
          onClose={() => setInstalling(false)}
        />
      )}
      {release && (
        <HelmPanel
          key={`${release.namespace}/${release.name}`}
          release={release}
          production={production}
          context={context}
          onChanged={refresh}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}

type Tab = "values" | "manifest" | "notes" | "history" | "upgrade";
type Pending = { action: "rollback"; revision: number } | { action: "uninstall" };

function HelmPanel({
  release,
  production,
  context,
  onChanged,
  onClose,
}: {
  release: HelmRelease;
  production: boolean;
  context: string;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("values");
  const [details, setDetails] = useState<HelmDetails | null>(null);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const readOnly = useReadOnly();
  const [pending, setPending] = useState<Pending | null>(null);

  const load = () => helmDetails(release.namespace, release.name).then(setDetails, (e) => setStatus({ kind: "error", text: errorText(e) }));
  // Reload whenever the release gets a new revision (rollback here, or an upgrade elsewhere).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void load(), [release.revision]);

  async function run(p: Pending) {
    setPending(null);
    setBusy(true);
    setStatus(null);
    try {
      if (p.action === "rollback") {
        await helmRollback(release.namespace, release.name, p.revision);
        setStatus({ kind: "ok", text: `Rolled back to revision ${p.revision}.` });
        await load();
        onChanged();
      } else {
        await helmUninstall(release.namespace, release.name);
        onChanged();
        onClose();
      }
    } catch (e) {
      setStatus({ kind: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  const tabs: [Tab, string][] = [
    ["values", "Values"],
    ["manifest", "Manifest"],
    ["notes", "Notes"],
    ["history", "History"],
    ["upgrade", "Upgrade"],
  ];

  return (
    <section className="details">
      <header className="details-header">
        <div className="details-title">
          <span className="kind-chip">Helm release</span>
          <strong>{release.name}</strong>
          <span className="muted">
            in {release.namespace} · {release.chart} · rev {release.revision}
          </span>
        </div>
        <div className="details-actions">
          <button className="danger" disabled={busy || readOnly} onClick={() => setPending({ action: "uninstall" })}>
            Uninstall
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
        {busy && <span className="muted tabs-status">Working…</span>}
        {status && <span className={`tabs-status ${status.kind === "error" ? "bad" : "ok"}`}>{status.text}</span>}
      </nav>
      <div className="details-body">
        {!details ? (
          <div className="empty">Loading…</div>
        ) : tab === "values" ? (
          <ReadOnlyCode text={details.values || "# Installed with the chart's default values."} language="yaml" />
        ) : tab === "manifest" ? (
          <ReadOnlyCode text={details.manifest} language="yaml" />
        ) : tab === "upgrade" ? (
          <UpgradeTab
            release={release}
            values={details.values}
            production={production}
            context={context}
            onDone={async () => {
              setStatus({ kind: "ok", text: "Upgraded." });
              setTab("history");
              await load();
              onChanged();
            }}
          />
        ) : tab === "notes" ? (
          <pre className="logs-body">{details.notes || "This chart has no notes."}</pre>
        ) : (
          <div className="simple-table">
            <div className="simple-row history head">
              <div>Revision</div>
              <div>Updated</div>
              <div>Status</div>
              <div>Chart</div>
              <div>Description</div>
              <div />
            </div>
            {details.history.map((h, i) => (
              <div className="simple-row history" key={h.revision}>
                <div>{h.revision}</div>
                <div>{new Date(h.updated).toLocaleString()}</div>
                <div className={h.status === "deployed" ? "ok" : h.status === "failed" ? "bad" : ""}>{h.status}</div>
                <div>{h.chart}</div>
                <div title={h.description}>{h.description}</div>
                <div>
                  {i > 0 && (
                    <button disabled={busy || readOnly} onClick={() => setPending({ action: "rollback", revision: h.revision })}>
                      Roll back
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {pending && (
        <ConfirmDialog
          title={pending.action === "rollback" ? `Roll back ${release.name} to revision ${pending.revision}?` : `Uninstall ${release.name}?`}
          message={
            pending.action === "rollback"
              ? `Helm creates a new revision with the manifests of revision ${pending.revision} on ${context}.`
              : `This removes every resource of the release from ${context}.`
          }
          confirmLabel={pending.action === "rollback" ? "Roll back" : "Uninstall"}
          typeToConfirm={production ? release.name : undefined}
          onConfirm={() => run(pending)}
          onCancel={() => setPending(null)}
        />
      )}
    </section>
  );
}

/** Finds which configured repository provides the release's chart, to prefill the upgrade. */
function UpgradeTab({ release, values, production, context, onDone }: { release: HelmRelease; values: string; production: boolean; context: string; onDone: () => void }) {
  const { name: chartName, version } = splitChart(release.chart);
  const [chartRef, setChartRef] = useState<string | null>(null);

  useEffect(() => {
    helmSearch(chartName).then(
      (charts) => setChartRef(charts.find((c) => c.name.endsWith(`/${chartName}`))?.name ?? chartName),
      () => setChartRef(chartName),
    );
  }, [chartName]);

  if (chartRef === null) return <div className="empty">Looking up {chartName} in your repositories…</div>;
  return (
    <ChartForm
      mode="upgrade"
      chart={chartRef}
      version={version}
      release={{ name: release.name, namespace: release.namespace }}
      values={values}
      production={production}
      context={context}
      onDone={onDone}
    />
  );
}

function ReadOnlyCode({ text, language }: { text: string; language: string }) {
  const monacoTheme = useCurrentTheme().monaco;
  return (
    <div className="yaml-editor">
      <Editor language={language} theme={monacoTheme} value={text} options={{ readOnly: true, minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false }} />
    </div>
  );
}
