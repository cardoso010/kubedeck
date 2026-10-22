// Pinned clusters (the hotbar), shared by every window through localStorage.
import { useEffect, useState } from "react";

const KEY = "kubedeck.hotbar";

function load(): string[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function usePins() {
  const [pins, setPins] = useState<string[]>(load);

  useEffect(() => {
    const sync = (e: StorageEvent) => e.key === KEY && setPins(load());
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  const save = (list: string[]) => {
    setPins(list);
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
    } catch {
      // Storage unavailable: pins last for this window only.
    }
  };

  return {
    pins,
    toggle: (context: string) => save(pins.includes(context) ? pins.filter((c) => c !== context) : [...pins, context]),
    moveUp: (context: string) => {
      const i = pins.indexOf(context);
      if (i > 0) save([...pins.slice(0, i - 1), context, pins[i - 1], ...pins.slice(i + 1)]);
    },
  };
}

/** Stable color per context, so a cluster looks the same in every window. */
export function clusterColor(context: string) {
  let h = 0;
  for (const c of context) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 42% 36%)`;
}
