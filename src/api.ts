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

export function watchResources(kindKey: string, namespace: string | null, onMessage: (m: WatchMsg) => void) {
  const onEvent = new Channel<WatchMsg>();
  onEvent.onmessage = onMessage;
  return invoke<number>("watch_resources", { kindKey, namespace, onEvent });
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

export const helmList = (namespace: string | null) => invoke<HelmRelease[]>("helm_list", { namespace });
export const helmDetails = (namespace: string, name: string) => invoke<HelmDetails>("helm_details", { namespace, name });
export const helmRollback = (namespace: string, name: string, revision: number) => invoke<string>("helm_rollback", { namespace, name, revision });
export const helmUninstall = (namespace: string, name: string) => invoke<string>("helm_uninstall", { namespace, name });

/** Errors from Rust commands arrive as plain strings. */
export const errorText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));

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
