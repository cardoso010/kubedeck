// Browser-only preview: when the UI runs outside Tauri (`npm run dev` in a normal browser),
// answer the backend commands with sample data so the interface can be worked on alone.
// Never bundled into the app: main.tsx only imports it in dev mode outside Tauri.
import type { Row } from "./api";

type Callback = (payload: unknown) => void;
const callbacks = new Map<number, Callback>();
let nextCallback = 1;
const channels = new Map<number, number>(); // channel id -> next message index

function send(channelId: number, message: unknown) {
  const index = channels.get(channelId) ?? 0;
  channels.set(channelId, index + 1);
  callbacks.get(channelId)?.({ index, message });
}

const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
const pod = (name: string, ready: string, status: string, restarts: number, ageS: number, containers = [name.split("-")[0]]): Row => ({
  uid: `uid-${name}`,
  name,
  namespace: "demo",
  created: ago(ageS),
  cells: [ready, status, String(restarts), "kubedeck-test-control-plane"],
  containers,
});

const ROWS: Record<string, Row[]> = {
  pods: [
    pod("web-7c6cdd646-2zjfg", "1/1", "Running", 0, 3600),
    pod("web-7c6cdd646-cggh4", "1/1", "Running", 0, 3600),
    pod("web-7c6cdd646-jtjnc", "1/1", "Running", 0, 3500),
    pod("api-5d9f8b7c6-x2k9p", "2/2", "Running", 1, 86400 * 3, ["api", "envoy"]),
    pod("ticker", "1/1", "Running", 0, 600),
    pod("broken", "0/1", "CrashLoopBackOff", 7, 900),
    pod("migrate-29gxk", "0/1", "Pending", 0, 20),
  ],
  deployments: [
    { uid: "d1", name: "web", namespace: "demo", created: ago(3600), cells: ["3/3", "3", "3"], containers: [] },
    { uid: "d2", name: "api", namespace: "demo", created: ago(86400 * 3), cells: ["1/1", "1", "1"], containers: [] },
  ],
  services: [{ uid: "s1", name: "web", namespace: "demo", created: ago(3600), cells: ["ClusterIP", "10.96.12.4", "80/TCP"], containers: [] }],
  configmaps: [{ uid: "c1", name: "app-config", namespace: "demo", created: ago(3600), cells: ["2"], containers: [] }],
};

// Mirrors src-tauri/src/kinds.rs (subset).
const KINDS = [
  { key: "pods", label: "Pods", namespaced: true, columns: ["Ready", "Status", "Restarts", "Node"] },
  { key: "deployments", label: "Deployments", namespaced: true, columns: ["Ready", "Up-to-date", "Available"] },
  { key: "services", label: "Services", namespaced: true, columns: ["Type", "Cluster IP", "Ports"] },
  { key: "configmaps", label: "ConfigMaps", namespaced: true, columns: ["Keys"] },
  { key: "nodes", label: "Nodes", namespaced: false, columns: ["Status", "Roles", "Version"] },
];

const YAML = `apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
  namespace: demo
  resourceVersion: "1234"
data:
  FEATURE_X: "true"
  LOG_LEVEL: debug
`;

const timers = new Map<number, ReturnType<typeof setInterval>>();
let nextStream = 1;

async function invoke(cmd: string, args: Record<string, any>): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 80));
  const channel = args?.onEvent?.id as number | undefined;
  switch (cmd) {
    case "list_kinds":
      return KINDS;
    case "list_contexts":
      return {
        current: "kind-kubedeck-test",
        contexts: [
          { name: "kind-kubedeck-test", cluster: "kind-kubedeck-test", namespace: null },
          { name: "arn:aws:eks:us-east-1:000000000000:cluster/shop-prd", cluster: "shop-prd", namespace: null },
        ],
      };
    case "connect":
      return { context: args.context, serverVersion: "v1.37.0", defaultNamespace: "demo" };
    case "list_namespaces":
      return ["default", "demo", "kube-system"];
    case "watch_resources": {
      const id = nextStream++;
      setTimeout(() => send(channel!, { type: "snapshot", rows: ROWS[args.kindKey] ?? [] }), 150);
      return id;
    }
    case "get_yaml":
      return YAML.replace(/app-config/g, args.name);
    case "replace_yaml":
      return args.yaml;
    case "delete_resource":
      return null;
    case "stream_logs": {
      const id = nextStream++;
      let i = 0;
      timers.set(id, setInterval(() => send(channel!, { type: "data", data: `tick ${++i} ${new Date().toString()}` }), 400));
      return id;
    }
    case "exec_start": {
      const id = nextStream++;
      execChannels.set(id, channel!);
      setTimeout(() => send(channel!, { type: "data", data: "/ # " }), 100);
      return id;
    }
    case "exec_input": {
      const ch = execChannels.get(args.id)!;
      const echo = (args.data as string).replace(/\r/g, "\r\n");
      send(ch, { type: "data", data: echo + (echo.endsWith("\n") ? "(preview: no real shell)\r\n/ # " : "") });
      return null;
    }
    case "stop_stream":
      clearInterval(timers.get(args.id));
      return null;
    default:
      return null;
  }
}

const execChannels = new Map<number, number>();

(window as any).__TAURI_INTERNALS__ = {
  transformCallback(cb: Callback) {
    const id = nextCallback++;
    callbacks.set(id, cb);
    return id;
  },
  unregisterCallback(id: number) {
    callbacks.delete(id);
  },
  invoke,
};
console.info("[kubedeck] running outside Tauri: using sample data from src/dev-mock.ts");
