// Monaco, bundled locally (the default loader fetches it from a CDN, which a desktop app
// should not depend on) and loaded on demand through components/CodeEditor.tsx.
//
// Only the editor, its editing features and YAML: the `monaco-editor` entry point also
// pulls every language and the TypeScript/CSS/HTML/JSON services with their workers,
// megabytes the app never uses.
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/features/register.all";
import "monaco-editor/languages/definitions/yaml/register";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });

// Monaco themes matching each app theme (names in theme.ts), registered before any editor mounts.
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

export { default as Editor, DiffEditor } from "@monaco-editor/react";
