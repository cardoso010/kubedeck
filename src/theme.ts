// App themes. The CSS tokens live in App.css under [data-theme="…"]; this file picks the
// theme, remembers it, keeps every window in sync, and gives the editor and the terminal
// matching colors (they cannot read CSS variables).
import { createContext, useContext, useEffect, useState } from "react";
import { loader } from "@monaco-editor/react";

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

// Monaco themes matching each app theme; registered once, before any editor mounts.
loader.init().then((monaco) => {
  monaco.editor.defineTheme("kubedeck-terminal", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "type", foreground: "b6f36a" },
      { token: "string", foreground: "e6c07b" },
      { token: "number", foreground: "79c0ff" },
      { token: "keyword", foreground: "ff7b72" },
    ],
    colors: {
      "editor.background": "#05070a",
      "editor.lineHighlightBackground": "#0f141a",
      "editorLineNumber.foreground": "#3b444f",
      "editorLineNumber.activeForeground": "#8b96a3",
      "editor.selectionBackground": "#b6f36a2e",
      "editorCursor.foreground": "#b6f36a",
    },
  });
  monaco.editor.defineTheme("kubedeck-graphite", {
    base: "vs-dark",
    inherit: true,
    rules: [{ token: "type", foreground: "c4b5fd" }],
    colors: {
      "editor.background": "#111317",
      "editor.lineHighlightBackground": "#1b1e24",
      "editorLineNumber.foreground": "#4b5160",
      "editor.selectionBackground": "#a78bfa33",
      "editorCursor.foreground": "#a78bfa",
    },
  });
  monaco.editor.defineTheme("kubedeck-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#ffffff",
      "editor.lineHighlightBackground": "#f6f7f9",
      "editorLineNumber.foreground": "#b4bac2",
    },
  });
});

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
