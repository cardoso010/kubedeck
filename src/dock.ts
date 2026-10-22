// The bottom dock: terminals and log streams that stay open while you browse other
// objects. Its tabs belong to the window's current cluster and close when it changes.
import { createContext, useContext } from "react";
import type { LogSource } from "./components/LogsView";

export type DockTab =
  | { id: string; title: string; kind: "terminal"; namespace: string; pod: string; container: string | null }
  | { id: string; title: string; kind: "logs"; source: LogSource };

/** Opens a tab in the dock (or focuses it when the same one is already open). */
export const DockContext = createContext<((tab: DockTab) => void) | null>(null);
export const useDock = () => useContext(DockContext);
