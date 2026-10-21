import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { errorText, listPortForwards, stopStream, type ForwardInfo } from "../api";

/** Active port forwards of the connected cluster. They stop when switching clusters. */
export default function PortForwardsView() {
  const [forwards, setForwards] = useState<ForwardInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => listPortForwards().then(setForwards, (e) => setError(errorText(e)));

  useEffect(() => {
    void refresh();
    // Connection counts and errors change in the background.
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, []);

  async function stop(id: number) {
    await stopStream(id);
    void refresh();
  }

  return (
    <section className="table">
      <header className="table-toolbar">
        <h2>Port Forwards</h2>
        <span className="count">{forwards?.length ?? ""}</span>
      </header>
      {error && <div className="error-bar">{error}</div>}
      <div className="simple-table">
        <div className="simple-row head">
          <div>Resource</div>
          <div>Namespace</div>
          <div>Remote</div>
          <div>Local</div>
          <div>Connections</div>
          <div>Last error</div>
          <div />
        </div>
        {forwards?.map((f) => {
          const url = `http://localhost:${f.localPort}`;
          return (
            <div className="simple-row" key={f.id}>
              <div title={f.name}>
                <span className="kind-chip">{f.kind}</span> {f.name}
              </div>
              <div>{f.namespace}</div>
              <div>{f.remotePort}</div>
              <div>
                <a href={url} onClick={(e) => (e.preventDefault(), void openUrl(url))}>
                  localhost:{f.localPort}
                </a>
              </div>
              <div>{f.connections}</div>
              <div className="bad" title={f.lastError ?? ""}>
                {f.lastError}
              </div>
              <div>
                <button onClick={() => stop(f.id)}>Stop</button>
              </div>
            </div>
          );
        })}
        {forwards?.length === 0 && <div className="empty">No active port forwards. Open a pod or service and click one of its ports.</div>}
      </div>
    </section>
  );
}
