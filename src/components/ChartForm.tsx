import { useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { useTranslation } from "react-i18next";
import { useCurrentTheme } from "../theme";
import { errorText, helmChartVersions, helmInstall, helmShowValues, helmUpgrade, type HelmChart } from "../api";
import ConfirmDialog from "./ConfirmDialog";

interface Props {
  mode: "install" | "upgrade";
  /** Chart reference: repo/chart, oci://…, URL or path. */
  chart: string;
  /** Preferred version; the newest one when null. */
  version: string | null;
  /** Release name and namespace; fixed when upgrading. */
  release: { name: string; namespace: string };
  /** Starting values. null loads the chart's defaults (install). */
  values: string | null;
  namespaces?: string[];
  production: boolean;
  context: string;
  onDone: (output: string) => void;
}

type Output = { kind: "dry" | "error"; text: string };

/** Version, values and target for `helm install` / `helm upgrade`, with a dry run first. */
export default function ChartForm({ mode, chart: initialChart, version: initialVersion, release, values: initialValues, namespaces = [], production, context, onDone }: Props) {
  const { t } = useTranslation();
  const monacoTheme = useCurrentTheme().monaco;
  const [chart, setChart] = useState(initialChart);
  const [versions, setVersions] = useState<HelmChart[]>([]);
  const [version, setVersion] = useState<string>(initialVersion ?? "");
  const [values, setValues] = useState(initialValues ?? "");
  const [valuesLoaded, setValuesLoaded] = useState(initialValues !== null);
  const [name, setName] = useState(release.name);
  const [namespace, setNamespace] = useState(release.namespace);
  const [createNamespace, setCreateNamespace] = useState(false);
  const [output, setOutput] = useState<Output | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const valuesTouched = useRef(initialValues !== null);

  // Versions of the chart (repo charts only; OCI and paths have no index).
  useEffect(() => {
    let stale = false;
    helmChartVersions(chart).then(
      (list) => {
        if (stale) return;
        setVersions(list);
        if (!initialVersion || !list.some((c) => c.version === initialVersion)) setVersion(list[0]?.version ?? initialVersion ?? "");
      },
      () => !stale && setVersions([]),
    );
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart]);

  // Installing starts from the chart's defaults until the user edits them.
  useEffect(() => {
    if (valuesTouched.current || !chart) return;
    let stale = false;
    helmShowValues(chart, version || null).then(
      (v) => !stale && (setValues(v), setValuesLoaded(true)),
      (e) => !stale && (setOutput({ kind: "error", text: errorText(e) }), setValuesLoaded(true)),
    );
    return () => {
      stale = true;
    };
  }, [chart, version]);

  async function loadDefaults() {
    try {
      setValues(await helmShowValues(chart, version || null));
      valuesTouched.current = false;
    } catch (e) {
      setOutput({ kind: "error", text: errorText(e) });
    }
  }

  async function run(dryRun: boolean) {
    setConfirming(false);
    setBusy(true);
    setOutput(null);
    const request = { namespace, name, chart, version: version || null, values, createNamespace, dryRun };
    try {
      const text = await (mode === "install" ? helmInstall(request) : helmUpgrade(request));
      if (dryRun) setOutput({ kind: "dry", text });
      else onDone(text);
    } catch (e) {
      setOutput({ kind: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  const valid = chart.trim() !== "" && name.trim() !== "" && namespace.trim() !== "";
  const verb = mode === "install" ? t("helm.form.install") : t("helm.form.upgrade");

  return (
    <div className="chart-form">
      <div className="chart-form-fields">
        <label className="field">
          <span>{t("helm.form.chart")}</span>
          <input value={chart} onChange={(e) => setChart(e.target.value)} placeholder={t("helm.form.chartPlaceholder")} />
        </label>
        <label className="field">
          <span>{t("helm.form.version")}</span>
          {versions.length > 0 ? (
            <select value={version} onChange={(e) => setVersion(e.target.value)}>
              {versions.map((c) => (
                <option key={c.version} value={c.version}>
                  {c.version}
                  {c.appVersion ? ` (${t("helm.form.app", { version: c.appVersion })})` : ""}
                </option>
              ))}
            </select>
          ) : (
            <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder={t("helm.form.latest")} />
          )}
        </label>
        <label className="field">
          <span>{t("helm.form.releaseName")}</span>
          <input value={name} disabled={mode === "upgrade"} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>{t("common.namespace")}</span>
          {mode === "upgrade" ? (
            <input value={namespace} disabled />
          ) : (
            <>
              <input list="chart-form-namespaces" value={namespace} onChange={(e) => setNamespace(e.target.value)} />
              <datalist id="chart-form-namespaces">
                {namespaces.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </>
          )}
        </label>
        {mode === "install" && !namespaces.includes(namespace) && namespace.trim() !== "" && (
          <label className="checkbox">
            <input type="checkbox" checked={createNamespace} onChange={(e) => setCreateNamespace(e.target.checked)} /> {t("helm.form.createNamespace", { namespace })}
          </label>
        )}
      </div>

      <div className="chart-form-values">
        <div className="yaml-toolbar">
          <strong>{t("helm.form.values")}</strong>
          {mode === "upgrade" && <span className="muted">{t("helm.form.currentValues")}</span>}
          <button onClick={loadDefaults} disabled={busy || !chart}>
            {t("helm.form.defaults")}
          </button>
        </div>
        <div className="yaml-editor">
          {valuesLoaded ? (
            <Editor
              language="yaml"
              theme={monacoTheme}
              value={values}
              onChange={(v) => {
                valuesTouched.current = true;
                setValues(v ?? "");
              }}
              options={{ minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false, tabSize: 2 }}
            />
          ) : (
            <div className="empty">{t("helm.form.loadingValues")}</div>
          )}
        </div>
      </div>

      {output && (
        <div className={`chart-output ${output.kind}`}>
          <div className="yaml-toolbar">
            <strong>{output.kind === "dry" ? t("helm.form.dryRunOutput") : t("helm.form.error")}</strong>
            <button onClick={() => setOutput(null)}>{t("helm.form.hide")}</button>
          </div>
          <pre>{output.text}</pre>
        </div>
      )}

      <div className="chart-form-actions">
        {busy && <span className="muted">{t("helm.form.running")}</span>}
        <button disabled={!valid || busy} onClick={() => run(true)}>
          {t("helm.form.dryRun")}
        </button>
        <button className="primary" disabled={!valid || busy} onClick={() => (production ? setConfirming(true) : run(false))}>
          {verb}
        </button>
      </div>

      {confirming && (
        <ConfirmDialog
          title={t(mode === "install" ? "helm.form.confirmInstall" : "helm.form.confirmUpgrade", { name })}
          message={t(mode === "install" ? "helm.form.installs" : "helm.form.upgrades", { chart: version ? `${chart} ${version}` : chart, namespace, cluster: context })}
          confirmLabel={verb}
          typeToConfirm={name}
          onConfirm={() => run(false)}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
