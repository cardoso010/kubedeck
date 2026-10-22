import { useEffect, useState } from "react";
import { isProduction, openWindow, shortContextName } from "../api";

const KEY = "kubedeck.hotbar";

function load(): string[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
}

function save(list: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Storage unavailable: the hotbar just is not remembered.
  }
}

/** Stable color per context, so a cluster looks the same in every window. */
function colorFor(context: string) {
  let h = 0;
  for (const c of context) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 45% 38%)`;
}

const initials = (context: string) =>
  shortContextName(context)
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("") || "?";

interface Props {
  current: string | null;
  available: string[];
  onSwitch: (context: string) => void;
}

/**
 * Pinned clusters. Click switches this window; ⌘/Ctrl-click or the menu opens the cluster in
 * a new window. ⌘/Ctrl+1…9 switch to the n-th cluster, ⌘/Ctrl+N opens an empty window.
 */
export default function Hotbar({ current, available, onSwitch }: Props) {
  const [pinned, setPinned] = useState<string[]>(load);
  const [menu, setMenu] = useState<{ context: string; x: number; y: number } | null>(null);

  // Other windows share the same storage; follow their changes.
  useEffect(() => {
    const sync = (e: StorageEvent) => e.key === KEY && setPinned(load());
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  const update = (list: string[]) => (setPinned(list), save(list));
  const shown = pinned.filter((c) => available.length === 0 || available.includes(c));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key === "n") {
        e.preventDefault();
        void openWindow(null);
      } else if (/^[1-9]$/.test(e.key) && shown[Number(e.key) - 1]) {
        e.preventDefault();
        onSwitch(shown[Number(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, onSwitch]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  return (
    <nav className="hotbar" aria-label="Pinned clusters">
      {shown.map((context, i) => (
        <button
          key={context}
          className={`hotbar-item ${context === current ? "active" : ""} ${isProduction(context) ? "prod" : ""}`}
          style={{ background: colorFor(context) }}
          title={`${context}${i < 9 ? `  (⌘${i + 1})` : ""}\n⌘-click: open in a new window`}
          onClick={(e) => (e.metaKey || e.ctrlKey ? void openWindow(context) : onSwitch(context))}
          onContextMenu={(e) => (e.preventDefault(), setMenu({ context, x: e.clientX, y: e.clientY }))}
        >
          {initials(context)}
        </button>
      ))}
      {current && !pinned.includes(current) && (
        <button className="hotbar-add" title={`Pin ${current}`} onClick={() => update([...pinned, current])}>
          +
        </button>
      )}
      <div className="hotbar-spacer" />
      <button className="hotbar-add" title="New window (⌘N)" onClick={() => void openWindow(null)}>
        ⧉
      </button>
      {menu && (
        <div className="hotbar-menu" style={{ left: menu.x, top: menu.y }}>
          <div className="muted hotbar-menu-title">{shortContextName(menu.context)}</div>
          <button onClick={() => void openWindow(menu.context)}>Open in new window</button>
          <button
            disabled={pinned.indexOf(menu.context) === 0}
            onClick={() => {
              const i = pinned.indexOf(menu.context);
              update([...pinned.slice(0, i - 1), menu.context, pinned[i - 1], ...pinned.slice(i + 1)]);
            }}
          >
            Move up
          </button>
          <button onClick={() => update(pinned.filter((c) => c !== menu.context))}>Remove from hotbar</button>
        </div>
      )}
    </nav>
  );
}
