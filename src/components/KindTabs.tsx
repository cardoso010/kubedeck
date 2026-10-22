import { useEffect, useMemo, useRef, useState } from "react";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import type { KindInfo } from "../api";
import { SECTIONS, type SectionId } from "../sections";

interface Props {
  section: SectionId;
  kinds: KindInfo[];
  active: string;
  /** Custom resources opened recently in this window, shown as tabs. */
  recentCustom: string[];
  onSelect: (key: string) => void;
}

/** Tabs for the kinds of the current section; custom resources add a CRD browser. */
export default function KindTabs({ section, kinds, active, recentCustom, onSelect }: Props) {
  const def = SECTIONS.find((s) => s.id === section);
  if (!def || (!def.kinds && section !== "custom")) return null;

  const tabs = section === "custom" ? recentCustom.map((key) => kinds.find((k) => k.key === key)).filter((k): k is KindInfo => !!k) : (def.kinds ?? []).map((key) => kinds.find((k) => k.key === key)).filter((k): k is KindInfo => !!k);

  return (
    <nav className="kind-tabs">
      {tabs.map((k) => (
        <button key={k.key} className={`kind-tab ${k.key === active ? "active" : ""}`} onClick={() => onSelect(k.key)} title={k.group ? k.key : undefined}>
          {k.label}
        </button>
      ))}
      {section === "custom" && <CrdBrowser kinds={kinds.filter((k) => k.group)} active={active} onSelect={onSelect} />}
    </nav>
  );
}

function CrdBrowser({ kinds, active, onSelect }: { kinds: KindInfo[]; active: string; onSelect: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => (document.removeEventListener("mousedown", close), document.removeEventListener("keydown", esc));
  }, [open]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byGroup = new Map<string, KindInfo[]>();
    for (const k of kinds) {
      if (q && !k.label.toLowerCase().includes(q) && !k.group!.toLowerCase().includes(q)) continue;
      byGroup.set(k.group!, [...(byGroup.get(k.group!) ?? []), k]);
    }
    return [...byGroup.entries()];
  }, [kinds, query]);

  const toggle = (g: string) => setExpanded((prev) => (prev.has(g) ? new Set([...prev].filter((x) => x !== g)) : new Set([...prev, g])));

  return (
    <div className="crumb-wrap" ref={root}>
      <button className={`kind-tab browse ${open ? "active" : ""}`} onClick={() => setOpen(!open)}>
        Browse {kinds.length} CRDs <IconChevronDown size={13} />
      </button>
      {open && (
        <div className="menu menu-wide">
          <input autoFocus placeholder="Find a custom resource…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="menu-list">
            {groups.map(([group, list]) => {
              const isOpen = query.trim() !== "" || expanded.has(group) || list.some((k) => k.key === active);
              return (
                <div key={group}>
                  <button className="menu-group" onClick={() => toggle(group)}>
                    {isOpen ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
                    {group}
                    <span className="faint">{list.length}</span>
                  </button>
                  {isOpen &&
                    list.map((k) => (
                      <button key={k.key} className={`menu-item indent ${k.key === active ? "active" : ""}`} onClick={() => (onSelect(k.key), setOpen(false))}>
                        {k.label}
                      </button>
                    ))}
                </div>
              );
            })}
            {groups.length === 0 && <div className="faint menu-empty">{kinds.length ? "No match" : "This cluster has no custom resources."}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
