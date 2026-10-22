// Read-only mode: a window locked this way refuses every change to its cluster (the backend
// enforces it; the UI only disables buttons). Production clusters start locked unless the
// user chose otherwise for that cluster.
import { createContext, useContext } from "react";
import { isProduction } from "./api";

export const ReadOnlyContext = createContext(false);
export const useReadOnly = () => useContext(ReadOnlyContext);

/** How long "Unlock" lasts on a cluster that is locked by default. */
export const UNLOCK_MINUTES = 15;

const key = (context: string) => `kubedeck.readonly.${context}`;

export function lockedByDefault(context: string): boolean {
  try {
    const saved = localStorage.getItem(key(context));
    if (saved !== null) return saved === "1";
  } catch {
    // Storage unavailable: fall back to the production rule.
  }
  return isProduction(context);
}

export function setLockedByDefault(context: string, locked: boolean) {
  try {
    localStorage.setItem(key(context), locked ? "1" : "0");
  } catch {
    // Not remembered; the production rule applies next time.
  }
}

const loginKey = (context: string) => `kubedeck.login.${context}`;

/** The command that renews this cluster's credentials, as last saved by the user. */
export function savedLoginCommand(context: string): string | null {
  try {
    return localStorage.getItem(loginKey(context));
  } catch {
    return null;
  }
}

export function saveLoginCommand(context: string, command: string) {
  try {
    localStorage.setItem(loginKey(context), command);
  } catch {
    // Not remembered.
  }
}
