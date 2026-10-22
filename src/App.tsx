import { useCallback, useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IconAlertTriangle, IconAppWindow, IconHexagons, IconLayersSubtract, IconPackage, IconPalette, IconPin, IconServer2, IconWorld } from "@tabler/icons-react";
import * as api from "./api";
import type { Connected, Contexts, KindInfo, Row, Target } from "./api";
import { useStream } from "./useStream";
import { METRIC_COLUMNS, useMetrics } from "./useMetrics";
import { usePins, clusterColor } from "./pins";
import { FORWARDS, HELM, PROBLEMS, SECTIONS, sectionOf, type SectionId } from "./sections";
import { ThemeContext, THEMES, useTheme } from "./theme";
import ResourceTable from "./components/ResourceTable";
import DetailsPanel from "./components/DetailsPanel";
import HelmView from "./components/HelmView";
import PortForwardsView from "./components/PortForwardsView";
import ProblemsView from "./components/ProblemsView";
import Rail from "./components/Rail";
import TopBar from "./components/TopBar";
import KindTabs from "./components/KindTabs";
import CommandPalette, { type Command } from "./components/CommandPalette";

/** The namespace selection is remembered per cluster context (per viewer, best effort). */
const savedNamespaces = (context: string): string[] | null => {
  try {
    const raw = localStorage.getItem(`kubedeck.namespaces.${context}`);
    return raw ? (JSON.parse(raw) as string[]) : null;
  } catch {
    return null;
  }
};
const saveNamespaces = (context: string, selected: string[]) => {
  try {
    localStorage.setItem(`kubedeck.namespaces.${context}`, JSON.stringify(selected));
  } catch {
    // Storage unavailable: the selection just is not remembered.
  }
};

/** First kind of each section, used when the rail switches sections. */
const SECTION_DEFAULT: Partial<Record<SectionId, string>> = { problems: PROBLEMS, workloads: "pods", network: "services", config: "configmaps", cluster: "nodes", helm: HELM, forwards: FORWARDS };

