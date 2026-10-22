import { useEffect, useRef, useState } from "react";
import { IconChevronDown, IconChevronUp, IconFileText, IconTerminal2, IconX } from "@tabler/icons-react";
import type { DockTab } from "../dock";
import LogsView from "./LogsView";
import TerminalView from "./TerminalView";

interface Props {
  tabs: DockTab[];
  active: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}

const HEIGHT_KEY = "kubedeck.dockHeight";
const savedHeight = () => {
  try {
    return Number(localStorage.getItem(HEIGHT_KEY)) || 300;
  } catch {
    return 300;
  }
};

/**
 * Terminals and logs docked under the main view. Every tab stays mounted, so switching tabs
 * keeps shells and streams running; drag the top edge to resize.
 */
export default function Dock({ tabs, active, onActivate, onClose }: Props) {
  const [height, setHeight] = useState(savedHeight);
  const [collapsed, setCollapsed] = useState(false);
  const drag = useRef<{ y: number; h: number } | null>(null);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!drag.current) return;
      setHeight(Math.min(Math.max(140, drag.current.h + drag.current.y - e.clientY), window.innerHeight - 160));
    };
    const up = () => {
      if (!drag.current) return;
      drag.current = null;
      document.body.classList.remove("resizing");
      setHeight((h) => {
        try {
          localStorage.setItem(HEIGHT_KEY, String(h));
        } catch {
          // Not remembered.
        }
        return h;
      });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => (window.removeEventListener("mousemove", move), window.removeEventListener("mouseup", up));
  }, []);

  if (tabs.length === 0) return null;

  return (
    <section className={`dock ${collapsed ? "collapsed" : ""}`} style={collapsed ? undefined : { height }}>
      {!collapsed && (
        <div
          className="dock-grip"
          onMouseDown={(e) => {
            drag.current = { y: e.clientY, h: height };
            document.body.classList.add("resizing");
          }}
        />
      )}
      <nav className="dock-tabs">
        {tabs.map((t) => (
          <div key={t.id} className={`dock-tab ${t.id === active ? "active" : ""}`} onClick={() => (onActivate(t.id), setCollapsed(false))} title={t.title}>
            {t.kind === "terminal" ? <IconTerminal2 size={13} /> : <IconFileText size={13} />}
            <span>{t.title}</span>
            <button className="icon-button" aria-label="Close tab" onClick={(e) => (e.stopPropagation(), onClose(t.id))}>
              <IconX size={12} />
            </button>
          </div>
        ))}
        <span className="spacer" />
        <button className="icon-button" aria-label={collapsed ? "Expand the dock" : "Collapse the dock"} onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
        </button>
      </nav>
      <div className="dock-body" hidden={collapsed}>
        {tabs.map((t) => (
          <div key={t.id} className="dock-pane" hidden={t.id !== active}>
            {t.kind === "terminal" ? <TerminalView namespace={t.namespace} pod={t.pod} container={t.container} /> : <LogsView source={t.source} />}
          </div>
        ))}
      </div>
    </section>
  );
}
