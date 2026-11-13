import { useEffect, useMemo, useRef, useState } from "react";
import { IconChevronDown } from "@tabler/icons-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

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

export function namespaceSummary(selected: string[], t: TFunction) {
  if (selected.length === 0) return t("app.namespaces.all");
  if (selected.length <= 2) return selected.join(", ");
  return t("app.namespaces.count", { count: selected.length });
}

/**
 * Multi-select for namespaces. Clicking a name selects only it; the checkbox adds or
 * removes it from the selection.
 */
export default function NamespacePicker({ namespaces, selected, disabled, onChange, variant = "field", clusterScoped = false }: Props) {
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
        <span>{clusterScoped ? t("app.namespaces.clusterWide") : namespaceSummary(selected, t)}</span>
        <IconChevronDown size={13} className="faint" />
      </button>
      {open && (
        <div className="menu ns-picker-menu">
          <input autoFocus placeholder={t("app.namespaces.find")} value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className={`ns-option ${selected.length === 0 ? "active" : ""}`} onClick={() => (onChange([]), setOpen(false))}>
            {t("app.namespaces.all")}
          </button>
          <div className="ns-options">
            {visible.map((ns) => (
              <div key={ns} className={`ns-option ${selected.includes(ns) ? "active" : ""}`}>
                <input type="checkbox" checked={selected.includes(ns)} onChange={() => toggle(ns)} aria-label={t("app.namespaces.include", { name: ns })} />
                <button onClick={() => (onChange([ns]), setOpen(false))} title={t("app.namespaces.only", { name: ns })}>
                  {ns}
                </button>
              </div>
            ))}
            {visible.length === 0 && <div className="muted ns-empty">{t("app.namespaces.noMatch")}</div>}
          </div>
          {selected.length > 0 && (
            <div className="ns-footer muted">
              {t("app.namespaces.selected", { count: selected.length })} ·{" "}
              <button className="link" onClick={() => onChange([])}>
                {t("app.namespaces.clear")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
