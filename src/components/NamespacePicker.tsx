import { useEffect, useMemo, useRef, useState } from "react";

interface Props {
  namespaces: string[];
  /** Empty means every namespace. */
  selected: string[];
  disabled: boolean;
  onChange: (selected: string[]) => void;
}

export function namespaceSummary(selected: string[]) {
  if (selected.length === 0) return "All namespaces";
  if (selected.length <= 2) return selected.join(", ");
  return `${selected.length} namespaces`;
}

/**
 * Multi-select for namespaces. Clicking a name selects only it; the checkbox adds or
 * removes it from the selection.
 */
export default function NamespacePicker({ namespaces, selected, disabled, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? namespaces.filter((n) => n.toLowerCase().includes(q)) : namespaces;
  }, [namespaces, query]);

  const toggle = (ns: string) => onChange(selected.includes(ns) ? selected.filter((n) => n !== ns) : [...selected, ns].sort());

  return (
    <div className="ns-picker" ref={root}>
      <button className="ns-picker-button" disabled={disabled} onClick={() => setOpen(!open)} title={selected.join(", ") || undefined}>
        <span>{namespaceSummary(selected)}</span>
        <span className="chevron">▾</span>
      </button>
      {open && (
        <div className="ns-picker-menu">
          <input autoFocus placeholder="Find a namespace…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className={`ns-option ${selected.length === 0 ? "active" : ""}`} onClick={() => (onChange([]), setOpen(false))}>
            All namespaces
          </button>
          <div className="ns-options">
            {visible.map((ns) => (
              <div key={ns} className={`ns-option ${selected.includes(ns) ? "active" : ""}`}>
                <input type="checkbox" checked={selected.includes(ns)} onChange={() => toggle(ns)} aria-label={`Include ${ns}`} />
                <button onClick={() => (onChange([ns]), setOpen(false))} title={`Show only ${ns}`}>
                  {ns}
                </button>
              </div>
            ))}
            {visible.length === 0 && <div className="muted ns-empty">No match</div>}
          </div>
          {selected.length > 0 && (
            <div className="ns-footer muted">
              {selected.length} selected ·{" "}
              <button className="link" onClick={() => onChange([])}>
                clear
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
