import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export interface Command {
  id: string;
  title: string;
  subtitle?: string;
  group: string;
  icon?: ReactNode;
  /** Shortcut hint shown on the right. */
  hint?: string;
  run: () => void;
}

/**
 * Fuzzy subsequence score: every query character must appear in order. Matches at the start
 * and right after separators, and consecutive runs, score higher. null = no match.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    const boundary = found === 0 || /[\s\-_./:]/.test(t[found - 1]);
    run = found === ti ? run + 1 : 0;
    score += 1 + (boundary ? 4 : 0) + run * 2 - Math.min(found - ti, 5) * 0.2;
    ti = found + 1;
  }
  return score - t.length * 0.01;
}

const MAX_RESULTS = 60;

export default function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    if (!query.trim()) return commands.slice(0, MAX_RESULTS);
    return commands
      .map((c) => ({ c, s: Math.max(fuzzyScore(query, c.title) ?? -Infinity, (fuzzyScore(query, `${c.group} ${c.title} ${c.subtitle ?? ""}`) ?? -Infinity) - 3) }))
      .filter((r) => r.s > -Infinity)
      .sort((a, b) => b.s - a.s)
      .slice(0, MAX_RESULTS)
      .map((r) => r.c);
  }, [commands, query]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") (e.preventDefault(), setIndex((i) => Math.min(i + 1, results.length - 1)));
    else if (e.key === "ArrowUp") (e.preventDefault(), setIndex((i) => Math.max(i - 1, 0)));
    else if (e.key === "Enter") (e.preventDefault(), run(results[index]));
    else if (e.key === "Escape") (e.preventDefault(), onClose());
  };

  let lastGroup = "";
  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <input autoFocus className="palette-input" placeholder="Jump to a resource kind, cluster, namespace, or action…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="palette-list" ref={list}>
          {results.map((c, i) => {
            const header = !query.trim() && c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {header && <div className="palette-group">{header}</div>}
                <button data-index={i} className={`palette-item ${i === index ? "active" : ""}`} onMouseMove={() => setIndex(i)} onClick={() => run(c)}>
                  <span className="palette-icon">{c.icon}</span>
                  <span className="palette-title">{c.title}</span>
                  {c.subtitle && <span className="palette-subtitle">{c.subtitle}</span>}
                  <span className="palette-meta">{query.trim() ? c.group : c.hint}</span>
                </button>
              </div>
            );
          })}
          {results.length === 0 && <div className="palette-empty">Nothing matches “{query}”.</div>}
        </div>
        <div className="palette-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
