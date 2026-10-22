import { useEffect, useMemo, useRef, useState } from "react";
import { IconChevronDown } from "@tabler/icons-react";

interface Props {
  namespaces: string[];
  /** Empty means every namespace. */
  selected: string[];
  disabled: boolean;
  onChange: (selected: string[]) => void;
  /** "crumb" renders as a breadcrumb segment in the top bar. */
  variant?: "field" | "crumb";
  /** The current view is cluster-scoped, so namespaces do not apply. */
  clusterScoped?: boolean;
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
export default function NamespacePicker({ namespaces, selected, disabled, onChange, variant = "field", clusterScoped = false }: Props) {
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
    <div className={variant === "crumb" ? "crumb-wrap" : "ns-picker"} ref={root}>
      <button className={variant === "crumb" ? "crumb" : "ns-picker-button"} disabled={disabled} onClick={() => setOpen(!open)} title={selected.join(", ") || undefined}>
        <span>{clusterScoped ? "cluster-wide" : namespaceSummary(selected)}</span>
        <IconChevronDown size={13} className="faint" />
      </button>
      {open && (
        <div className="menu ns-picker-menu">
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
