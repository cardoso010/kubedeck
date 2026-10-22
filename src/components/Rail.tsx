import { useEffect, useState } from "react";
import { IconAppWindow, IconCheck, IconDownload, IconHexagons, IconPalette } from "@tabler/icons-react";
import { checkForUpdate, errorText, installUpdate, isProduction, openWindow, shortContextName, type UpdateStatus } from "../api";
import { getVersion } from "@tauri-apps/api/app";
import { clusterColor } from "../pins";
import { SECTIONS, type SectionId } from "../sections";
import { THEMES, type Theme, type ThemeId } from "../theme";

interface Props {
  section: SectionId;
  onSection: (id: SectionId) => void;
  connected: boolean;
  pins: string[];
  current: string | null;
  onSwitchCluster: (context: string) => void;
  onUnpin: (context: string) => void;
  onMoveUp: (context: string) => void;
  theme: Theme;
  onTheme: (id: ThemeId) => void;
  /** Critical problems in the selected namespaces, shown as a badge on Problems. */
  problemCount: number;
}

const initials = (context: string) =>
  shortContextName(context)
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("") || "?";

type Popover = { kind: "theme" } | { kind: "update" } | { kind: "cluster"; context: string; x: number; y: number };

/**
 * The thin left rail: sections, pinned clusters, and app actions. Clusters: click switches
 * this window, ⌘/Ctrl-click opens a new window, right-click for more.
 */
export default function Rail({ section, onSection, connected, pins, current, onSwitchCluster, onUnpin, onMoveUp, theme, onTheme, problemCount }: Props) {
  const [popover, setPopover] = useState<Popover | null>(null);
  const update = useUpdate();

  useEffect(() => {
    if (!popover) return;
    const close = (e: MouseEvent) => !(e.target as HTMLElement).closest(".rail-popover") && setPopover(null);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setPopover(null);
    setTimeout(() => window.addEventListener("click", close));
    window.addEventListener("keydown", esc);
    return () => (window.removeEventListener("click", close), window.removeEventListener("keydown", esc));
  }, [popover]);

  return (
    <nav className="rail">
      <div className="rail-logo" title="kubedeck">
        <IconHexagons size={20} stroke={1.6} />
      </div>

      {SECTIONS.map((s) => (
        <button
          key={s.id}
          className={`rail-button ${section === s.id ? "active" : ""}`}
          disabled={!connected}
          onClick={() => onSection(s.id)}
          aria-label={s.label}
          data-tip={s.label}
        >
          <s.icon size={18} stroke={1.6} />
          {s.id === "problems" && problemCount > 0 && <span className="rail-count">{problemCount > 99 ? "99+" : problemCount}</span>}
        </button>
      ))}

      {pins.length > 0 && <div className="rail-divider" />}
      {pins.map((context, i) => (
        <button
          key={context}
          className={`rail-cluster ${context === current ? "active" : ""} ${isProduction(context) ? "prod" : ""}`}
          style={{ background: clusterColor(context) }}
          data-tip={`${shortContextName(context)}${i < 9 ? `  ⌘${i + 1}` : ""}`}
          aria-label={`Switch to ${context}`}
          onClick={(e) => (e.metaKey || e.ctrlKey ? void openWindow(context) : onSwitchCluster(context))}
          onContextMenu={(e) => (e.preventDefault(), setPopover({ kind: "cluster", context, x: e.clientX, y: e.clientY }))}
        >
          {initials(context)}
        </button>
      ))}

      <div className="rail-spacer" />
      <button className="rail-button" data-tip="New window  ⌘N" aria-label="New window" onClick={() => void openWindow(null)}>
        <IconAppWindow size={18} stroke={1.6} />
      </button>
      <button className="rail-button" data-tip="Theme" aria-label="Theme" onClick={() => setPopover({ kind: "theme" })}>
        <IconPalette size={18} stroke={1.6} />
      </button>
      <button className="rail-button" data-tip={update.label} aria-label="Updates" onClick={() => setPopover({ kind: "update" })}>
        <IconDownload size={18} stroke={1.6} />
        {update.status?.status === "available" && <span className="rail-badge" />}
      </button>

      {popover?.kind === "theme" && (
        <div className="rail-popover" style={{ bottom: 64 }}>
          <div className="popover-title">Theme</div>
          {THEMES.map((t) => (
            <button key={t.id} className="popover-item" onClick={() => onTheme(t.id)}>
              <span className={`theme-swatch swatch-${t.id}`} />
              <span className="popover-item-text">
                <span>{t.label}</span>
                <span className="faint">{t.description}</span>
              </span>
              {t.id === theme.id && <IconCheck size={14} />}
            </button>
          ))}
        </div>
      )}
      {popover?.kind === "update" && (
        <div className="rail-popover" style={{ bottom: 20 }}>
          <div className="popover-title">kubedeck {update.version && `v${update.version}`}</div>
          <UpdateBody {...update} />
        </div>
      )}
      {popover?.kind === "cluster" && (
        <div className="rail-popover" style={{ top: popover.y - 10 }}>
          <div className="popover-title">{shortContextName(popover.context)}</div>
          <button className="popover-item" onClick={() => (void openWindow(popover.context), setPopover(null))}>
            Open in new window
          </button>
          <button className="popover-item" onClick={() => (onMoveUp(popover.context), setPopover(null))}>
            Move up
          </button>
          <button className="popover-item" onClick={() => (onUnpin(popover.context), setPopover(null))}>
            Unpin
          </button>
        </div>
      )}
    </nav>
  );
}

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** App version and update status: checked at start (after first paint) and every 6 hours. */
function useUpdate() {
  const [version, setVersion] = useState("");
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getVersion().then(setVersion, () => {});
    const check = () => checkForUpdate().then(setStatus, (e) => setStatus({ status: "error", message: errorText(e) }));
    const first = setTimeout(check, 3000);
    const every = setInterval(check, CHECK_EVERY_MS);
    return () => (clearTimeout(first), clearInterval(every));
  }, []);

  const install = async () => {
    setInstalling(true);
    setError(null);
    try {
      await installUpdate(); // restarts the app on success
    } catch (e) {
      setError(errorText(e));
      setInstalling(false);
    }
  };

  const label = status?.status === "available" ? `Update to ${status.version}` : `kubedeck ${version ? `v${version}` : ""}`;
  return { version, status, installing, error, install, label };
}

function UpdateBody({ status, installing, error, install }: ReturnType<typeof useUpdate>) {
  if (!status) return <div className="popover-text faint">Checking for updates…</div>;
  switch (status.status) {
    case "available":
      return (
        <div className="popover-text">
          <div>Version {status.version} is available.</div>
          <button className="primary" disabled={installing} onClick={install}>
            {installing ? "Installing…" : "Install and restart"}
          </button>
          {error && <div className="bad">{error}</div>}
        </div>
      );
    case "upToDate":
      return <div className="popover-text faint">You're on the latest version.</div>;
    case "noCredentials":
      return (
        <div className="popover-text faint">
          Updates come from a private GitHub repository. Run <code>gh auth login</code> to get them.
        </div>
      );
    case "error":
      return <div className="popover-text faint">Update check failed: {status.message}</div>;
  }
}
