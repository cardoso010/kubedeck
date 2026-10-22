// Typed wrappers around the Rust commands in src-tauri/src.
import { Channel, invoke } from "@tauri-apps/api/core";

export interface ContextInfo {
  name: string;
  cluster: string;
  namespace: string | null;
}

export interface Contexts {
  contexts: ContextInfo[];
  current: string | null;
}

export interface Connected {
  context: string;
  serverVersion: string;
  defaultNamespace: string;
}

export interface KindInfo {
  key: string;
  label: string;
  namespaced: boolean;
  columns: string[];
  /** API group of a custom resource; null for built-in kinds. */
  group?: string | null;
}

export interface Row {
  uid: string;
  name: string;
  namespace: string | null;
  created: string | null;
  cells: string[];
  containers: string[];
  ports: number[];
}

export type WatchMsg =
  | { type: "snapshot"; rows: Row[] }
  | { type: "upsert"; row: Row }
  | { type: "delete"; uid: string }
  | { type: "error"; message: string };

export type StreamMsg = { type: "data"; data: string } | { type: "end"; message: string | null };

/** Identifies one object for the YAML/delete commands. */
export interface Target {
  kindKey: string;
  namespace: string | null;
  name: string;
}

export const listContexts = () => invoke<Contexts>("list_contexts");
export const connect = (context: string) => invoke<Connected>("connect", { context });
export const listNamespaces = () => invoke<string[]>("list_namespaces");
export const listKinds = () => invoke<KindInfo[]>("list_kinds");
export const stopStream = (id: number) => invoke<void>("stop_stream", { id });

/** `namespaces` empty means every namespace. */
export function watchResources(kindKey: string, namespaces: string[], onMessage: (m: WatchMsg) => void) {
  const onEvent = new Channel<WatchMsg>();
  onEvent.onmessage = onMessage;
  return invoke<number>("watch_resources", { kindKey, namespaces, onEvent });
}

export const getYaml = (t: Target) => invoke<string>("get_yaml", { ...t });
export const replaceYaml = (t: Target, yaml: string) => invoke<string>("replace_yaml", { ...t, yaml });
export const deleteResource = (t: Target) => invoke<void>("delete_resource", { ...t });

export function streamLogs(namespace: string, pod: string, container: string | null, onMessage: (m: StreamMsg) => void) {
  const onEvent = new Channel<StreamMsg>();
  onEvent.onmessage = onMessage;
  return invoke<number>("stream_logs", { namespace, pod, container, tailLines: 1000, onEvent });
}

export function execStart(
  namespace: string,
  pod: string,
  container: string | null,
  cols: number,
  rows: number,
  onMessage: (m: StreamMsg) => void,
) {
  const onEvent = new Channel<StreamMsg>();
  onEvent.onmessage = onMessage;
  return invoke<number>("exec_start", { namespace, pod, container, cols, rows, onEvent });
}

export const execInput = (id: number, data: string) => invoke<void>("exec_input", { id, data });
export const execResize = (id: number, cols: number, rows: number) => invoke<void>("exec_resize", { id, cols, rows });

export interface ForwardInfo {
  id: number;
  kind: "pod" | "service";
  namespace: string;
  name: string;
  remotePort: number;
  localPort: number;
  connections: number;
  lastError: string | null;
}

export const startPortForward = (kind: "pod" | "service", namespace: string, name: string, remotePort: number, localPort: number | null = null) =>
  invoke<ForwardInfo>("start_port_forward", { kind, namespace, name, remotePort, localPort });
export const listPortForwards = () => invoke<ForwardInfo[]>("list_port_forwards");

export interface HelmRelease {
  name: string;
  namespace: string;
  revision: string;
  updated: string;
  status: string;
  chart: string;
  appVersion: string;
}

export interface HelmRevision {
  revision: number;
  updated: string;
  status: string;
  chart: string;
  appVersion: string;
  description: string;
}

export interface HelmDetails {
  values: string;
  manifest: string;
  notes: string;
  history: HelmRevision[];
}

export interface HelmRepo {
  name: string;
  url: string;
}

export interface HelmChart {
  /** `repo/chart`, usable as a chart reference. */
  name: string;
  version: string;
  appVersion: string;
  description: string;
}

