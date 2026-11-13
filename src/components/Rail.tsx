import { useEffect, useState } from "react";
import Logo from "./Logo";
import { IconAppWindow, IconBrandGithub, IconBug, IconCheck, IconDownload, IconInfoCircle, IconLink, IconNews, IconSettings, IconTerminal2, IconWorld } from "@tabler/icons-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import { checkForUpdate, errorText, installUpdate, isProduction, openWindow, shortContextName, type UpdateStatus } from "../api";
import { getVersion } from "@tauri-apps/api/app";
import { bugReportUrl, INSTALL_COMMAND, REPO_URL, SITE_URL } from "../about";
import { clusterColor } from "../pins";
import { SECTIONS, type SectionId } from "../sections";

interface Props {
  section: SectionId;
  onSection: (id: SectionId) => void;
  connected: boolean;
  pins: string[];
  current: string | null;
  onSwitchCluster: (context: string) => void;
  onUnpin: (context: string) => void;
  onMoveUp: (context: string) => void;
  onSettings: () => void;
  /** Critical problems in the selected namespaces, shown as a badge on Problems. */
  problemCount: number;
  /** Bumped by the command palette to open the About popover. */
  aboutRequest: number;
}

const initials = (context: string) =>
  shortContextName(context)
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("") || "?";

type Popover = { kind: "update" } | { kind: "about" } | { kind: "cluster"; context: string; x: number; y: number };

/**
 * The thin left rail: sections, pinned clusters, and app actions. Clusters: click switches
 * this window, ⌘/Ctrl-click opens a new window, right-click for more.
 */
export default function Rail({ section, onSection, connected, pins, current, onSwitchCluster, onUnpin, onMoveUp, onSettings, problemCount, aboutRequest }: Props) {
  const { t } = useTranslation();
  const [popover, setPopover] = useState<Popover | null>(null);
  const update = useUpdate();

  useEffect(() => {
    if (aboutRequest > 0) setPopover({ kind: "about" });
  }, [aboutRequest]);

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
        <Logo size={20} />
      </div>

      {SECTIONS.map((s) => (
        <button
          key={s.id}
          className={`rail-button ${section === s.id ? "active" : ""}`}
          disabled={!connected}
          onClick={() => onSection(s.id)}
          aria-label={t(`app.sections.${s.id}`)}
          data-tip={t(`app.sections.${s.id}`)}
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
          aria-label={t("rail.switchTo", { cluster: context })}
          onClick={(e) => (e.metaKey || e.ctrlKey ? void openWindow(context) : onSwitchCluster(context))}
          onContextMenu={(e) => (e.preventDefault(), setPopover({ kind: "cluster", context, x: e.clientX, y: e.clientY }))}
        >
          {initials(context)}
        </button>
      ))}

      <div className="rail-spacer" />
      <button className="rail-button" data-tip={`${t("rail.newWindow")}  ⌘N`} aria-label={t("rail.newWindow")} onClick={() => void openWindow(null)}>
        <IconAppWindow size={18} stroke={1.6} />
      </button>
      <button className="rail-button" data-tip={`${t("rail.settings")}  ⌘,`} aria-label={t("rail.settings")} onClick={onSettings}>
        <IconSettings size={18} stroke={1.6} />
      </button>
      <button className="rail-button" data-tip={update.label} aria-label={t("rail.updates")} onClick={() => setPopover({ kind: "update" })}>
        <IconDownload size={18} stroke={1.6} />
        {update.status?.status === "available" && <span className="rail-badge" />}
      </button>
      <button className="rail-button" data-tip={t("rail.about")} aria-label={t("rail.about")} onClick={() => setPopover({ kind: "about" })}>
        <IconInfoCircle size={18} stroke={1.6} />
      </button>

      {popover?.kind === "update" && (
        <div className="rail-popover" style={{ bottom: 64 }}>
          <div className="popover-title">kubedeck {update.version && `v${update.version}`}</div>
          <UpdateBody {...update} />
        </div>
      )}
      {popover?.kind === "about" && <About version={update.version} />}
      {popover?.kind === "cluster" && (
        <div className="rail-popover" style={{ top: popover.y - 10 }}>
          <div className="popover-title">{shortContextName(popover.context)}</div>
          <button className="popover-item" onClick={() => (void openWindow(popover.context), setPopover(null))}>
            {t("rail.cluster.openInWindow")}
          </button>
          <button className="popover-item" onClick={() => (onMoveUp(popover.context), setPopover(null))}>
            {t("rail.cluster.moveUp")}
          </button>
          <button className="popover-item" onClick={() => (onUnpin(popover.context), setPopover(null))}>
            {t("rail.cluster.unpin")}
          </button>
        </div>
      )}
    </nav>
  );
}

