import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { errorText, execInput, execResize, execStart, stopStream } from "../api";
import { useCurrentTheme } from "../theme";
import { useReadOnly } from "../readOnly";

export default function TerminalView(props: { namespace: string; pod: string; container: string | null }) {
  if (useReadOnly()) return <div className="empty">Read-only mode: a shell could change the container. Unlock the cluster to open one.</div>;
  return <Shell {...props} />;
}

function Shell({ namespace, pod, container }: { namespace: string; pod: string; container: string | null }) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const theme = useCurrentTheme();

  useEffect(() => {
    const term = new Terminal({ fontSize: 12, fontFamily: '"JetBrains Mono Variable", Menlo, monospace', cursorBlink: true, theme: theme.xterm });
    terminal.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    fit.fit();

    let id: number | null = null;
    let disposed = false;
    term.writeln(`\x1b[2mConnecting to ${pod}${container ? `/${container}` : ""}…\x1b[0m`);

    execStart(namespace, pod, container, term.cols, term.rows, (msg) => {
      if (msg.type === "data") term.write(msg.data);
      else term.writeln(`\r\n\x1b[2m[session ended${msg.message ? `: ${msg.message}` : ""}]\x1b[0m`);
    }).then(
      (sessionId) => {
        if (disposed) return void stopStream(sessionId);
        id = sessionId;
        term.focus();
      },
      (e) => term.writeln(`\x1b[31m${errorText(e)}\x1b[0m`),
    );

    const input = term.onData((data) => id !== null && void execInput(id, data).catch(() => {}));
    const resize = term.onResize(({ cols, rows }) => id !== null && void execResize(id, cols, rows));
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(host.current!);

    return () => {
      disposed = true;
      observer.disconnect();
      input.dispose();
      resize.dispose();
      if (id !== null) void stopStream(id);
      term.dispose();
    };
    // The theme is applied below without restarting the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namespace, pod, container]);

  useEffect(() => {
    if (terminal.current) terminal.current.options.theme = theme.xterm;
  }, [theme]);

  return <div className="terminal" ref={host} />;
}
