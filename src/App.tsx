import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Logo from "./components/Logo";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Trans, useTranslation } from "react-i18next";
import { IconAlertTriangle, IconAppWindow, IconBell, IconBellOff, IconGauge, IconLock, IconLockOpen, IconPlus, IconHexagons, IconInfoCircle, IconLink, IconLayersSubtract, IconPackage, IconPalette, IconSettings, IconPin, IconServer2, IconWorld } from "@tabler/icons-react";
import * as api from "./api";
import type { Connected, Contexts, KindInfo, Row, Target } from "./api";
import { useStream } from "./useStream";
import { METRIC_COLUMNS, useMetrics } from "./useMetrics";
import { VOLUME_COLUMNS, useVolumeUsage } from "./useVolumeUsage";
import { usePins, clusterColor } from "./pins";
import { FORWARDS, HELM, PROBLEMS, RIGHTSIZING, SECTIONS, sectionOf, type SectionId } from "./sections";
import { ThemeContext, THEMES, useTheme } from "./theme";
import { lockedByDefault, ReadOnlyContext, saveLoginCommand, savedLoginCommand, setLockedByDefault, UNLOCK_MINUTES } from "./readOnly";
import ConfirmDialog from "./components/ConfirmDialog";
import ResourceTable from "./components/ResourceTable";
import DetailsPanel from "./components/DetailsPanel";
import HelmView from "./components/HelmView";
import PortForwardsView from "./components/PortForwardsView";
import ProblemsView from "./components/ProblemsView";
import RightsizingView from "./components/RightsizingView";
import CreateDialog from "./components/CreateDialog";
import Dock from "./components/Dock";
import { DockContext, type DockTab } from "./dock";
import { startFavorites } from "./favorites";
import { notifyEnabled, notifyNew, problemKey, setNotifyEnabled } from "./notify";
import Rail from "./components/Rail";
import { SITE_URL } from "./about";
import TopBar from "./components/TopBar";
import KindTabs from "./components/KindTabs";
import CommandPalette, { type Command } from "./components/CommandPalette";
import SettingsDialog from "./components/SettingsDialog";
import { usePoll } from "./usePoll";

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
const SECTION_DEFAULT: Partial<Record<SectionId, string>> = { storage: "persistentvolumeclaims", problems: PROBLEMS, rightsizing: RIGHTSIZING, workloads: "pods", network: "services", config: "configmaps", cluster: "nodes", helm: HELM, forwards: FORWARDS };

