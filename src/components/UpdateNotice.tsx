import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { checkForUpdate, errorText, installUpdate, type UpdateStatus } from "../api";

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** App version plus update status, in the sidebar footer. */
export default function UpdateNotice() {
  const [version, setVersion] = useState("");
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  useEffect(() => {
    getVersion().then(setVersion, () => {});
    const check = () => checkForUpdate().then(setStatus, (e) => setStatus({ status: "error", message: errorText(e) }));
    // Let the window paint before talking to GitHub.
    const first = setTimeout(check, 3000);
    const every = setInterval(check, CHECK_EVERY_MS);
    return () => (clearTimeout(first), clearInterval(every));
  }, []);

  async function install() {
    setInstalling(true);
    setInstallError(null);
    try {
      await installUpdate(); // restarts the app on success
    } catch (e) {
      setInstallError(errorText(e));
      setInstalling(false);
    }
  }

  return (
    <div className="update-notice">
      <span className="muted">kubedeck {version && `v${version}`}</span>
      {status?.status === "available" && (
        <div className="update-available">
          <div>Version {status.version} is available.</div>
          <button className="primary" disabled={installing} onClick={install} title={status.notes ?? undefined}>
            {installing ? "Installing…" : "Install and restart"}
          </button>
          {installError && <div className="bad">{installError}</div>}
        </div>
      )}
      {status?.status === "noCredentials" && (
        <div className="muted" title="Updates come from a private GitHub repository">
          Run <code>gh auth login</code> to get updates.
        </div>
      )}
      {status?.status === "error" && (
        <div className="muted" title={status.message}>
          Update check failed.
        </div>
      )}
    </div>
  );
}
