// Port forwards the user starred, per cluster. They are started again whenever a window
// connects to that cluster (per viewer, best effort).
import { startPortForward } from "./api";

export interface Favorite {
  kind: "pod" | "service";
  namespace: string;
  name: string;
  remotePort: number;
  localPort: number;
}

const key = (context: string) => `kubedeck.forwards.${context}`;
export const favoriteId = (f: Pick<Favorite, "kind" | "namespace" | "name" | "remotePort">) => `${f.kind}/${f.namespace}/${f.name}:${f.remotePort}`;

export function loadFavorites(context: string): Favorite[] {
  try {
    return JSON.parse(localStorage.getItem(key(context)) ?? "[]") as Favorite[];
  } catch {
    return [];
  }
}

export function saveFavorites(context: string, list: Favorite[]) {
  try {
    localStorage.setItem(key(context), JSON.stringify(list));
  } catch {
    // Not remembered.
  }
}

/** Starts every favorite of `context`; returns the ones that failed, with why. */
export async function startFavorites(context: string): Promise<[Favorite, string][]> {
  const failed: [Favorite, string][] = [];
  for (const f of loadFavorites(context)) {
    try {
      await startPortForward(f.kind, f.namespace, f.name, f.remotePort, f.localPort);
    } catch (e) {
      failed.push([f, String(e)]);
    }
  }
  return failed;
}
