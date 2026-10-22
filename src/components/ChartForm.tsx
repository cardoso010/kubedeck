import { useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
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
  const verb = mode === "install" ? "Install" : "Upgrade";

  return (
    <div className="chart-form">
      <div className="chart-form-fields">
        <label className="field">
          <span>Chart</span>
          <input value={chart} onChange={(e) => setChart(e.target.value)} placeholder="repo/chart, oci://… or a path" />
        </label>
        <label className="field">
          <span>Version</span>
          {versions.length > 0 ? (
            <select value={version} onChange={(e) => setVersion(e.target.value)}>
              {versions.map((c) => (
                <option key={c.version} value={c.version}>
                  {c.version}
                  {c.appVersion ? ` (app ${c.appVersion})` : ""}
                </option>
              ))}
            </select>
          ) : (
            <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="latest" />
          )}
        </label>
        <label className="field">
          <span>Release name</span>
          <input value={name} disabled={mode === "upgrade"} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>Namespace</span>
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
            <input type="checkbox" checked={createNamespace} onChange={(e) => setCreateNamespace(e.target.checked)} /> Create namespace {namespace}
          </label>
        )}
      </div>

      <div className="chart-form-values">
        <div className="yaml-toolbar">
          <strong>Values</strong>
          {mode === "upgrade" && <span className="muted">starting from the release's current values</span>}
          <button onClick={loadDefaults} disabled={busy || !chart}>
            Chart defaults
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
            <div className="empty">Loading chart values…</div>
          )}
        </div>
      </div>

      {output && (
        <div className={`chart-output ${output.kind}`}>
          <div className="yaml-toolbar">
            <strong>{output.kind === "dry" ? "Dry run: rendered manifests (nothing was changed)" : "Error"}</strong>
            <button onClick={() => setOutput(null)}>Hide</button>
          </div>
          <pre>{output.text}</pre>
        </div>
      )}

      <div className="chart-form-actions">
        {busy && <span className="muted">Running helm…</span>}
        <button disabled={!valid || busy} onClick={() => run(true)}>
          Dry run
        </button>
        <button className="primary" disabled={!valid || busy} onClick={() => (production ? setConfirming(true) : run(false))}>
          {verb}
        </button>
      </div>

      {confirming && (
        <ConfirmDialog
          title={`${verb} ${name} on production?`}
          message={`This ${mode === "install" ? "installs" : "upgrades"} ${chart}${version ? ` ${version}` : ""} in ${namespace} on ${context}.`}
          confirmLabel={verb}
          typeToConfirm={name}
          onConfirm={() => run(false)}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
