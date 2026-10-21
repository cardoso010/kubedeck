import { useEffect, useMemo, useRef, useState } from "react";
import { errorText, streamLogs } from "../api";
import { useStream } from "../useStream";

const MAX_LINES = 5000;

export default function LogsView({ namespace, pod, container }: { namespace: string; pod: string; container: string | null }) {
  const [lines, setLines] = useState<string[]>([]);
  const [ended, setEnded] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  useStream(
    () => {
      setLines([]);
      setEnded(null);
      let queue: string[] = [];
      return streamLogs(namespace, pod, container, (msg) => {
        if (msg.type === "end") return setEnded(msg.message ?? "Log stream ended.");
        if (queue.push(msg.data) > 1) return;
        requestAnimationFrame(() => {
          const batch = queue;
          queue = [];
          setLines((prev) => {
            const next = prev.concat(batch);
            return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
          });
        });
      });
    },
    (e) => setEnded(errorText(e)),
    [namespace, pod, container],
  );

  const shown = useMemo(() => {
    const q = filter.toLowerCase();
    return q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines;
  }, [lines, filter]);

  useEffect(() => {
    if (follow) bottom.current?.scrollIntoView({ block: "end" });
  }, [shown, follow]);

  return (
    <div className="logs">
      <div className="yaml-toolbar">
        <label className="checkbox">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
        </label>
        <input placeholder="Filter lines…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="muted">{shown.length} lines</span>
      </div>
      <pre className="logs-body">
        {shown.join("\n")}
        {ended && <div className="muted">— {ended}</div>}
        <div ref={bottom} />
      </pre>
    </div>
  );
}
