// App themes. The CSS tokens live in App.css under [data-theme="…"]; this file picks the
// theme, remembers it, keeps every window in sync, and gives the editor and the terminal
// matching colors (they cannot read CSS variables).
import { createContext, useContext, useEffect, useState } from "react";

export type ThemeId = "terminal" | "graphite" | "light";

export interface Theme {
  id: ThemeId;
  label: string;
  description: string;
  monaco: string;
  xterm: { background: string; foreground: string; cursor: string; selectionBackground: string };
}

export const THEMES: Theme[] = [
  {
    id: "terminal",
    label: "Terminal",
    description: "Near-black, monospace, lime accent",
    monaco: "kubedeck-terminal",
    xterm: { background: "#05070a", foreground: "#c9d1d9", cursor: "#b6f36a", selectionBackground: "#b6f36a33" },
  },
  {
    id: "graphite",
    label: "Graphite",
    description: "Soft blue-grey, rounded, violet accent",
    monaco: "kubedeck-graphite",
    xterm: { background: "#111317", foreground: "#e6e8ee", cursor: "#a78bfa", selectionBackground: "#a78bfa40" },
  },
  {
    id: "light",
    label: "Light",
    description: "Crisp light theme, blue accent",
    monaco: "kubedeck-light",
    xterm: { background: "#0f1115", foreground: "#c9d1d9", cursor: "#60a5fa", selectionBackground: "#60a5fa40" },
  },
];

export const DEFAULT_THEME: ThemeId = "terminal";
const KEY = "kubedeck.theme";

function stored(): ThemeId {
  try {
    const value = localStorage.getItem(KEY);
    return THEMES.some((t) => t.id === value) ? (value as ThemeId) : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function themeById(id: ThemeId): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/** The theme components render with (editors and terminals need it in JS). */
export const ThemeContext = createContext<Theme>(THEMES[0]);
export const useCurrentTheme = () => useContext(ThemeContext);

/** Current theme; `setTheme` applies it to every open window. */
export function useTheme() {
  const [id, setId] = useState<ThemeId>(stored);

  useEffect(() => {
    document.documentElement.dataset.theme = id;
  }, [id]);

  // Another window changed the theme.
  useEffect(() => {
    const sync = (e: StorageEvent) => e.key === KEY && setId(stored());
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  const setTheme = (next: ThemeId) => {
    setId(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Storage unavailable: the choice lasts for this window only.
    }
  };

  return { theme: themeById(id), setTheme };
}

// Apply before React renders, so the first paint already has the right colors.
document.documentElement.dataset.theme = stored();
