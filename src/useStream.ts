import { useEffect } from "react";
import { stopStream } from "./api";

/**
 * Runs `start` (which returns a backend stream id) while the dependencies stay the same,
 * and stops that stream on change or unmount — including when it is still starting.
 */
export function useStream(start: (() => Promise<number>) | null, onError: (e: unknown) => void, deps: unknown[]) {
  useEffect(() => {
    if (!start) return;
    let id: number | null = null;
    let cancelled = false;
    start().then(
      (streamId) => {
        if (cancelled) void stopStream(streamId);
        else id = streamId;
      },
      (e) => !cancelled && onError(e),
    );
    return () => {
      cancelled = true;
      if (id !== null) void stopStream(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
