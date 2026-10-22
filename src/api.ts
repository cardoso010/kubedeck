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
  /** How the context logs in (exec plugin), to say what to renew when credentials expire. */
  auth: { command: string; awsProfile: string | null } | null;
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
  /** Desired replicas, for deployments and statefulsets. */
  replicas?: number | null;
  paused?: boolean;
}

export type WatchMsg =
  | { type: "snapshot"; rows: Row[] }
  | { type: "upsert"; row: Row }
  | { type: "delete"; uid: string }
  | { type: "error"; message: string; unauthorized: boolean };

export type StreamMsg = { type: "data"; data: string; source?: string } | { type: "end"; message: string | null };

/** Identifies one object for the YAML/delete commands. */
export interface Target {
  kindKey: string;
  namespace: string | null;
  name: string;
}

export const listContexts = () => invoke<Contexts>("list_contexts");
export const connect = (context: string) => invoke<Connected>("connect", { context });
export const contextAuth = (context: string) => invoke<Connected["auth"]>("context_auth", { context });
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

/** `previous`: the logs of the container's previous (crashed) run, not followed. */
export function streamLogs(namespace: string, pod: string, container: string | null, onMessage: (m: StreamMsg) => void, previous = false) {
  const onEvent = new Channel<StreamMsg>();
  onEvent.onmessage = onMessage;
  return invoke<number>("stream_logs", { namespace, pod, container, tailLines: 1000, previous, onEvent });
}

/** Logs of every pod of a workload, each line tagged with its pod in `source`. */
export function streamWorkloadLogs(kindKey: string, namespace: string, name: string, onMessage: (m: StreamMsg) => void) {
  const onEvent = new Channel<StreamMsg>();
  onEvent.onmessage = onMessage;
  return invoke<number>("stream_workload_logs", { kindKey, namespace, name, tailLines: 1000, onEvent });
}

export interface RevisionInfo {
  revision: number;
  replicaSet: string;
  created: string | null;
  replicas: number;
  images: string[];
  changeCause: string | null;
  current: boolean;
  templateYaml: string;
}

export interface RolloutStatus {
  replicas: number;
  ready: number;
  updated: number;
  available: number;
  paused: boolean;
  revisions: RevisionInfo[];
}

export interface EventRow {
  type: string;
  reason: string;
  message: string;
  count: number;
  lastSeen: string | null;
  source: string;
}

export const rolloutRestart = (kindKey: string, namespace: string, name: string) => invoke<void>("rollout_restart", { kindKey, namespace, name });
export const scale = (kindKey: string, namespace: string, name: string, replicas: number) => invoke<void>("scale", { kindKey, namespace, name, replicas });
export const setPaused = (namespace: string, name: string, paused: boolean) => invoke<void>("set_paused", { namespace, name, paused });
export const rolloutStatus = (namespace: string, name: string) => invoke<RolloutStatus>("rollout_status", { namespace, name });
export const rollback = (namespace: string, name: string, revision: number) => invoke<void>("rollback", { namespace, name, revision });
export const objectEvents = (namespace: string | null, uid: string) => invoke<EventRow[]>("object_events", { namespace, uid });

export interface Problem {
  severity: "critical" | "warning";
  kindKey: string;
  namespace: string | null;
  name: string;
  reason: string;
  message: string;
  since: string | null;
}

export interface RelatedItem {
  kindKey: string;
  namespace: string | null;
  name: string;
  status: string;
}

export interface RelatedGroup {
  relation: string;
  items: RelatedItem[];
}

export interface NodeSummary {
  cpuCapacityMillis: number;
  cpuAllocatableMillis: number;
  cpuRequestedMillis: number;
  cpuUsageMillis: number | null;
  memoryCapacityBytes: number;
  memoryAllocatableBytes: number;
  memoryRequestedBytes: number;
  memoryUsageBytes: number | null;
  pods: number;
  maxPods: number;
  unschedulable: boolean;
  conditions: { type: string; status: string; reason: string; message: string; bad: boolean }[];
  taints: string[];
  info: [string, string][];
}

export interface DrainReport {
  evicted: string[];
  skipped: [string, string][];
  failed: [string, string][];
}

export interface NodeHistory {
  source: string;
  cpu: Series[];
  memory: Series[];
}

export type ExplainMsg =
  | { type: "context"; characters: number }
  | { type: "text"; text: string }
  | { type: "restart"; model: string }
  | { type: "done"; model: string; refused: boolean }
  | { type: "error"; message: string };

export const clusterProblems = (namespaces: string[]) => invoke<Problem[]>("cluster_problems", { namespaces });
export const related = (kindKey: string, namespace: string | null, name: string) => invoke<RelatedGroup[]>("related", { kindKey, namespace, name });
export const nodeSummary = (name: string) => invoke<NodeSummary>("node_summary", { name });
export const cordon = (name: string, unschedulable: boolean) => invoke<void>("cordon", { name, unschedulable });
export const drain = (name: string, podSelector: string | null, dryRun: boolean) => invoke<DrainReport>("drain", { name, podSelector, dryRun });
export const nodeHistory = (name: string, minutes: number) => invoke<NodeHistory>("node_history", { name, minutes });

export const aiStatus = () => invoke<{ configured: boolean; source: "environment" | "keychain" | null }>("ai_status");
export const aiSetKey = (key: string) => invoke<void>("ai_set_key", { key });
export const aiClearKey = () => invoke<void>("ai_clear_key");
export function aiExplain(kindKey: string, namespace: string | null, name: string, onMessage: (m: ExplainMsg) => void) {
  const onEvent = new Channel<ExplainMsg>();
  onEvent.onmessage = onMessage;
  return invoke<number>("ai_explain", { kindKey, namespace, name, onEvent });
}

/** Asks where to save `contents` and writes it there. Resolves false when cancelled. */
export async function saveTextFile(defaultName: string, contents: string): Promise<boolean> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({ defaultPath: defaultName });
  if (!path) return false;
  await invoke("write_text_file", { path, contents });
  return true;
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

export interface ContainerUsage {
  name: string;
  cpuMillis: number | null;
  memoryBytes: number | null;
  cpuRequestMillis: number | null;
  cpuLimitMillis: number | null;
  memoryRequestBytes: number | null;
  memoryLimitBytes: number | null;
  restarts: number;
  ready: boolean;
  state: string;
  lastTermination: string | null;
}

export interface PodUsage {
  metricsServer: boolean;
  containers: ContainerUsage[];
}

/** [unix seconds, value] pairs. */
export type Point = [number, number];

export interface Series {
  name: string;
  points: Point[];
}

export interface PodHistory {
  source: string;
  stepSeconds: number;
  /** Cores. */
  cpu: Series[];
  /** Working-set bytes. */
  memory: Series[];
  /** Bytes per second ("receive", "transmit"). */
  network: Series[];
  /** Fraction of CPU periods throttled, 0..1. */
  throttling: Series[];
}

export const podUsage = (namespace: string, pod: string) => invoke<PodUsage>("pod_usage", { namespace, pod });
/** "namespace/service:port" of the cluster's Prometheus, or null when there is none. */
export const prometheusTarget = () => invoke<string | null>("prometheus_target");
export const podHistory = (namespace: string, pod: string, minutes: number) => invoke<PodHistory>("pod_history", { namespace, pod, minutes });

export function formatRate(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MiB/s`;
  if (bytesPerSecond >= 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KiB/s`;
  return `${Math.round(bytesPerSecond)} B/s`;
}

/** The cluster rejected the credentials (the backend words these errors with "(401)"). */
export const isUnauthorized = (message: string) => /\(401\)|\bUnauthorized\b/.test(message);

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
