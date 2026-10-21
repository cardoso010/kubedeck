import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { errorText, startPortForward, type ForwardInfo } from "../api";

interface Props {
  kind: "pod" | "service";
  namespace: string;
  name: string;
  ports: number[];
}

/** One "Forward" button per port of the selected pod or service. */
export default function PortForwardButtons({ kind, namespace, name, ports }: Props) {
  const [started, setStarted] = useState<ForwardInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function forward(port: number) {
    setBusy(true);
    setError(null);
    try {
      setStarted(await startPortForward(kind, namespace, name, port));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (ports.length === 0) return null;
  const url = started && `http://localhost:${started.localPort}`;

  return (
    <div className="forward-bar">
      <span className="muted">Port forward:</span>
      {[...new Set(ports)].map((p) => (
        <button key={p} disabled={busy} onClick={() => forward(p)}>
          :{p}
        </button>
      ))}
      {started && url && (
        <span className="ok">
          {started.remotePort} → <a href={url} onClick={(e) => (e.preventDefault(), void openUrl(url))}>{url}</a>
        </span>
      )}
      {error && <span className="bad">{error}</span>}
    </div>
  );
}