export interface ChartAction {
  namespace: string;
  /** Release name. */
  name: string;
  chart: string;
  version: string | null;
  values: string;
  createNamespace?: boolean;
  dryRun?: boolean;
}

export const helmRepoList = () => invoke<HelmRepo[]>("helm_repo_list");
export const helmRepoAdd = (name: string, url: string) => invoke<void>("helm_repo_add", { name, url });
export const helmRepoRemove = (name: string) => invoke<void>("helm_repo_remove", { name });
export const helmRepoUpdate = () => invoke<void>("helm_repo_update");
export const helmSearch = (query: string) => invoke<HelmChart[]>("helm_search", { query });
export const helmChartVersions = (chart: string) => invoke<HelmChart[]>("helm_chart_versions", { chart });
export const helmShowValues = (chart: string, version: string | null) => invoke<string>("helm_show_values", { chart, version });
/** Returns helm's output: the rendered manifests for a dry run, the release notes otherwise. */
export const helmInstall = (request: ChartAction) => invoke<string>("helm_install", { request });
export const helmUpgrade = (request: ChartAction) => invoke<string>("helm_upgrade", { request });

/** Splits a release's chart field ("ingress-nginx-4.11.3") into name and version. */
export function splitChart(chart: string): { name: string; version: string | null } {
  const m = /^(.+?)-(\d+\.\d+\.\d+.*)$/.exec(chart);
  return m ? { name: m[1], version: m[2] } : { name: chart, version: null };
}

export const helmList = (namespaces: string[]) => invoke<HelmRelease[]>("helm_list", { namespaces });
export const helmDetails = (namespace: string, name: string) => invoke<HelmDetails>("helm_details", { namespace, name });
export const helmRollback = (namespace: string, name: string, revision: number) => invoke<string>("helm_rollback", { namespace, name, revision });
export const helmUninstall = (namespace: string, name: string) => invoke<string>("helm_uninstall", { namespace, name });

export interface Usage {
  namespace: string | null;
  name: string;
  cpuMillis: number;
  memoryBytes: number;
  cpuAllocatableMillis: number | null;
  memoryAllocatableBytes: number | null;
}

export const podMetrics = (namespaces: string[]) => invoke<Usage[]>("pod_metrics", { namespaces });
export const nodeMetrics = () => invoke<Usage[]>("node_metrics");
/** Error the backend returns when the cluster has no metrics-server. */
export const METRICS_UNAVAILABLE = "metrics-unavailable";

export function formatCpu(millis: number): string {
  return millis >= 1000 ? `${(millis / 1000).toFixed(2)}` : `${Math.round(millis)}m`;
}

export function formatMemory(bytes: number): string {
  const mi = bytes / 1024 / 1024;
  return mi >= 1024 ? `${(mi / 1024).toFixed(2)}Gi` : `${Math.round(mi)}Mi`;
}

export type UpdateStatus =
  | { status: "upToDate" }
  | { status: "available"; version: string; notes: string | null; date: string | null }
  | { status: "noCredentials" }
  | { status: "error"; message: string };

export const checkForUpdate = () => invoke<UpdateStatus>("check_for_update");
/** Downloads, verifies and installs the pending update; the app restarts when it succeeds. */
export const installUpdate = () => invoke<void>("install_update");

/** Errors from Rust commands arrive as plain strings. */
export const errorText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));

/** Opens another window, connected to `context` when given. Each window is independent. */
export const openWindow = (context: string | null) => invoke<void>("open_window", { context });

/** Readable cluster name: "shop-prd" from an EKS ARN, the cluster from a GKE context. */
export function shortContextName(context: string): string {
  const eks = /:cluster\/(.+)$/.exec(context);
  if (eks) return eks[1];
  const gke = /^gke_[^_]+_[^_]+_(.+)$/.exec(context);
  if (gke) return gke[1];
  return context;
}

export const isProduction = (context: string) => /(^|[-_/.:])(prd|prod|production)([-_/.:]|$)/i.test(context);

export function age(created: string | null, now: number): string {
  if (!created) return "";
  const s = Math.max(0, Math.floor((now - Date.parse(created)) / 1000));
  if (s < 120) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 120) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
