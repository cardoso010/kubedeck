import { useEffect, useState } from "react";
import { errorText, helmRepoAdd, helmRepoList, helmRepoRemove, helmRepoUpdate, helmSearch, type HelmChart, type HelmRepo } from "../api";
import ChartForm from "./ChartForm";

interface Props {
  namespaces: string[];
  defaultNamespace: string;
  production: boolean;
  context: string;
  onInstalled: () => void;
  onClose: () => void;
}

/** Search the configured repositories, pick a chart, install it. */
export default function InstallChartDialog({ namespaces, defaultNamespace, production, context, onInstalled, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [charts, setCharts] = useState<HelmChart[] | null>(null);
  const [repos, setRepos] = useState<HelmRepo[] | null>(null);
  const [showRepos, setShowRepos] = useState(false);
  const [chosen, setChosen] = useState<HelmChart | null>(null);
  const [manualRef, setManualRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(null);

  const loadRepos = () => helmRepoList().then((r) => (setRepos(r), r.length === 0 && setShowRepos(true)), (e) => setError(errorText(e)));
  useEffect(() => void loadRepos(), []);

  useEffect(() => {
    const t = setTimeout(() => {
      helmSearch(query).then(
        (c) => (setCharts(c), setError(null)),
        (e) => (setCharts([]), setError(errorText(e))),
      );
    }, 250);
    return () => clearTimeout(t);
  }, [query, repos]);

  const chartRef = chosen?.name ?? manualRef;
  const releaseName = chartRef.split("/").pop()?.replace(/[^a-z0-9-]/g, "-") ?? "";

  return (
    <div className="modal-backdrop">
      <div className="modal modal-large">
        <header className="modal-header">
          <h3>{notes !== null ? "Installed" : "Install a Helm chart"}</h3>
          <div className="details-actions">
            <button onClick={() => setShowRepos(!showRepos)}>{showRepos ? "Hide repositories" : "Repositories"}</button>
            <button onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
        </header>

        {notes !== null ? (
          <div className="chart-output dry">
            <pre>{notes || "Release installed."}</pre>
            <div className="modal-actions">
              <button className="primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <div className="install-layout">
            <aside className="install-search">
              {showRepos && repos && <RepoManager repos={repos} onChanged={loadRepos} />}
              <input autoFocus placeholder="Search charts…" value={query} onChange={(e) => setQuery(e.target.value)} />
              {error && <div className="bad">{error}</div>}
              <div className="chart-results">
                {charts?.map((c) => (
                  <button key={c.name} className={`chart-result ${chosen?.name === c.name ? "active" : ""}`} onClick={() => (setChosen(c), setManualRef(""))}>
                    <div className="chart-result-title">
                      <strong>{c.name}</strong> <span className="muted">{c.version}</span>
                    </div>
                    <div className="muted chart-result-desc">{c.description}</div>
                  </button>
                ))}
                {charts?.length === 0 && !error && <div className="muted">No charts found. Add a repository, or type a chart reference below.</div>}
              </div>
              <label className="field">
                <span>Or a chart reference</span>
                <input placeholder="oci://registry/chart or ./path" value={manualRef} onChange={(e) => (setManualRef(e.target.value), setChosen(null))} />
              </label>
            </aside>
            <section className="install-form">
              {chartRef ? (
                <ChartForm
                  key={chartRef}
                  mode="install"
                  chart={chartRef}
                  version={null}
                  release={{ name: releaseName, namespace: defaultNamespace }}
                  values={null}
                  namespaces={namespaces}
                  production={production}
                  context={context}
                  onDone={(out) => (setNotes(out), onInstalled())}
                />
              ) : (
                <div className="empty">Pick a chart on the left.</div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function RepoManager({ repos, onChanged }: { repos: HelmRepo[]; onChanged: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="repo-manager">
      <div className="yaml-toolbar">
        <strong>Repositories</strong>
        <button disabled={busy || repos.length === 0} onClick={() => act(helmRepoUpdate)}>
          Update all
        </button>
      </div>
      {repos.map((r) => (
        <div key={r.name} className="repo-row">
          <div>
            <strong>{r.name}</strong>
            <div className="muted">{r.url}</div>
          </div>
          <button disabled={busy} onClick={() => act(() => helmRepoRemove(r.name))}>
            Remove
          </button>
        </div>
      ))}
      {repos.length === 0 && <div className="muted">No repositories yet. These are the same ones `helm repo list` shows.</div>}
      <div className="repo-add">
        <input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="https://charts.example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
        <button
          className="primary"
          disabled={busy || !name.trim() || !url.trim()}
          onClick={() =>
            act(async () => {
              await helmRepoAdd(name.trim(), url.trim());
              setName("");
              setUrl("");
            })
          }
        >
          Add
        </button>
      </div>
      {busy && <div className="muted">Working…</div>}
      {error && <div className="bad">{error}</div>}
    </div>
  );
}
