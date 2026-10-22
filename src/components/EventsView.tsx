import { useEffect, useState } from "react";
import { age, errorText, objectEvents, type EventRow } from "../api";

const REFRESH_MS = 10_000;

/** Events about one object (why it is pending, failing, being rescheduled), newest first. */
export default function EventsView({ namespace, uid }: { namespace: string | null; uid: string }) {
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let stopped = false;
    const load = () =>
      objectEvents(namespace, uid).then(
        (e) => !stopped && (setEvents(e), setError(null), setNow(Date.now())),
        (e) => !stopped && setError(errorText(e)),
      );
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => ((stopped = true), clearInterval(timer));
  }, [namespace, uid]);

  if (error) return <div className="error-bar">{error}</div>;
  if (!events) return <div className="empty">Loading…</div>;
  if (events.length === 0) return <div className="empty">No recent events. Kubernetes keeps events for about an hour.</div>;

  return (
    <div className="events">
      {events.map((e, i) => (
        <div key={i} className={`event ${e.type === "Warning" ? "warning" : ""}`}>
          <div className="event-head">
            <span className={`event-type ${e.type === "Warning" ? "bad" : "faint"}`}>{e.type}</span>
            <strong>{e.reason}</strong>
            {e.count > 1 && <span className="faint">×{e.count}</span>}
            <span className="faint event-meta">
              {e.source} · {age(e.lastSeen, now)} ago
            </span>
          </div>
          <div className="event-message">{e.message}</div>
        </div>
      ))}
    </div>
  );
}
