import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { age, type KindInfo, type Row } from "../api";

interface Props {
  kind: KindInfo;
  rows: Row[];
  loading: boolean;
  error: string | null;
  /** Shown before the error; defaults to the watch wording. */
  errorPrefix?: string;
  ageLabel?: string;
  showNamespace: boolean;
  selectedUid: string | null;
  onSelect: (row: Row) => void;
  /** Extra columns computed outside the row (e.g. live metrics), shown before the age. */
  extra?: { columns: string[]; cells: (row: Row) => string[] } | null;
  /** Buttons shown in the table header, next to the filter. */
  actions?: ReactNode;
}

const ROW_HEIGHT = 30;

export default function ResourceTable({ kind, rows, loading, error, errorPrefix = "Watch error (retrying)", ageLabel = "Age", showNamespace, selectedUid, onSelect, extra, actions }: Props) {
  const [filter, setFilter] = useState("");
  const [now, setNow] = useState(Date.now());
  const scrollRef = useRef<HTMLDivElement>(null);

  // Ages tick on their own; nothing else re-renders the table when the cluster is quiet.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(q) || r.namespace?.toLowerCase().includes(q) || r.cells.some((c) => c.toLowerCase().includes(q)));
  }, [rows, filter]);

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  const columns = [...(showNamespace ? ["Namespace"] : []), ...kind.columns, ...(extra?.columns ?? []), ageLabel];
  const template = `minmax(220px, 2fr) ${columns.map((c) => (c === "Message" ? "minmax(200px, 3fr)" : "minmax(80px, 1fr)")).join(" ")}`;

  return (
    <section className="table">
      <header className="table-toolbar">
        <h2>{kind.label}</h2>
        <span className="count">{loading ? "loading…" : `${visible.length}${visible.length !== rows.length ? ` of ${rows.length}` : ""}`}</span>
        <div className="table-actions">
          {actions}
          <input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      </header>
      {error && (
        <div className="error-bar">
          {errorPrefix}: {error}
        </div>
      )}
      <div className="table-head" style={{ gridTemplateColumns: template }}>
        <div>Name</div>
        {columns.map((c) => (
          <div key={c}>{c}</div>
        ))}
      </div>
      <div className="table-body" ref={scrollRef}>
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const r = visible[item.index];
            return (
              <div
                key={r.uid}
                className={`table-row ${r.uid === selectedUid ? "selected" : ""}`}
                style={{ gridTemplateColumns: template, transform: `translateY(${item.start}px)`, height: ROW_HEIGHT }}
                onClick={() => onSelect(r)}
              >
                <div title={r.name}>{r.name}</div>
                {showNamespace && <div>{r.namespace}</div>}
                {r.cells.map((c, i) => (
                  <div key={i} title={c} className={statusClass(kind.columns[i], c)}>
                    {c}
                  </div>
                ))}
                {extra?.cells(r).map((c, i) => (
                  <div key={`x${i}`} className="metric">
                    {c}
                  </div>
                ))}
                <div>{age(r.created, now)}</div>
              </div>
            );
          })}
        </div>
        {!loading && visible.length === 0 && <div className="empty">No {kind.label.toLowerCase()} found.</div>}
      </div>
    </section>
  );
}

function statusClass(column: string | undefined, value: string) {
  if (column !== "Status" && column !== "Type") return "";
  if (/^(Running|Ready|Active|Complete|Succeeded|Normal|deployed)$/.test(value)) return "ok";
  if (/^(Pending|ContainerCreating|PodInitializing|Terminating)$|^(pending-|uninstalling)/.test(value)) return "warn";
  if (/(Err|Fail|fail|BackOff|NotReady|Warning|OOM|Evicted|Unknown)/.test(value)) return "bad";
  return "";
}
