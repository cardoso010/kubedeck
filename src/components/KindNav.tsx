import { useMemo, useState } from "react";
import type { KindInfo } from "../api";

interface Props {
  kinds: KindInfo[];
  active: string;
  disabled: boolean;
  onSelect: (key: string) => void;
  /** Extra entries rendered after the built-in kinds (Helm, port forwards). */
  extras: { key: string; label: string }[];
}

/** Built-in kinds, then the cluster's custom resources grouped by API group. */
export default function KindNav({ kinds, active, disabled, onSelect, extras }: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());

  const builtins = kinds.filter((k) => !k.group);
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byGroup = new Map<string, KindInfo[]>();
    for (const k of kinds) {
      if (!k.group) continue;
      if (q && !k.label.toLowerCase().includes(q) && !k.group.toLowerCase().includes(q)) continue;
      byGroup.set(k.group, [...(byGroup.get(k.group) ?? []), k]);
    }
    return [...byGroup.entries()];
  }, [kinds, query]);
  const customCount = kinds.length - builtins.length;
  const activeGroup = kinds.find((k) => k.key === active)?.group;

  const toggle = (group: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });

  const item = (key: string, label: string, title?: string) => (
    <button key={key} title={title} className={key === active ? "active" : ""} disabled={disabled} onClick={() => onSelect(key)}>
      {label}
    </button>
  );

  return (
    <nav className="kinds">
      {builtins.map((k) => item(k.key, k.label))}
      <div className="nav-separator" />
      {extras.map((e) => item(e.key, e.label))}
      {customCount > 0 && (
        <>
          <div className="nav-heading">
            Custom Resources <span className="muted">{customCount}</span>
          </div>
          <input className="nav-filter" placeholder="Find a CRD…" value={query} onChange={(e) => setQuery(e.target.value)} />
          {groups.map(([group, list]) => {
            // Searching, or the active kind lives here: show the group expanded.
            const expanded = query.trim() !== "" || open.has(group) || group === activeGroup;
            return (
              <div key={group} className="nav-group">
                <button className="nav-group-title" onClick={() => toggle(group)} title={group}>
                  <span className="chevron">{expanded ? "▾" : "▸"}</span>
                  {group}
                </button>
                {expanded && list.map((k) => item(k.key, k.label, `${k.key}`))}
              </div>
            );
          })}
          {groups.length === 0 && <div className="muted nav-empty">No match</div>}
        </>
      )}
    </nav>
  );
}
