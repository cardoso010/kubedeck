import { useEffect, useMemo, useState } from "react";
import { Editor } from "./CodeEditor";
import { useTranslation } from "react-i18next";
import { IconEye, IconEyeOff } from "@tabler/icons-react";
import { useCurrentTheme } from "../theme";
import { errorText, helmDetails, helmList, helmRollback, helmSearch, helmUninstall, splitChart, type HelmDetails, type HelmRelease, type KindInfo, type Row } from "../api";
import ResourceTable from "./ResourceTable";
import ConfirmDialog from "./ConfirmDialog";
import ChartForm from "./ChartForm";
import InstallChartDialog from "./InstallChartDialog";
import { useReadOnly } from "../readOnly";
import { usePoll } from "../usePoll";

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
  const { t, i18n } = useTranslation();
  const kind = useMemo<KindInfo>(
    () => ({ key: "helm", label: t("helm.releases"), namespaced: true, columns: [t("helm.columns.revision"), t("helm.columns.status"), t("helm.columns.chart"), t("helm.columns.appVersion")] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [i18n.language],
  );
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
  }, [namespaces.join(",")]);
  usePoll(refresh, POLL_MS, [namespaces.join(",")]);

  const rows = useMemo(() => (releases ?? []).map(toRow).sort((a, b) => a.name.localeCompare(b.name)), [releases]);
  const release = releases?.find((r) => `${r.namespace}/${r.name}` === selected) ?? null;

  return (
    <>
      <ResourceTable
        kind={kind}
        rows={rows}
        loading={releases === null && !error}
        error={error}
        errorPrefix="Helm"
        ageLabel={t("helm.columns.updated")}
        showNamespace={namespaces.length !== 1}
        selectedUid={selected}
        onSelect={(r) => setSelected(r.uid)}
        actions={
          <button className="primary" onClick={() => setInstalling(true)}>
            {t("helm.installChart")}
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
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("values");
  const [details, setDetails] = useState<HelmDetails | null>(null);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const readOnly = useReadOnly();
  const [pending, setPending] = useState<Pending | null>(null);
  // Credentials in values and rendered Secrets come masked until revealed (confirmed on production).
  const [revealed, setRevealed] = useState(false);
  const [askReveal, setAskReveal] = useState(false);

  const load = () => helmDetails(release.namespace, release.name, revealed).then(setDetails, (e) => setStatus({ kind: "error", text: errorText(e) }));
  // Reload whenever the release gets a new revision (rollback here, or an upgrade elsewhere).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void load(), [release.revision, revealed]);

  const toggleReveal = () => (revealed ? setRevealed(false) : production ? setAskReveal(true) : setRevealed(true));

  async function run(p: Pending) {
    setPending(null);
    setBusy(true);
    setStatus(null);
    try {
      if (p.action === "rollback") {
        await helmRollback(release.namespace, release.name, p.revision);
        setStatus({ kind: "ok", text: t("helm.rolledBack", { revision: p.revision }) });
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
    ["values", t("helm.tabs.values")],
    ["manifest", t("helm.tabs.manifest")],
    ["notes", t("helm.tabs.notes")],
    ["history", t("helm.tabs.history")],
    ["upgrade", t("helm.tabs.upgrade")],
  ];

  return (
    <section className="details">
      <header className="details-header">
        <div className="details-title">
          <span className="kind-chip">{t("helm.release")}</span>
          <strong>{release.name}</strong>
          <span className="muted">
            {t("helm.subtitle", { namespace: release.namespace, chart: release.chart, revision: release.revision })}
          </span>
        </div>
        <div className="details-actions">
          <button onClick={toggleReveal} title={revealed ? t("resources.yaml.hide") : t("resources.yaml.reveal")}>
            {revealed ? <IconEyeOff size={14} /> : <IconEye size={14} />} {revealed ? t("resources.secrets.hide") : t("resources.secrets.reveal")}
          </button>
          <button className="danger" disabled={busy || readOnly} onClick={() => setPending({ action: "uninstall" })}>
            {t("helm.uninstall")}
          </button>
          <button onClick={onClose} aria-label={t("common.close")}>
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
        {busy && <span className="muted tabs-status">{t("helm.working")}</span>}
        {status && <span className={`tabs-status ${status.kind === "error" ? "bad" : "ok"}`}>{status.text}</span>}
      </nav>
      <div className="details-body">
        {!details ? (
          <div className="empty">{t("common.loading")}</div>
        ) : tab === "values" ? (
          <ReadOnlyCode text={details.values || `# ${t("helm.defaultValues")}`} language="yaml" />
        ) : tab === "manifest" ? (
          <ReadOnlyCode text={details.manifest} language="yaml" />
        ) : tab === "upgrade" && !revealed ? (
          <div className="empty">
            <p>{t("helm.revealToUpgrade")}</p>
            <button onClick={toggleReveal}>
              <IconEye size={14} /> {t("resources.yaml.reveal")}
            </button>
          </div>
        ) : tab === "upgrade" ? (
          <UpgradeTab
            release={release}
            values={details.values}
            production={production}
            context={context}
            onDone={async () => {
              setStatus({ kind: "ok", text: t("helm.upgraded") });
              setTab("history");
              await load();
              onChanged();
            }}
          />
        ) : tab === "notes" ? (
          <pre className="logs-body">{details.notes || t("helm.noNotes")}</pre>
        ) : (
          <div className="simple-table">
            <div className="simple-row history head">
              <div>{t("helm.columns.revision")}</div>
              <div>{t("helm.columns.updated")}</div>
              <div>{t("helm.columns.status")}</div>
              <div>{t("helm.columns.chart")}</div>
              <div>{t("helm.columns.description")}</div>
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
                      {t("helm.rollback")}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {askReveal && (
        <ConfirmDialog
          title={t("resources.secrets.revealTitle")}
          message={t("resources.secrets.revealMessage", { name: release.name })}
          confirmLabel={t("resources.secrets.reveal")}
          onConfirm={() => (setAskReveal(false), setRevealed(true))}
          onCancel={() => setAskReveal(false)}
        />
      )}
      {pending && (
        <ConfirmDialog
          title={
            pending.action === "rollback"
              ? t("helm.confirmRollback.title", { name: release.name, revision: pending.revision })
              : t("helm.confirmUninstall.title", { name: release.name })
          }
          message={
            pending.action === "rollback"
              ? t("helm.confirmRollback.message", { revision: pending.revision, cluster: context })
              : t("helm.confirmUninstall.message", { cluster: context })
          }
          confirmLabel={pending.action === "rollback" ? t("helm.rollback") : t("helm.uninstall")}
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
  const { t } = useTranslation();
  const [chartRef, setChartRef] = useState<string | null>(null);

  useEffect(() => {
    helmSearch(chartName).then(
      (charts) => setChartRef(charts.find((c) => c.name.endsWith(`/${chartName}`))?.name ?? chartName),
      () => setChartRef(chartName),
    );
  }, [chartName]);

  if (chartRef === null) return <div className="empty">{t("helm.lookingUp", { chart: chartName })}</div>;
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
