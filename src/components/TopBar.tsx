import { useEffect, useMemo, useRef, useState } from "react";
import { IconChevronDown, IconLock, IconLockOpen, IconPlus, IconPin, IconPinnedFilled, IconSearch } from "@tabler/icons-react";
import { isProduction, openWindow, shortContextName, type ContextInfo } from "../api";
import { clusterColor } from "../pins";
import { useTranslation } from "react-i18next";
import NamespacePicker from "./NamespacePicker";

interface Props {
  contexts: ContextInfo[];
  current: string | null;
  currentLabel: string | null;
  connecting: boolean;
  serverVersion: string | null;
  onSwitchCluster: (context: string) => void;
  pins: string[];
  onTogglePin: (context: string) => void;
  namespaces: string[];
  selectedNamespaces: string[];
  namespacesEnabled: boolean;
  onNamespaces: (selected: string[]) => void;
  viewLabel: string;
  onOpenPalette: () => void;
  /** Read-only state of the window, null when not connected. */
  lock: { locked: boolean; minutesLeft: number | null } | null;
  onToggleLock: () => void;
  /** Opens "Create from YAML"; null when not connected. */
  onCreate: (() => void) | null;
}

/** Breadcrumb bar: cluster › namespaces › view, plus the command palette trigger. */
export default function TopBar(p: Props) {
  const { t } = useTranslation();
  const prod = p.current ? isProduction(p.current) : false;
  return (
    <header className="topbar">
      <ClusterCrumb {...p} />
      <span className="crumb-sep">/</span>
      <NamespacePicker
        namespaces={p.namespaces}
        selected={p.selectedNamespaces}
        disabled={!p.current || !p.namespacesEnabled}
        clusterScoped={!!p.current && !p.namespacesEnabled}
        onChange={p.onNamespaces}
        variant="crumb"
      />
      <span className="crumb-sep">/</span>
      <span className="crumb crumb-static">{p.viewLabel}</span>

      <div className="topbar-right">
        {p.lock &&
          (p.lock.locked ? (
            <button className="lock-chip locked" onClick={p.onToggleLock} title={t("app.topbar.lockedTitle")}>
              <IconLock size={12} /> {t("app.topbar.readOnly")}
            </button>
          ) : p.lock.minutesLeft !== null ? (
            <button className="lock-chip unlocked" onClick={p.onToggleLock} title={t("app.topbar.relockTitle")}>
              <IconLockOpen size={12} /> {t("app.topbar.unlocked", { minutes: p.lock.minutesLeft })}
            </button>
          ) : (
            <button className="lock-chip open" onClick={p.onToggleLock} title={t("app.topbar.lockTitle")}>
              <IconLockOpen size={12} />
            </button>
          ))}
        {prod && <span className="prod-badge">{t("app.topbar.production")}</span>}
        {p.serverVersion && <span className="faint mono">{p.serverVersion}</span>}
        {p.onCreate && (
          <button className="icon-button" title={t("app.topbar.create")} aria-label={t("app.topbar.create")} onClick={p.onCreate}>
            <IconPlus size={15} />
          </button>
        )}
        <button className="search-trigger" onClick={p.onOpenPalette}>
          <IconSearch size={14} stroke={1.8} />
          <span>{t("app.topbar.search")}</span>
          <kbd>⌘K</kbd>
        </button>
      </div>
    </header>
  );
}

function ClusterCrumb({ contexts, current, connecting, onSwitchCluster, pins, onTogglePin }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => (document.removeEventListener("mousedown", close), document.removeEventListener("keydown", esc));
  }, [open]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? contexts.filter((c) => c.name.toLowerCase().includes(q)) : contexts;
  }, [contexts, query]);

  return (
    <div className="crumb-wrap" ref={root}>
      <button className="crumb" onClick={() => setOpen(!open)} disabled={connecting}>
        {current && <span className="cluster-dot" style={{ background: clusterColor(current) }} />}
        <span className={current ? "" : "faint"}>{connecting ? t("app.topbar.connecting") : current ? shortContextName(current) : t("app.topbar.selectCluster")}</span>
        <IconChevronDown size={13} className="faint" />
      </button>
      {open && (
        <div className="menu menu-wide">
          <input autoFocus placeholder={t("app.topbar.findContext")} value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="menu-list">
            {visible.map((c) => (
              <div key={c.name} className={`menu-row ${c.name === current ? "active" : ""}`}>
                <button
                  className="menu-row-main"
                  title={`${c.name}\n${t("app.topbar.newWindowHint")}`}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey) void openWindow(c.name);
                    else onSwitchCluster(c.name);
                    setOpen(false);
                  }}
                >
                  <span className="cluster-dot" style={{ background: clusterColor(c.name) }} />
                  <span className="menu-row-text">
                    <span>{shortContextName(c.name)}</span>
                    {shortContextName(c.name) !== c.name && <span className="faint">{c.name}</span>}
                  </span>
                  {isProduction(c.name) && <span className="prod-badge small">{t("app.topbar.prod")}</span>}
                </button>
                <button className="icon-button" aria-label={pins.includes(c.name) ? t("app.topbar.unpin") : t("app.topbar.pin")} title={pins.includes(c.name) ? t("app.topbar.unpin") : t("app.topbar.pin")} onClick={() => onTogglePin(c.name)}>
                  {pins.includes(c.name) ? <IconPinnedFilled size={14} /> : <IconPin size={14} />}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
