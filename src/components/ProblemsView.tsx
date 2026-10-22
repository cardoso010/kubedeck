import { useMemo, useState } from "react";
import { IconAlertTriangle, IconCircleCheck, IconFlame } from "@tabler/icons-react";
import { age, type KindInfo, type Problem } from "../api";

interface Props {
  problems: Problem[] | null;
  error: string | null;
  kinds: KindInfo[];
  onOpen: (p: Problem) => void;
}

/** Everything that looks wrong in the selected namespaces, worst first. */
export default function ProblemsView({ problems, error, kinds, onOpen }: Props) {
  const [query, setQuery] = useState("");
  const now = Date.now();
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (problems ?? []).filter((p) => !q || `${p.namespace} ${p.name} ${p.reason} ${p.message}`.toLowerCase().includes(q));
  }, [problems, query]);
  const label = (key: string) => kinds.find((k) => k.key === key)?.label.replace(/s$/, "") ?? key;
  const critical = shown.filter((p) => p.severity === "critical");
  const warnings = shown.filter((p) => p.severity === "warning");

  return (
    <section className="table problems">
      <header className="table-toolbar">
        <h2>Problems</h2>
        <span className="count">{problems ? problems.length : "loading…"}</span>
        <div className="table-actions">
          <input placeholder="Filter…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </header>
      {error && <div className="error-bar">{error}</div>}
      <div className="problems-body">
        {problems && problems.length === 0 && (
          <div className="problems-clear">
            <IconCircleCheck size={28} stroke={1.5} />
            <div>Nothing looks wrong in the selected namespaces.</div>
            <div className="faint">Checked: crash loops, OOM kills, image pulls, pending and unready pods, workloads, jobs, volume claims and nodes.</div>
          </div>
        )}
        {[
          ["Critical", critical, <IconFlame key="c" size={14} />] as const,
          ["Warnings", warnings, <IconAlertTriangle key="w" size={14} />] as const,
        ].map(
          ([title, list, icon]) =>
            list.length > 0 && (
              <div key={title} className="problem-group">
                <div className={`problem-group-title ${title === "Critical" ? "bad" : "warn"}`}>
                  {icon} {title} <span className="faint">{list.length}</span>
                </div>
                {list.map((p, i) => (
                  <button key={`${p.kindKey}/${p.namespace}/${p.name}/${p.reason}/${i}`} className={`problem ${p.severity}`} onClick={() => onOpen(p)}>
                    <span className={`status-dot ${p.severity === "critical" ? "bad" : "warn"}`} />
                    <span className="kind-chip">{label(p.kindKey)}</span>
                    <span className="problem-name">
                      {p.namespace && <span className="faint">{p.namespace}/</span>}
                      {p.name}
                    </span>
                    <span className={`problem-reason ${p.severity === "critical" ? "bad" : "warn"}`}>{p.reason}</span>
                    <span className="problem-message" title={p.message}>
                      {p.message}
                    </span>
                    <span className="faint problem-since">{p.since ? age(p.since, now) : ""}</span>
                  </button>
                ))}
              </div>
            ),
        )}
      </div>
    </section>
  );
}