/** Version, project links and a way to share the app. */
function About({ version }: { version: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (what: string, text: string) =>
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    });
  const link = (url: string) => () => void openUrl(url);

  return (
    <div className="rail-popover about" style={{ bottom: 20 }}>
      <div className="about-head">
        <Logo size={26} />
        <div>
          <strong>kubedeck</strong> <span className="faint">{version && `v${version}`}</span>
          <div className="faint">{t("rail.aboutPopover.tagline")}</div>
        </div>
      </div>
      <div className="popover-title">{t("rail.aboutPopover.share")}</div>
      <button className="popover-item" onClick={() => copy("link", SITE_URL)}>
        <IconLink size={15} />
        <span className="popover-item-text">
          <span>{copied === "link" ? t("common.copied") : t("rail.aboutPopover.copyLink")}</span>
          <span className="faint">{SITE_URL.replace("https://", "").replace(/\/$/, "")}</span>
        </span>
        {copied === "link" && <IconCheck size={14} />}
      </button>
      <button className="popover-item" onClick={() => copy("install", INSTALL_COMMAND)}>
        <IconTerminal2 size={15} />
        <span className="popover-item-text">
          <span>{copied === "install" ? t("common.copied") : t("rail.aboutPopover.copyInstall")}</span>
          <span className="faint">{t("rail.aboutPopover.installHint")}</span>
        </span>
        {copied === "install" && <IconCheck size={14} />}
      </button>
      <div className="popover-title">{t("rail.aboutPopover.links")}</div>
      <button className="popover-item" onClick={link(SITE_URL)}>
        <IconWorld size={15} /> {t("rail.aboutPopover.website")}
      </button>
      <button className="popover-item" onClick={link(REPO_URL)}>
        <IconBrandGithub size={15} /> GitHub
      </button>
      <button className="popover-item" onClick={link(version ? `${REPO_URL}/releases/tag/v${version}` : `${REPO_URL}/releases`)}>
        <IconNews size={15} /> {t("rail.aboutPopover.whatsNew")}
      </button>
      <button className="popover-item" onClick={link(bugReportUrl(version))}>
        <IconBug size={15} /> {t("rail.aboutPopover.reportBug")}
      </button>
    </div>
  );
}

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** App version and update status: checked at start (after first paint) and every 6 hours. */
function useUpdate() {
  const { t } = useTranslation();
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

  const label = status?.status === "available" ? t("rail.update.updateTo", { version: status.version }) : `kubedeck ${version ? `v${version}` : ""}`;
  return { version, status, installing, error, install, label };
}

function UpdateBody({ status, installing, error, install }: ReturnType<typeof useUpdate>) {
  const { t } = useTranslation();
  if (!status) return <div className="popover-text faint">{t("rail.update.checking")}</div>;
  switch (status.status) {
    case "available":
      return (
        <div className="popover-text">
          <div>{t("rail.update.available", { version: status.version })}</div>
          <button className="primary" disabled={installing} onClick={install}>
            {installing ? t("rail.update.installing") : t("rail.update.install")}
          </button>
          {error && <div className="bad">{error}</div>}
        </div>
      );
    case "upToDate":
      return <div className="popover-text faint">{t("rail.update.upToDate")}</div>;
    case "error":
      return <div className="popover-text faint">{t("rail.update.failed", { message: status.message })}</div>;
  }
}
