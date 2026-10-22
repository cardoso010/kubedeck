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
const pod = (name: string, ready: string, status: string, restarts: number, ageS: number, containers = [name.split("-")[0]], ports: number[] = []): Row => ({
  uid: `uid-${name}`,
  name,
  namespace: "demo",
  created: ago(ageS),
  cells: [ready, status, String(restarts), "kubedeck-test-control-plane"],
  containers,
  ports,
});

const ROWS: Record<string, Row[]> = {
  pods: [
    pod("web-7c6cdd646-2zjfg", "1/1", "Running", 0, 3600, ["web"], [80]),
    pod("web-7c6cdd646-cggh4", "1/1", "Running", 0, 3600),
    pod("web-7c6cdd646-jtjnc", "1/1", "Running", 0, 3500),
    pod("api-5d9f8b7c6-x2k9p", "2/2", "Running", 1, 86400 * 3, ["api", "envoy"], [8080, 9901]),
    pod("ticker", "1/1", "Running", 0, 600),
    pod("broken", "0/1", "CrashLoopBackOff", 7, 900),
    pod("migrate-29gxk", "0/1", "Pending", 0, 20),
  ],
  deployments: [
    { uid: "d1", name: "web", namespace: "demo", created: ago(3600), cells: ["3/3", "3", "3"], containers: [], ports: [] },
    { uid: "d2", name: "api", namespace: "demo", created: ago(86400 * 3), cells: ["1/1", "1", "1"], containers: [], ports: [] },
  ],
  services: [{ uid: "s1", name: "web", namespace: "demo", created: ago(3600), cells: ["ClusterIP", "10.96.12.4", "80/TCP"], containers: [], ports: [80] }],
  configmaps: [{ uid: "c1", name: "app-config", namespace: "demo", created: ago(3600), cells: ["2"], containers: [], ports: [] }],
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

let connected = false;
const CUSTOM_KINDS = [
  { key: "widgets.kubedeck.dev", label: "Widget", namespaced: true, columns: ["Size"], group: "kubedeck.dev" },
  { key: "certificates.cert-manager.io", label: "Certificate", namespaced: true, columns: ["Ready", "Secret"], group: "cert-manager.io" },
  { key: "issuers.cert-manager.io", label: "Issuer", namespaced: true, columns: ["Ready"], group: "cert-manager.io" },
  { key: "nodepools.karpenter.sh", label: "NodePool", namespaced: false, columns: ["Nodes", "Ready"], group: "karpenter.sh" },
];
ROWS["widgets.kubedeck.dev"] = [{ uid: "w1", name: "sprocket", namespace: "demo", created: ago(400), cells: ["large"], containers: [], ports: [] }];
ROWS.nodes = [{ uid: "n1", name: "kubedeck-test-control-plane", namespace: null, created: ago(86400), cells: ["Ready", "control-plane", "v1.37.0"], containers: [], ports: [] }];
const forwards: any[] = [];
const HISTORY = [
  { revision: 3, updated: ago(600), status: "deployed", chart: "hello-0.1.0", appVersion: "1.16.0", description: "Rollback to 1" },
  { revision: 2, updated: ago(3000), status: "superseded", chart: "hello-0.1.0", appVersion: "1.16.0", description: "Upgrade complete" },
  { revision: 1, updated: ago(3600), status: "superseded", chart: "hello-0.1.0", appVersion: "1.16.0", description: "Install complete" },
];

const timers = new Map<number, ReturnType<typeof setInterval>>();
let nextStream = 1;

async function invoke(cmd: string, args: Record<string, any>): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 80));
  const channel = args?.onEvent?.id as number | undefined;
  switch (cmd) {
    case "list_kinds":
      return connected ? [...KINDS, ...CUSTOM_KINDS] : KINDS;
    case "list_contexts":
      return {
        current: "kind-kubedeck-test",
        contexts: [
          { name: "kind-kubedeck-test", cluster: "kind-kubedeck-test", namespace: null },
          { name: "arn:aws:eks:us-east-1:000000000000:cluster/shop-prd", cluster: "shop-prd", namespace: null },
        ],
      };
    case "connect":
      connected = true;
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
    case "start_port_forward": {
      const f = { id: nextStream++, kind: args.kind, namespace: args.namespace, name: args.name, remotePort: args.remotePort, localPort: args.localPort ?? 50000 + forwards.length, connections: 0, lastError: null };
      forwards.push(f);
      return f;
    }
    case "pod_metrics":
      return (ROWS.pods ?? []).map((r, i) => ({ namespace: r.namespace, name: r.name, cpuMillis: 2 + i * 37, memoryBytes: (6 + i * 21) * 1024 * 1024, cpuAllocatableMillis: null, memoryAllocatableBytes: null }));
    case "node_metrics":
      return [{ namespace: null, name: "kubedeck-test-control-plane", cpuMillis: 412, memoryBytes: 1.8 * 1024 ** 3, cpuAllocatableMillis: 8000, memoryAllocatableBytes: 7.6 * 1024 ** 3 }];
    case "list_port_forwards":
      return forwards;
    case "helm_list":
      return [
        { name: "hello", namespace: "demo", revision: "3", updated: ago(600), status: "deployed", chart: "hello-0.1.0", appVersion: "1.16.0" },
        { name: "ingress-nginx", namespace: "kube-system", revision: "12", updated: ago(86400 * 9), status: "deployed", chart: "ingress-nginx-4.11.3", appVersion: "1.11.3" },
        { name: "broken-upgrade", namespace: "demo", revision: "4", updated: ago(7200), status: "failed", chart: "api-2.3.0", appVersion: "2.3.0" },
      ].filter((r) => !args.namespace || r.namespace === args.namespace);
    case "helm_details":
      return { values: "replicaCount: 2\nimage:\n  tag: 1.16.0\n", manifest: "---\n# Source: hello/templates/deployment.yaml\napiVersion: apps/v1\nkind: Deployment\n", notes: "1. Get the application URL by running these commands: ...", history: HISTORY };
    case "helm_rollback":
    case "helm_uninstall":
      return "";
    case "stop_stream": {
      clearInterval(timers.get(args.id));
      const i = forwards.findIndex((f) => f.id === args.id);
      if (i >= 0) forwards.splice(i, 1);
      return null;
    }
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
