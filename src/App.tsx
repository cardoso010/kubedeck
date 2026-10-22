import { useCallback, useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IconAppWindow, IconHexagons, IconLayersSubtract, IconPackage, IconPalette, IconPin, IconServer2, IconWorld } from "@tabler/icons-react";
import * as api from "./api";
import type { Connected, Contexts, KindInfo, Row, Target } from "./api";
import { useStream } from "./useStream";
import { METRIC_COLUMNS, useMetrics } from "./useMetrics";
import { usePins, clusterColor } from "./pins";
import { FORWARDS, HELM, SECTIONS, sectionOf, type SectionId } from "./sections";
import { ThemeContext, THEMES, useTheme } from "./theme";
import ResourceTable from "./components/ResourceTable";
import DetailsPanel from "./components/DetailsPanel";
import HelmView from "./components/HelmView";
import PortForwardsView from "./components/PortForwardsView";
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
const SECTION_DEFAULT: Partial<Record<SectionId, string>> = { workloads: "pods", network: "services", config: "configmaps", cluster: "nodes", helm: HELM, forwards: FORWARDS };

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
  /** A kind key, or HELM / FORWARDS. */
  const [view, setView] = useState("pods");
  const [recentCustom, setRecentCustom] = useState<string[]>([]);
  const [rows, setRows] = useState<Map<string, Row> | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Row | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helmInstallRequest, setHelmInstallRequest] = useState(0);

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

  async function choose(context: string) {
    if (context === conn?.context) return;
    setConnecting(true);
    setError(null);
    setConn(null);
    setSelected(null);
    try {
      const c = await api.connect(context);
      // The new cluster may have different custom resources.
      const k = await api.listKinds();
      setKinds(k);
      setView((v) => (v === HELM || v === FORWARDS || k.some((x) => x.key === v) ? v : "pods"));
      setRecentCustom((recent) => recent.filter((key) => k.some((x) => x.key === key)));
      setConn(c);
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
      setError(`Could not connect to ${context}: ${api.errorText(e)}`);
    } finally {
      setConnecting(false);
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
            if (msg.type === "error") return setWatchError(msg.message);
            setWatchError(null);
            if (queue.push(msg) === 1) requestAnimationFrame(flush);
          });
        }
      : null,
    (e) => setWatchError(api.errorText(e)),
    [conn, kind?.key, nsKey],
  );

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
        if (s.id === "helm") list.push({ id: "view:helm", group: "Go to", title: "Helm releases", icon: <IconPackage size={16} />, run: () => openView(HELM) });
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
  }, [conn, kinds, contexts, namespaces, rowList, kind?.label, pins, openView]);

  const viewLabel = view === HELM ? "Helm releases" : view === FORWARDS ? "Port forwards" : (kind?.label ?? "");

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
            namespacesEnabled={view === HELM || (kind?.namespaced ?? false)}
            onNamespaces={chooseNamespaces}
            viewLabel={conn ? viewLabel : ""}
            onOpenPalette={() => setPaletteOpen(true)}
          />
          {conn && <KindTabs section={section} kinds={kinds} active={view} recentCustom={recentCustom} onSelect={openView} />}
          {error && <div className="error-bar">{error}</div>}

          {!conn ? (
            <Welcome contexts={contexts} pins={visiblePins} connecting={connecting} onChoose={(c) => void choose(c)} onPalette={() => setPaletteOpen(true)} />
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
                <DetailsPanel key={selectedRow.uid} kind={kind} row={selectedRow} target={target} context={conn.context} production={prod} onClose={() => setSelected(null)} />
              )}
            </div>
          ) : null}
        </div>
        {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}
      </div>
    </ThemeContext.Provider>
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
