import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IconBraces, IconCopy, IconDownload, IconHistory } from "@tabler/icons-react";
import { errorText, saveTextFile, streamLogs, streamWorkloadLogs } from "../api";
import { useStream } from "../useStream";
import { clusterColor } from "../pins";

export type LogSource =
  | { kind: "pod"; namespace: string; pod: string; container: string | null; restarts: number }
  | { kind: "workload"; kindKey: string; namespace: string; name: string };

interface Line {
  text: string;
  source?: string;
}

const MAX_LINES = 5000;

/**
 * Streams logs of one container, or of every pod of a workload (each line tagged with its
 * pod). Can show the previous run, pretty-print JSON lines, highlight or filter a search,
 * and copy or save what is on screen.
 */
export default function LogsView({ source }: { source: LogSource }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [ended, setEnded] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [previous, setPrevious] = useState(false);
  const [json, setJson] = useState(false);
  const [query, setQuery] = useState("");
  const [onlyMatches, setOnlyMatches] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const key = source.kind === "pod" ? `${source.namespace}/${source.pod}/${source.container}/${previous}` : `${source.kindKey}/${source.namespace}/${source.name}`;

  useStream(
    () => {
      setLines([]);
      setEnded(null);
      let queue: Line[] = [];
      const onMessage = (msg: { type: "data"; data: string; source?: string } | { type: "end"; message: string | null }) => {
        if (msg.type === "end") return setEnded(msg.message ?? (previous ? "End of the previous run's logs." : "Log stream ended."));
        if (queue.push({ text: msg.data, source: msg.source }) > 1) return;
        requestAnimationFrame(() => {
          const batch = queue;
          queue = [];
          setLines((prev) => {
            const next = prev.concat(batch);
            return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
          });
        });
      };
      return source.kind === "pod"
        ? streamLogs(source.namespace, source.pod, source.container, onMessage, previous)
        : streamWorkloadLogs(source.kindKey, source.namespace, source.name, onMessage);
    },
    (e) => setEnded(errorText(e)),
    [key],
  );

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => (q && onlyMatches ? lines.filter((l) => l.text.toLowerCase().includes(q) || l.source?.toLowerCase().includes(q)) : lines), [lines, q, onlyMatches]);

  useEffect(() => {
    if (follow) bottom.current?.scrollIntoView({ block: "end" });
  }, [shown, follow]);

  const asText = () => shown.map((l) => (l.source ? `[${l.source}] ${l.text}` : l.text)).join("\n");
  const flash = (text: string) => (setNotice(text), setTimeout(() => setNotice(null), 2000));
  const name = source.kind === "pod" ? `${source.pod}${source.container ? `-${source.container}` : ""}${previous ? "-previous" : ""}` : source.name;

  return (
    <div className="logs">
      <div className="yaml-toolbar logs-toolbar">
        <label className="checkbox">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
        </label>
        {source.kind === "pod" && (
          <button
            className={`toggle ${previous ? "active" : ""}`}
            disabled={source.restarts === 0 && !previous}
            title={source.restarts === 0 ? "This container has not restarted" : "Logs of the run before the last restart"}
            onClick={() => setPrevious(!previous)}
          >
            <IconHistory size={14} /> Previous run
          </button>
        )}
        <button className={`toggle ${json ? "active" : ""}`} title="Pretty-print JSON lines" onClick={() => setJson(!json)}>
          <IconBraces size={14} /> JSON
        </button>
        <input placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} />
        {q && (
          <label className="checkbox">
            <input type="checkbox" checked={onlyMatches} onChange={(e) => setOnlyMatches(e.target.checked)} /> Only matches
          </label>
        )}
        <span className="faint">{shown.length} lines</span>
        <span className="logs-actions">
          {notice && <span className="ok">{notice}</span>}
          <button className="icon-button" title="Copy" aria-label="Copy logs" onClick={() => void navigator.clipboard.writeText(asText()).then(() => flash("Copied"))}>
            <IconCopy size={15} />
          </button>
          <button
            className="icon-button"
            title="Save to a file"
            aria-label="Save logs"
            onClick={() => void saveTextFile(`${name}.log`, asText()).then((saved) => saved && flash("Saved"), (e) => flash(errorText(e)))}
          >
            <IconDownload size={15} />
          </button>
        </span>
      </div>
      <div className="logs-body">
        {shown.map((l, i) => (
          <div key={i} className={`log-line ${json ? levelClass(l.text) : ""}`}>
            {l.source && (
              <span className="log-source" style={{ color: clusterColor(l.source).replace("36%)", "62%)") }}>
                {shortPod(l.source)}
              </span>
            )}
            <span className="log-text">{highlight(json ? pretty(l.text) : l.text, q)}</span>
          </div>
        ))}
        {ended && <div className="faint log-end">— {ended}</div>}
        <div ref={bottom} />
      </div>
    </div>
  );
}

/** "web-7c6cdd646-2zjfg" → "…2zjfg": the distinguishing end of a replica's name. */
const shortPod = (pod: string) => {
  const parts = pod.split("-");
  return parts.length > 2 ? `…${parts[parts.length - 1]}` : pod;
};

/** JSON lines as `LEVEL message {rest}`; anything else unchanged. */
function pretty(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return text;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const pick = (...keys: string[]) => {
      for (const k of keys) {
        if (k in obj) {
          const v = obj[k];
          delete obj[k];
          return String(v);
        }
      }
      return "";
    };
    const time = pick("time", "ts", "timestamp", "@timestamp");
    const level = pick("level", "severity", "lvl");
    const message = pick("msg", "message");
    const rest = Object.keys(obj).length ? JSON.stringify(obj, null, 2) : "";
    return [time, level.toUpperCase(), message].filter(Boolean).join("  ") + (rest ? `\n${rest}` : "");
  } catch {
    return text;
  }
}

function levelClass(text: string): string {
  const m = /"(level|severity|lvl)"\s*:\s*"?(\w+)/i.exec(text);
  const level = m?.[2].toLowerCase() ?? "";
  if (/^(error|err|fatal|panic|critical)$/.test(level)) return "level-error";
  if (/^(warn|warning)$/.test(level)) return "level-warn";
  return "";
}

function highlight(text: string, q: string): ReactNode {
  if (!q) return text;
  const lower = text.toLowerCase();
  const out: ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, at + q.length)) {
    out.push(text.slice(from, at), <mark key={at}>{text.slice(at, at + q.length)}</mark>);
    from = at + q.length;
  }
  out.push(text.slice(from));
  return out;
}