export default function App() {
  const { theme, setTheme } = useTheme();
  const { pins, toggle: togglePin, moveUp } = usePins();
  const [contexts, setContexts] = useState<Contexts | null>(null);
  const [kinds, setKinds] = useState<KindInfo[]>([]);
  const [conn, setConn] = useState<Connected | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [namespaces, setNamespaces] = useState<string[]>([]);
  /** Selected namespaces; empty means all of them. */
  const [selectedNs, setSelectedNs] = useState<string[]>([]);
  /** A kind key, or PROBLEMS / HELM / FORWARDS. */
  const [view, setView] = useState("pods");
  const [recentCustom, setRecentCustom] = useState<string[]>([]);
  const [rows, setRows] = useState<Map<string, Row> | null>(null);
  /** The kind `rows` belongs to (it lags `view` for a render after switching). */
  const [rowsKind, setRowsKind] = useState<string | null>(null);
  /** An object to select once its kind's rows arrive (from Problems or Related). */
  const [pending, setPending] = useState<{ kindKey: string; namespace: string | null; name: string } | null>(null);
  const [problems, setProblems] = useState<api.Problem[] | null>(null);
  const [problemsError, setProblemsError] = useState<string | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Row | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helmInstallRequest, setHelmInstallRequest] = useState(0);
  /** The cluster rejected this window's credentials (e.g. an expired AWS session). */
  const [authProblem, setAuthProblem] = useState<{ context: string; auth: Connected["auth"]; tries: number } | null>(null);

  useEffect(() => {
    api.listKinds().then(setKinds);
    api.listContexts().then(
      (c) => {
        setContexts(c);
        // Windows opened from the rail or the palette start connected to their cluster.
        const initial = (window as { __KUBEDECK_INITIAL_CONTEXT__?: string | null }).__KUBEDECK_INITIAL_CONTEXT__;
        if (initial && c.contexts.some((x) => x.name === initial)) void choose(initial);
      },
      (e) => setError(`Could not read kubeconfig: ${api.errorText(e)}`),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Connects this window to `context`. `force` reconnects to the current cluster (fresh
   * credentials); `quiet` keeps the screen as it is until it succeeds (background retries).
   */
  async function choose(context: string, { force = false, quiet = false } = {}) {
    if (context === conn?.context && !force) return;
    if (!quiet) {
      setConnecting(true);
      setError(null);
      setConn(null);
      setSelected(null);
    }
    try {
      const c = await api.connect(context);
      // The new cluster may have different custom resources.
      const k = await api.listKinds();
      setKinds(k);
      setView((v) => (v === PROBLEMS || v === HELM || v === FORWARDS || k.some((x) => x.key === v) ? v : "pods"));
      setRecentCustom((recent) => recent.filter((key) => k.some((x) => x.key === key)));
      setConn(c);
      setAuthProblem(null);
      setError(null);
      // Cosmetic: never let the title fail a connection.
      try {
        getCurrentWindow()
          .setTitle(`${api.shortContextName(context)} — kubedeck`)
          .catch(() => {});
      } catch {
        // Not running inside a Tauri window.
      }
      const ns = await api.listNamespaces();
      setNamespaces(ns);
      const saved = savedNamespaces(context)?.filter((n) => ns.includes(n));
      setSelectedNs(saved ?? (ns.includes(c.defaultNamespace) ? [c.defaultNamespace] : []));
    } catch (e) {
      const message = api.errorText(e);
      if (api.isUnauthorized(message)) {
        const auth = await api.contextAuth(context).catch(() => null);
        setAuthProblem((p) => ({ context, auth, tries: (p?.tries ?? 0) + 1 }));
      }
      else if (!quiet) setError(`Could not connect to ${context}: ${message}`);
    } finally {
      if (!quiet) setConnecting(false);
    }
  }

  const openView = useCallback(
    (key: string) => {
      setView(key);
      setSelected(null);
      if (kinds.find((k) => k.key === key)?.group) setRecentCustom((recent) => [key, ...recent.filter((k) => k !== key)].slice(0, 6));
    },
    [kinds],
  );

  const section = sectionOf(view, kinds);
  const openSection = (id: SectionId) => {
    if (id === "custom") {
      const first = recentCustom[0] ?? kinds.find((k) => k.group)?.key;
      if (first) openView(first);
      return;
    }
    if (id !== section) openView(SECTION_DEFAULT[id] ?? "pods");
  };

  const kind = kinds.find((k) => k.key === view);
  // Cluster-scoped kinds ignore the namespace selection.
  const scopedNs = useMemo(() => (kind?.namespaced ? selectedNs : []), [kind?.namespaced, selectedNs]);
  const nsKey = scopedNs.join(",");
  const metricCells = useMetrics(view, scopedNs, conn);

  function chooseNamespaces(next: string[]) {
    setSelectedNs(next);
    if (conn) saveNamespaces(conn.context, next);
  }

  useStream(
    conn && kind
      ? () => {
          setRows(null);
          setRowsKind(kind.key);
          setWatchError(null);
          setSelected(null);
          // Busy clusters send many events per second: apply them once per frame.
          let queue: api.WatchMsg[] = [];
          const flush = () => {
            const batch = queue;
            queue = [];
            setRows((prev) => {
              let next = new Map(prev ?? []);
              for (const msg of batch) {
                if (msg.type === "snapshot") next = new Map(msg.rows.map((r) => [r.uid, r]));
                else if (msg.type === "upsert") next.set(msg.row.uid, msg.row);
                else if (msg.type === "delete") next.delete(msg.uid);
              }
              return next;
            });
          };
          return api.watchResources(kind.key, scopedNs, (msg) => {
            if (msg.type === "error") {
              if (msg.unauthorized && conn) setAuthProblem((p) => p ?? { context: conn.context, auth: conn.auth, tries: 0 });
              return setWatchError(msg.unauthorized ? null : msg.message);
            }
            setWatchError(null);
            if (queue.push(msg) === 1) requestAnimationFrame(flush);
          });
        }
      : null,
    (e) => setWatchError(api.errorText(e)),
    [conn, kind?.key, nsKey],
  );

  // Problems are checked in the background so the rail badge stays current.
  const allNsKey = selectedNs.join(",");
  useEffect(() => {
    if (!conn) return;
    let stale = false;
    setProblems(null);
    const load = () =>
      api.clusterProblems(selectedNs).then(
        (p) => !stale && (setProblems(p), setProblemsError(null)),
        (e) => !stale && !api.isUnauthorized(api.errorText(e)) && setProblemsError(api.errorText(e)),
      );
    void load();
    const timer = setInterval(load, view === PROBLEMS ? 10_000 : 30_000);
    return () => {
      stale = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, allNsKey, view === PROBLEMS]);

  /** Opens an object's kind, widening the namespace selection if needed, and selects it. */
  function goTo(kindKey: string, namespace: string | null, name: string) {
    if (!kinds.some((k) => k.key === kindKey)) return;
    openView(kindKey);
    if (namespace && selectedNs.length > 0 && !selectedNs.includes(namespace)) chooseNamespaces([...selectedNs, namespace]);
    setPending({ kindKey, namespace, name });
  }

  useEffect(() => {
    if (!pending || !rows || rowsKind !== pending.kindKey || view !== pending.kindKey) return;
    const row = [...rows.values()].find((r) => r.name === pending.name && (r.namespace ?? null) === pending.namespace);
    if (row) setSelected(row);
    setPending(null);
  }, [pending, rows, rowsKind, view]);

  // While the credentials are rejected, reconnect quietly every 20s: once the user renews
  // them (e.g. logs in to AWS again), the exec plugin runs again and the window recovers.
  useEffect(() => {
    if (!authProblem) return;
    const timer = setInterval(() => void choose(authProblem.context, { force: true, quiet: true }), 20_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authProblem?.context]);

  // Keep the details drawer pointing at the live version of the selected row.
  const selectedRow = selected && rows ? (rows.get(selected.uid) ?? null) : null;
  const target: Target | null = selectedRow && kind ? { kindKey: kind.key, namespace: selectedRow.namespace, name: selectedRow.name } : null;
  const rowList = useMemo(() => (rows ? [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)) : []), [rows]);
  const prod = conn ? api.isProduction(conn.context) : false;
  const visiblePins = pins.filter((p) => !contexts || contexts.contexts.some((c) => c.name === p));

  // Global shortcuts: ⌘K palette, ⌘N new window, ⌘1…9 pinned clusters.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key === "k") (e.preventDefault(), setPaletteOpen((o) => !o));
      else if (e.key === "n") (e.preventDefault(), void api.openWindow(null));
      else if (/^[1-9]$/.test(e.key) && visiblePins[Number(e.key) - 1]) (e.preventDefault(), void choose(visiblePins[Number(e.key) - 1]));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];
    if (conn) {
      for (const s of SECTIONS) {
        if (s.id === "problems") list.push({ id: "view:problems", group: "Go to", title: "Problems", subtitle: problems ? `${problems.length} found` : undefined, icon: <IconAlertTriangle size={16} />, run: () => openView(PROBLEMS) });
        else if (s.id === "helm") list.push({ id: "view:helm", group: "Go to", title: "Helm releases", icon: <IconPackage size={16} />, run: () => openView(HELM) });
        else if (s.id === "forwards") list.push({ id: "view:forwards", group: "Go to", title: "Port forwards", icon: <s.icon size={16} />, run: () => openView(FORWARDS) });
        else
          for (const key of s.kinds ?? []) {
            const k = kinds.find((x) => x.key === key);
            if (k) list.push({ id: `kind:${key}`, group: "Go to", title: k.label, subtitle: s.label, icon: <s.icon size={16} />, run: () => openView(key) });
          }
      }
      for (const k of kinds.filter((x) => x.group)) {
        list.push({ id: `kind:${k.key}`, group: "Custom resources", title: k.label, subtitle: k.group!, icon: <IconLayersSubtract size={16} />, run: () => openView(k.key) });
      }
      for (const r of rowList.slice(0, 500)) {
        list.push({ id: `row:${r.uid}`, group: kind?.label ?? "Resources", title: r.name, subtitle: r.namespace ?? undefined, icon: <IconHexagons size={16} />, run: () => setSelected(r) });
      }
      list.push({ id: "ns:all", group: "Namespaces", title: "All namespaces", icon: <IconWorld size={16} />, run: () => chooseNamespaces([]) });
      for (const ns of namespaces) {
        list.push({ id: `ns:${ns}`, group: "Namespaces", title: ns, subtitle: "show only this namespace", icon: <IconWorld size={16} />, run: () => chooseNamespaces([ns]) });
      }
      list.push({ id: "action:install", group: "Actions", title: "Install a Helm chart", icon: <IconPackage size={16} />, run: () => (openView(HELM), setHelmInstallRequest((n) => n + 1)) });
      list.push({
        id: "action:pin",
        group: "Actions",
        title: pins.includes(conn.context) ? "Unpin this cluster from the rail" : "Pin this cluster to the rail",
        icon: <IconPin size={16} />,
        run: () => togglePin(conn.context),
      });
    }
    for (const c of contexts?.contexts ?? []) {
      const name = api.shortContextName(c.name);
      const dot = <span className="cluster-dot" style={{ background: clusterColor(c.name) }} />;
      list.push({ id: `ctx:${c.name}`, group: "Clusters", title: name, subtitle: name !== c.name ? c.name : undefined, icon: dot, run: () => void choose(c.name) });
      list.push({ id: `ctxw:${c.name}`, group: "Clusters", title: `${name} in a new window`, icon: <IconAppWindow size={16} />, run: () => void api.openWindow(c.name) });
    }
    list.push({ id: "action:window", group: "Actions", title: "New window", hint: "⌘N", icon: <IconAppWindow size={16} />, run: () => void api.openWindow(null) });
    for (const t of THEMES) {
      list.push({ id: `theme:${t.id}`, group: "Theme", title: `Theme: ${t.label}`, subtitle: t.description, icon: <IconPalette size={16} />, run: () => setTheme(t.id) });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, kinds, contexts, namespaces, rowList, kind?.label, pins, openView, problems]);

  const viewLabel = view === PROBLEMS ? "Problems" : view === HELM ? "Helm releases" : view === FORWARDS ? "Port forwards" : (kind?.label ?? "");

  return (
    <ThemeContext.Provider value={theme}>
      <div className={`shell ${prod ? "prod" : ""}`}>
        <Rail
          section={section}
          onSection={openSection}
          connected={!!conn}
          pins={visiblePins}
          current={conn?.context ?? null}
          onSwitchCluster={(c) => void choose(c)}
          onUnpin={togglePin}
          onMoveUp={moveUp}
          theme={theme}
          onTheme={setTheme}
          problemCount={problems?.filter((p) => p.severity === "critical").length ?? 0}
        />
        <div className="stage">
          {prod && <div className="prod-strip">Production cluster · changes affect real workloads</div>}
          <TopBar
            contexts={contexts?.contexts ?? []}
            current={conn?.context ?? null}
            currentLabel={conn ? api.shortContextName(conn.context) : null}
            connecting={connecting}
            serverVersion={conn?.serverVersion ?? null}
            onSwitchCluster={(c) => void choose(c)}
            pins={pins}
            onTogglePin={togglePin}
            namespaces={namespaces}
            selectedNamespaces={selectedNs}
            namespacesEnabled={view === PROBLEMS || view === HELM || (kind?.namespaced ?? false)}
            onNamespaces={chooseNamespaces}
            viewLabel={conn ? viewLabel : ""}
            onOpenPalette={() => setPaletteOpen(true)}
          />
          {conn && <KindTabs section={section} kinds={kinds} active={view} recentCustom={recentCustom} onSelect={openView} />}
          {authProblem && <AuthBanner problem={authProblem} auth={authProblem.auth ?? conn?.auth ?? null} onRetry={() => void choose(authProblem.context, { force: true, quiet: !!conn })} />}
          {error && <div className="error-bar">{error}</div>}

          {!conn ? (
            <Welcome contexts={contexts} pins={visiblePins} connecting={connecting} onChoose={(c) => void choose(c)} onPalette={() => setPaletteOpen(true)} />
          ) : view === PROBLEMS ? (
            <div className="workspace">
              <ProblemsView problems={problems} error={problemsError} kinds={kinds} onOpen={(p) => goTo(p.kindKey, p.namespace, p.name)} />
            </div>
          ) : view === HELM ? (
            <div className="workspace">
              <HelmView
                key={conn.context}
                namespaces={selectedNs}
                allNamespaces={namespaces}
                defaultNamespace={conn.defaultNamespace}
                production={prod}
                context={conn.context}
                installRequest={helmInstallRequest}
              />
            </div>
          ) : view === FORWARDS ? (
            <div className="workspace">
              <PortForwardsView key={conn.context} />
            </div>
          ) : kind ? (
            <div className="workspace">
              <ResourceTable
                kind={kind}
                rows={rowList}
                loading={rows === null}
                error={watchError}
                showNamespace={kind.namespaced && scopedNs.length !== 1}
                selectedUid={selectedRow?.uid ?? null}
                onSelect={setSelected}
                extra={metricCells && { columns: METRIC_COLUMNS, cells: metricCells }}
              />
              {selectedRow && target && (
                <DetailsPanel key={selectedRow.uid} kind={kind} row={selectedRow} target={target} context={conn.context} production={prod}
                  kinds={kinds}
                  onNavigate={(item) => goTo(item.kindKey, item.namespace, item.name)}
                  onClose={() => setSelected(null)}
                />
              )}
            </div>
          ) : null}
        </div>
        {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}
      </div>
    </ThemeContext.Provider>
  );
}

function AuthBanner({ problem, auth, onRetry }: { problem: { context: string; tries: number }; auth: Connected["auth"]; onRetry: () => void }) {
  const [retrying, setRetrying] = useState(false);
  const retry = () => {
    setRetrying(true);
    onRetry();
    setTimeout(() => setRetrying(false), 1500);
  };
  return (
    <div className="auth-banner" role="alert">
      <div className="auth-banner-text">
        <strong>{api.shortContextName(problem.context)} rejected your credentials (401).</strong> They have probably expired.{" "}
        {auth?.awsProfile ? (
          <>
            This cluster signs in with <code>{auth.command}</code> using the AWS profile <code>{auth.awsProfile}</code>: renew that profile&apos;s credentials (for example{" "}
            <code>aws sso login --profile {auth.awsProfile}</code>, or the tool that writes <code>~/.aws/credentials</code>).
          </>
        ) : auth ? (
          <>
            This cluster signs in with <code>{auth.command}</code>: renew the credentials that command uses.
          </>
        ) : (
          <>Update the credentials in your kubeconfig.</>
        )}{" "}
        <span className="faint">kubedeck retries every 20s and recovers by itself once they work again.</span>
      </div>
      <button className="primary" disabled={retrying} onClick={retry}>
        {retrying ? "Reconnecting…" : "Reconnect now"}
      </button>
    </div>
  );
}

function Welcome({ contexts, pins, connecting, onChoose, onPalette }: { contexts: Contexts | null; pins: string[]; connecting: boolean; onChoose: (c: string) => void; onPalette: () => void }) {
  const ordered = contexts ? [...pins, ...contexts.contexts.map((c) => c.name).filter((c) => !pins.includes(c))] : [];
  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-logo">
          <IconHexagons size={28} stroke={1.5} />
        </div>
        <h1>kubedeck</h1>
        <p className="faint">{connecting ? "Connecting…" : "Pick a cluster to start."}</p>
        <div className="welcome-list">
          {ordered.slice(0, 8).map((c) => (
            <button key={c} className="welcome-item" disabled={connecting} onClick={() => onChoose(c)}>
              <span className="cluster-dot" style={{ background: clusterColor(c) }} />
              <span className="welcome-item-name">{api.shortContextName(c)}</span>
              {api.isProduction(c) && <span className="prod-badge small">prod</span>}
              {c === contexts?.current && <span className="faint">current</span>}
              <IconServer2 size={14} className="faint" />
            </button>
          ))}
        </div>
        <button className="link" onClick={onPalette}>
          or press <kbd>⌘K</kbd> to search
        </button>
      </div>
    </div>
  );
}