export default function App() {
  const { t, i18n } = useTranslation();
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
  /** Read-only mode of this window (enforced by the backend). */
  const [locked, setLocked] = useState(false);
  /** When a temporary unlock ends. */
  const [unlockedUntil, setUnlockedUntil] = useState<number | null>(null);
  const [confirmUnlock, setConfirmUnlock] = useState(false);
  const [lockPrefs, setLockPrefs] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const [dockTabs, setDockTabs] = useState<DockTab[]>([]);
  const [dockActive, setDockActive] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [notifyOn, setNotifyOn] = useState(false);
  /** Problems already seen, so only new ones notify; null until the first load. */
  const seenProblems = useRef<Set<string> | null>(null);
  const [problems, setProblems] = useState<api.Problem[] | null>(null);
  const [problemsError, setProblemsError] = useState<string | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Row | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helmInstallRequest, setHelmInstallRequest] = useState(0);
  const [aboutRequest, setAboutRequest] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
      (e) => setError(t("app.errors.kubeconfig", { message: api.errorText(e) })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Connects this window to `context`. `force` reconnects to the current cluster (fresh
   * credentials); `quiet` keeps the screen as it is until it succeeds (background retries).
   */
  async function choose(context: string, { force = false, quiet = false } = {}) {
    if (context === conn?.context && !force) return;
    if (context !== conn?.context) {
      // Lock before connecting, so a production window is never writable, even briefly.
      const lock = lockedByDefault(context);
      await api.setReadOnly(lock).catch(() => {});
      setLocked(lock);
      setUnlockedUntil(null);
      setDockTabs([]);
      setDockActive(null);
      setNotifyOn(notifyEnabled(context));
    }
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
      setView((v) => (v === PROBLEMS || v === RIGHTSIZING || v === HELM || v === FORWARDS || k.some((x) => x.key === v) ? v : "pods"));
      setRecentCustom((recent) => recent.filter((key) => k.some((x) => x.key === key)));
      setConn(c);
      setAuthProblem(null);
      setError(null);
      // Connecting stops every port forward; starred ones come back.
      void startFavorites(context).then((failed) => {
        if (failed.length) setError(t("app.errors.favorites", { list: failed.map(([f, why]) => `${f.name}:${f.remotePort} (${why})`).join("; ") }));
      });
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
      else if (!quiet) setError(t("app.errors.connect", { cluster: context, message }));
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
  const volumeCells = useVolumeUsage(view, scopedNs, conn);

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
    setProblems(null);
    seenProblems.current = null;
  }, [conn, allNsKey]);
  // Keeps polling while hidden when crash notifications are on: that is when they matter.
  usePoll(
    async (alive) => {
      if (!conn) return;
      try {
        const p = await api.clusterProblems(selectedNs);
        if (!alive()) return;
        const seen = seenProblems.current;
        if (seen && notifyEnabled(conn.context)) notifyNew(api.shortContextName(conn.context), p.filter((x) => !seen.has(problemKey(x))));
        seenProblems.current = new Set([...(seen ?? []), ...p.map(problemKey)]);
        setProblems(p);
        setProblemsError(null);
      } catch (e) {
        if (alive() && !api.isUnauthorized(api.errorText(e))) setProblemsError(api.errorText(e));
      }
    },
    conn ? (view === PROBLEMS ? 10_000 : 30_000) : null,
    [conn, allNsKey],
    notifyOn,
  );

  async function applyLock(next: boolean, until: number | null = null) {
    try {
      await api.setReadOnly(next);
      setLocked(next);
      setUnlockedUntil(until);
      setClock(Date.now());
    } catch (e) {
      setError(api.errorText(e));
    }
  }

  function toggleLock() {
    if (!conn) return;
    if (!locked) void applyLock(true);
    // Clusters locked by default unlock for a while only; others until locked again.
    else if (lockedByDefault(conn.context)) setConfirmUnlock(true);
    else void applyLock(false);
  }

  useEffect(() => {
    if (unlockedUntil === null) return;
    const relock = setTimeout(() => void applyLock(true), Math.max(0, unlockedUntil - Date.now()));
    const tick = setInterval(() => setClock(Date.now()), 15_000);
    return () => (clearTimeout(relock), clearInterval(tick));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlockedUntil]);

  const openDock = useCallback((tab: DockTab) => {
    setDockTabs((tabs) => (tabs.some((t) => t.id === tab.id) ? tabs : [...tabs, tab]));
    setDockActive(tab.id);
  }, []);
  function closeDock(id: string) {
    setDockTabs((tabs) => {
      const next = tabs.filter((t) => t.id !== id);
      setDockActive((active) => (active === id ? (next[next.length - 1]?.id ?? null) : active));
      return next;
    });
  }

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

  /** Whether `context` opens read-only; turning it on also locks this window now. */
  function setLockDefault(context: string, lock: boolean) {
    setLockedByDefault(context, lock);
    setLockPrefs((n) => n + 1);
    if (lock && !locked) void applyLock(true);
  }
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  // Global shortcuts: ⌘K palette, ⌘N new window, ⌘, settings, ⌘1…9 pinned clusters.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key === "k") (e.preventDefault(), setPaletteOpen((o) => !o));
      else if (e.key === "n") (e.preventDefault(), void api.openWindow(null));
      else if (e.key === ",") (e.preventDefault(), setSettingsOpen(true));
      else if (/^[1-9]$/.test(e.key) && visiblePins[Number(e.key) - 1]) (e.preventDefault(), void choose(visiblePins[Number(e.key) - 1]));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];
    if (conn) {
      for (const s of SECTIONS) {
        if (s.id === "rightsizing") list.push({ id: "view:rightsizing", group: t("app.palette.groups.goTo"), title: t("app.views.rightsizing"), subtitle: t("app.palette.rightsizingSubtitle"), icon: <IconGauge size={16} />, run: () => openView(RIGHTSIZING) });
        else if (s.id === "problems") list.push({ id: "view:problems", group: t("app.palette.groups.goTo"), title: t("app.views.problems"), subtitle: problems ? t("app.palette.problemsFound", { count: problems.length }) : undefined, icon: <IconAlertTriangle size={16} />, run: () => openView(PROBLEMS) });
        else if (s.id === "helm") list.push({ id: "view:helm", group: t("app.palette.groups.goTo"), title: t("app.views.helm"), icon: <IconPackage size={16} />, run: () => openView(HELM) });
        else if (s.id === "forwards") list.push({ id: "view:forwards", group: t("app.palette.groups.goTo"), title: t("app.views.forwards"), icon: <s.icon size={16} />, run: () => openView(FORWARDS) });
        else
          for (const key of s.kinds ?? []) {
            const k = kinds.find((x) => x.key === key);
            if (k) list.push({ id: `kind:${key}`, group: t("app.palette.groups.goTo"), title: k.label, subtitle: t(`app.sections.${s.id}`), icon: <s.icon size={16} />, run: () => openView(key) });
          }
      }
      for (const k of kinds.filter((x) => x.group)) {
        list.push({ id: `kind:${k.key}`, group: t("app.palette.groups.custom"), title: k.label, subtitle: k.group!, icon: <IconLayersSubtract size={16} />, run: () => openView(k.key) });
      }
      for (const r of rowList.slice(0, 500)) {
        list.push({ id: `row:${r.uid}`, group: kind?.label ?? t("app.palette.groups.resources"), title: r.name, subtitle: r.namespace ?? undefined, icon: <IconHexagons size={16} />, run: () => setSelected(r) });
      }
      list.push({ id: "ns:all", group: t("app.palette.groups.namespaces"), title: t("app.palette.allNamespaces"), icon: <IconWorld size={16} />, run: () => chooseNamespaces([]) });
      for (const ns of namespaces) {
        list.push({ id: `ns:${ns}`, group: t("app.palette.groups.namespaces"), title: ns, subtitle: t("app.palette.onlyNamespace"), icon: <IconWorld size={16} />, run: () => chooseNamespaces([ns]) });
      }
      list.push({ id: "action:install", group: t("app.palette.groups.actions"), title: t("app.palette.installChart"), icon: <IconPackage size={16} />, run: () => (openView(HELM), setHelmInstallRequest((n) => n + 1)) });
      list.push({ id: "action:create", group: t("app.palette.groups.actions"), title: t("app.palette.create"), icon: <IconPlus size={16} />, run: () => setCreateOpen(true) });
      list.push({
        id: "action:notify",
        group: t("app.palette.groups.actions"),
        title: notifyOn ? t("app.palette.notifyOff") : t("app.palette.notifyOn"),
        icon: notifyOn ? <IconBellOff size={16} /> : <IconBell size={16} />,
        run: () =>
          void setNotifyEnabled(conn.context, !notifyOn).then((ok) => (ok ? setNotifyOn(!notifyOn) : setError(t("app.errors.notifyDenied")))),
      });
      list.push({
        id: "action:lock",
        group: t("app.palette.groups.actions"),
        title: locked ? t("app.palette.unlockWindow") : t("app.palette.lockWindow"),
        icon: locked ? <IconLockOpen size={16} /> : <IconLock size={16} />,
        run: toggleLock,
      });
      const byDefault = lockedByDefault(conn.context);
      list.push({
        id: "action:lock-default",
        group: t("app.palette.groups.actions"),
        title: byDefault ? t("app.palette.lockDefaultOff") : t("app.palette.lockDefaultOn"),
        subtitle: api.shortContextName(conn.context),
        icon: <IconLock size={16} />,
        run: () => setLockDefault(conn.context, !byDefault),
      });
      list.push({
        id: "action:pin",
        group: t("app.palette.groups.actions"),
        title: pins.includes(conn.context) ? t("app.palette.unpin") : t("app.palette.pin"),
        icon: <IconPin size={16} />,
        run: () => togglePin(conn.context),
      });
    }
    for (const c of contexts?.contexts ?? []) {
      const name = api.shortContextName(c.name);
      const dot = <span className="cluster-dot" style={{ background: clusterColor(c.name) }} />;
      list.push({ id: `ctx:${c.name}`, group: t("app.palette.groups.clusters"), title: name, subtitle: name !== c.name ? c.name : undefined, icon: dot, run: () => void choose(c.name) });
      list.push({ id: `ctxw:${c.name}`, group: t("app.palette.groups.clusters"), title: t("app.palette.inNewWindow", { name }), icon: <IconAppWindow size={16} />, run: () => void api.openWindow(c.name) });
    }
    list.push({ id: "action:window", group: t("app.palette.groups.actions"), title: t("app.palette.newWindow"), hint: "⌘N", icon: <IconAppWindow size={16} />, run: () => void api.openWindow(null) });
    list.push({ id: "action:settings", group: t("app.palette.groups.actions"), title: t("app.palette.settings"), subtitle: t("app.palette.settingsSubtitle"), hint: "⌘,", icon: <IconSettings size={16} />, run: () => setSettingsOpen(true) });
    list.push({ id: "action:about", group: t("app.palette.groups.actions"), title: t("app.palette.about"), subtitle: t("app.palette.aboutSubtitle"), icon: <IconInfoCircle size={16} />, run: () => setAboutRequest((n) => n + 1) });
    list.push({ id: "action:share", group: t("app.palette.groups.actions"), title: t("app.palette.share"), subtitle: SITE_URL, icon: <IconLink size={16} />, run: () => void navigator.clipboard.writeText(SITE_URL) });
    for (const th of THEMES) {
      list.push({ id: `theme:${th.id}`, group: t("app.palette.groups.theme"), title: t("app.palette.theme", { name: t(`themes.${th.id}.label`) }), subtitle: t(`themes.${th.id}.description`), icon: <IconPalette size={16} />, run: () => setTheme(th.id) });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, kinds, contexts, namespaces, rowList, kind?.label, pins, openView, problems, locked, lockPrefs, notifyOn, i18n.language]);

  const viewLabel = view === RIGHTSIZING ? t("app.views.rightsizing") : view === PROBLEMS ? t("app.views.problems") : view === HELM ? t("app.views.helm") : view === FORWARDS ? t("app.views.forwards") : (kind?.label ?? "");

  return (
    <ThemeContext.Provider value={theme}>
      <ReadOnlyContext.Provider value={!!conn && locked}>
      <DockContext.Provider value={conn ? openDock : null}>
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
          onSettings={() => setSettingsOpen(true)}
          problemCount={problems?.filter((p) => p.severity === "critical").length ?? 0}
          aboutRequest={aboutRequest}
        />
        <div className="stage">
          {prod && <div className="prod-strip">{t("app.prodStrip")}</div>}
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
            namespacesEnabled={view === RIGHTSIZING || view === PROBLEMS || view === HELM || (kind?.namespaced ?? false)}
            onNamespaces={chooseNamespaces}
            viewLabel={conn ? viewLabel : ""}
            onOpenPalette={() => setPaletteOpen(true)}
            lock={conn ? { locked, minutesLeft: unlockedUntil === null ? null : Math.max(1, Math.ceil((unlockedUntil - clock) / 60_000)) } : null}
            onToggleLock={toggleLock}
            onCreate={conn ? () => setCreateOpen(true) : null}
          />
          {conn && <KindTabs section={section} kinds={kinds} active={view} recentCustom={recentCustom} onSelect={openView} />}
          {authProblem && <AuthBanner problem={authProblem} auth={authProblem.auth ?? conn?.auth ?? null} onRetry={() => void choose(authProblem.context, { force: true, quiet: !!conn })} />}
          {error && <div className="error-bar">{error}</div>}

          {!conn ? (
            <Welcome contexts={contexts} pins={visiblePins} connecting={connecting} onChoose={(c) => void choose(c)} onPalette={() => setPaletteOpen(true)} />
          ) : view === RIGHTSIZING ? (
            <div className="workspace">
              <RightsizingView namespaces={selectedNs} kinds={kinds} production={prod} context={conn.context} onOpen={(k, ns, name) => goTo(k, ns, name)} />
            </div>
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
              <PortForwardsView key={conn.context} context={conn.context} />
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
                extra={metricCells ? { columns: METRIC_COLUMNS, cells: metricCells } : volumeCells && { columns: VOLUME_COLUMNS, cells: volumeCells }}
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
          {conn && <Dock key={conn.context} tabs={dockTabs} active={dockActive} onActivate={setDockActive} onClose={closeDock} />}
        </div>
        {createOpen && conn && (
          <CreateDialog
            kindKey={kind?.key ?? null}
            namespaces={namespaces}
            defaultNamespace={selectedNs[0] ?? conn.defaultNamespace}
            production={prod}
            context={conn.context}
            onClose={() => setCreateOpen(false)}
          />
        )}
        {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}
        {settingsOpen && (
          <SettingsDialog
            theme={theme}
            onTheme={setTheme}
            context={conn?.context ?? null}
            lockedByDefault={conn ? lockedByDefault(conn.context) : false}
            onLockedByDefault={(lock) => conn && setLockDefault(conn.context, lock)}
            notify={notifyOn}
            onNotify={async (on) => {
              if (!conn || !(await setNotifyEnabled(conn.context, on))) return false;
              setNotifyOn(on);
              return true;
            }}
            onClose={closeSettings}
          />
        )}
        {confirmUnlock && conn && (
          <ConfirmDialog
            title={t("app.unlock.title", { name: api.shortContextName(conn.context) })}
            message={t("app.unlock.message", { minutes: UNLOCK_MINUTES, cluster: conn.context })}
            confirmLabel={t("app.unlock.confirm", { minutes: UNLOCK_MINUTES })}
            onConfirm={() => (setConfirmUnlock(false), void applyLock(false, Date.now() + UNLOCK_MINUTES * 60_000))}
            onCancel={() => setConfirmUnlock(false)}
          />
        )}
      </div>
      </DockContext.Provider>
      </ReadOnlyContext.Provider>
    </ThemeContext.Provider>
  );
}

function AuthBanner({ problem, auth, onRetry }: { problem: { context: string; tries: number }; auth: Connected["auth"]; onRetry: () => void }) {
  const { t } = useTranslation();
  const [retrying, setRetrying] = useState(false);
  const [command, setCommand] = useState(() => savedLoginCommand(problem.context) ?? (auth?.awsProfile ? `aws sso login --profile ${auth.awsProfile}` : ""));
  const [login, setLogin] = useState<{ state: "running" | "ok" | "failed"; output: string } | null>(null);
  async function runLogin() {
    saveLoginCommand(problem.context, command);
    setLogin({ state: "running", output: "" });
    try {
      const output = await api.runLogin(command);
      setLogin({ state: "ok", output });
      onRetry();
    } catch (e) {
      setLogin({ state: "failed", output: api.errorText(e) });
    }
  }
  const retry = () => {
    setRetrying(true);
    onRetry();
    setTimeout(() => setRetrying(false), 1500);
  };
  return (
    <div className="auth-banner" role="alert">
      <div className="auth-banner-text">
        <strong>{t("app.auth.rejected", { name: api.shortContextName(problem.context) })}</strong> {t("app.auth.expired")}{" "}
        {auth?.awsProfile ? (
          <Trans i18nKey="app.auth.aws" values={{ command: auth.command, profile: auth.awsProfile }} components={[<code />, <code />, <code />, <code />]} />
        ) : auth ? (
          <Trans i18nKey="app.auth.exec" values={{ command: auth.command }} components={[<code />]} />
        ) : (
          <>{t("app.auth.kubeconfig")}</>
        )}{" "}
        <span className="faint">{t("app.auth.retries")}</span>
        <div className="auth-login">
          <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder={t("app.auth.commandPlaceholder")} spellCheck={false} aria-label={t("app.auth.commandLabel")} />
          <button disabled={!command.trim() || login?.state === "running"} onClick={() => void runLogin()} title={t("app.auth.runTitle")}>
            {login?.state === "running" ? t("app.auth.waiting") : t("app.auth.run")}
          </button>
        </div>
        {login?.state === "ok" && <div className="ok auth-output">{t("app.auth.finished")}</div>}
        {login?.state === "failed" && <pre className="bad auth-output">{login.output}</pre>}
      </div>
      <button className="primary" disabled={retrying} onClick={retry}>
        {retrying ? t("app.auth.reconnecting") : t("app.auth.reconnect")}
      </button>
    </div>
  );
}

function Welcome({ contexts, pins, connecting, onChoose, onPalette }: { contexts: Contexts | null; pins: string[]; connecting: boolean; onChoose: (c: string) => void; onPalette: () => void }) {
  const { t } = useTranslation();
  const ordered = contexts ? [...pins, ...contexts.contexts.map((c) => c.name).filter((c) => !pins.includes(c))] : [];
  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-logo">
          <Logo size={28} />
        </div>
        <h1>kubedeck</h1>
        <p className="faint">{connecting ? t("app.welcome.connecting") : t("app.welcome.pick")}</p>
        <div className="welcome-list">
          {ordered.slice(0, 8).map((c) => (
            <button key={c} className="welcome-item" disabled={connecting} onClick={() => onChoose(c)}>
              <span className="cluster-dot" style={{ background: clusterColor(c) }} />
              <span className="welcome-item-name">{api.shortContextName(c)}</span>
              {api.isProduction(c) && <span className="prod-badge small">{t("app.welcome.prod")}</span>}
              {c === contexts?.current && <span className="faint">{t("app.welcome.current")}</span>}
              <IconServer2 size={14} className="faint" />
            </button>
          ))}
        </div>
        <button className="link" onClick={onPalette}>
          {t("app.welcome.or")} <kbd>⌘K</kbd> {t("app.welcome.toSearch")}
        </button>
      </div>
    </div>
  );
}
