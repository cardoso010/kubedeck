import { useEffect, useState } from "react";
import { formatCpu, formatMemory, METRICS_UNAVAILABLE, nodeMetrics, podMetrics, type Row, type Usage } from "./api";

const POLL_MS = 15_000;
export const METRIC_COLUMNS = ["CPU", "Memory"];

const pct = (used: number, total: number | null) => (total ? ` (${Math.round((used / total) * 100)}%)` : "");

/**
 * Polls pod or node metrics while the view is open. Returns null when the kind has no
 * metrics or the cluster has no metrics-server, so the table can hide the columns.
 */
export function useMetrics(kindKey: string, namespaces: string[], connectionId: unknown) {
  const [usage, setUsage] = useState<Map<string, Usage> | null>(null);
  const supported = kindKey === "pods" || kindKey === "nodes";

  useEffect(() => {
    setUsage(null);
    if (!supported) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const list = kindKey === "pods" ? await podMetrics(namespaces) : await nodeMetrics();
        if (stopped) return;
        setUsage(new Map(list.map((u) => [`${u.namespace ?? ""}/${u.name}`, u])));
      } catch (e) {
        // No metrics-server: stop asking. Other errors: try again on the next tick.
        if (e === METRICS_UNAVAILABLE) return;
      }
      if (!stopped) timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kindKey, namespaces.join(","), supported, connectionId]);

  if (!usage) return null;
  return (row: Row): string[] => {
    const u = usage.get(`${row.namespace ?? ""}/${row.name}`);
    if (!u) return ["", ""];
    return [formatCpu(u.cpuMillis) + pct(u.cpuMillis, u.cpuAllocatableMillis), formatMemory(u.memoryBytes) + pct(u.memoryBytes, u.memoryAllocatableBytes)];
  };
}
