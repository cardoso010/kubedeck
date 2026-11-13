import { useEffect, useRef, type DependencyList } from "react";

/**
 * Runs `load` now and again `everyMs` after each run settles, restarting when `deps` change.
 *
 * Unlike setInterval, a slow cluster never stacks requests up (the next run waits for the
 * last), and a hidden window (minimized, another space) stops polling and catches up as soon
 * as it is shown again, unless `whileHidden` (crash notifications must keep coming).
 * `load` gets `alive()`, false once the deps changed or the component unmounted, to drop
 * stale results. `everyMs` null turns polling off.
 */
export function usePoll(load: (alive: () => boolean) => Promise<unknown>, everyMs: number | null, deps: DependencyList, whileHidden = false) {
  const latest = useRef(load);
  latest.current = load;

  useEffect(() => {
    if (everyMs === null) return;
    let alive = true;
    let running = false;
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const paused = () => !whileHidden && document.hidden;

    const run = async () => {
      clearTimeout(timer);
      if (running || !alive) return;
      running = true;
      try {
        await latest.current(() => alive);
      } catch {
        // `load` reports its own errors; polling goes on.
      } finally {
        running = false;
        last = Date.now();
      }
      if (alive && !paused()) timer = setTimeout(run, everyMs);
    };
    const onVisibility = () => {
      if (paused()) return clearTimeout(timer);
      clearTimeout(timer);
      timer = setTimeout(run, Math.max(0, last + everyMs - Date.now()));
    };

    void run();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [everyMs, whileHidden, ...deps]);
}
