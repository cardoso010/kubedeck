import { useEffect, useState } from "react";
import { formatMemory, volumeUsage, type Row, type VolumeStats } from "./api";

const POLL_MS = 30_000;
export const VOLUME_COLUMNS = ["Used"];

/**
 * Polls claim usage while the PersistentVolumeClaims view is open. Null when nothing reports
 * usage (e.g. hostPath volumes, or no access to Prometheus or the kubelets), so the column hides.
 */
export function useVolumeUsage(kindKey: string, namespaces: string[], connectionId: unknown) {
  const [usage, setUsage] = useState<Map<string, VolumeStats> | null>(null);
  const supported = kindKey === "persistentvolumeclaims";

  useEffect(() => {
    setUsage(null);
    if (!supported) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const { volumes } = await volumeUsage(namespaces);
        if (stopped) return;
        setUsage(volumes.length ? new Map(volumes.map((v) => [`${v.namespace}/${v.claim}`, v])) : null);
      } catch {
        // Try again on the next tick.
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
    const v = usage.get(`${row.namespace ?? ""}/${row.name}`);
    if (!v || !v.capacityBytes) return [""];
    return [`${formatMemory(v.usedBytes)} (${Math.round((v.usedBytes / v.capacityBytes) * 100)}%)`];
  };
}
