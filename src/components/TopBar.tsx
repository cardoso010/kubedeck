import { useEffect, useMemo, useRef, useState } from "react";
import { IconChevronDown, IconLock, IconLockOpen, IconPin, IconPinnedFilled, IconSearch } from "@tabler/icons-react";
import { isProduction, openWindow, shortContextName, type ContextInfo } from "../api";
import { clusterColor } from "../pins";
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
}

/** Breadcrumb bar: cluster › namespaces › view, plus the command palette trigger. */
export default function TopBar(p: Props) {
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
            <button className="lock-chip locked" onClick={p.onToggleLock} title="Changes to this cluster are refused. Click to unlock.">
              <IconLock size={12} /> read-only
            </button>
          ) : p.lock.minutesLeft !== null ? (
            <button className="lock-chip unlocked" onClick={p.onToggleLock} title="Click to lock again now">
              <IconLockOpen size={12} /> unlocked · {p.lock.minutesLeft}m
            </button>
          ) : (
            <button className="lock-chip open" onClick={p.onToggleLock} title="Lock: refuse every change to this cluster from this window">
              <IconLockOpen size={12} />
            </button>
          ))}
        {prod && <span className="prod-badge">production</span>}
        {p.serverVersion && <span className="faint mono">{p.serverVersion}</span>}
        <button className="search-trigger" onClick={p.onOpenPalette}>
          <IconSearch size={14} stroke={1.8} />
          <span>Search or jump to…</span>
          <kbd>⌘K</kbd>
        </button>
      </div>
    </header>
  );
}

function ClusterCrumb({ contexts, current, connecting, onSwitchCluster, pins, onTogglePin }: Props) {
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
        <span className={current ? "" : "faint"}>{connecting ? "connecting…" : current ? shortContextName(current) : "Select a cluster"}</span>
        <IconChevronDown size={13} className="faint" />
      </button>
      {open && (
        <div className="menu menu-wide">
          <input autoFocus placeholder="Find a context…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="menu-list">
            {visible.map((c) => (
              <div key={c.name} className={`menu-row ${c.name === current ? "active" : ""}`}>
                <button
                  className="menu-row-main"
                  title={`${c.name}\n⌘-click: open in a new window`}
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
                  {isProduction(c.name) && <span className="prod-badge small">prod</span>}
                </button>
                <button className="icon-button" aria-label={pins.includes(c.name) ? "Unpin" : "Pin to the rail"} title={pins.includes(c.name) ? "Unpin" : "Pin to the rail"} onClick={() => onTogglePin(c.name)}>
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
