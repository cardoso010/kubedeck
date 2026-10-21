import React from "react";
import ReactDOM from "react-dom/client";
import "./monaco";
import "@xterm/xterm/css/xterm.css";
import "./App.css";
import App from "./App";

async function start() {
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) await import("./dev-mock");
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void start();
