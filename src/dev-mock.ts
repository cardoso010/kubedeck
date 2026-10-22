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
    { ...pod("worker-6b9c7f5d8-4xkqp", "1/1", "Running", 0, 7200), namespace: "demo2", uid: "uid-worker-1" },
    { ...pod("worker-6b9c7f5d8-p2m7s", "1/1", "Running", 0, 7200), namespace: "demo2", uid: "uid-worker-2" },
    { ...pod("coredns-7db6d8ff4d-x8x2v", "1/1", "Running", 0, 86400), namespace: "kube-system", uid: "uid-coredns" },
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

const POD_YAML = `apiVersion: v1
kind: Pod
metadata:
  name: web-7c6cdd646-2zjfg
  namespace: demo
  labels:
    app: web
    pod-template-hash: 7c6cdd646
  ownerReferences:
    - apiVersion: apps/v1
      kind: ReplicaSet
      name: web-7c6cdd646
spec:
  containers:
    - name: web
      image: nginx:1.27-alpine
      ports:
        - containerPort: 80
          protocol: TCP
      resources:
        requests:
          cpu: 50m
          memory: 64Mi
  nodeName: kubedeck-test-control-plane
status:
  phase: Running
  podIP: 10.244.0.12
  containerStatuses:
    - name: web
      ready: true
      restartCount: 0
`;

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
      return { context: args.context, serverVersion: "v1.37.0", defaultNamespace: "demo", auth: args.context.includes("eks") ? { command: "aws eks get-token --cluster-name shop-prd", awsProfile: "prod" } : null };
    case "context_auth":
      return args.context.includes("eks") ? { command: "aws eks get-token --cluster-name shop-prd", awsProfile: "prod" } : null;
    case "list_namespaces":
      return ["default", "demo", "demo2", "kube-system", "monitoring", "payments", "rental"];
    case "watch_resources": {
      // localStorage["kubedeck.mock.unauthorized"] = "1" simulates expired credentials.
      if (localStorage.getItem("kubedeck.mock.unauthorized")) {
        setTimeout(() => send(channel!, { type: "error", message: "demo: Unauthorized (401): the cluster rejected your credentials. They have probably expired.", unauthorized: true }), 150);
        return nextStream++;
      }
      const id = nextStream++;
      const wanted: string[] = args.namespaces ?? [];
      const rows = (ROWS[args.kindKey] ?? []).filter((r) => !r.namespace || wanted.length === 0 || wanted.includes(r.namespace));
      setTimeout(() => send(channel!, { type: "snapshot", rows }), 150);
      return id;
    }
    case "get_yaml":
      return args.kindKey === "pods" ? POD_YAML.replace(/web-7c6cdd646-2zjfg/g, args.name) : YAML.replace(/app-config/g, args.name);
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
    case "open_window":
      window.open(location.href, "_blank");
      return null;
    case "plugin:window|set_title":
      document.title = args.value ?? document.title;
      return null;
    case "check_for_update":
      return { status: "available", version: "0.3.0", notes: "Sample release notes", date: null };
    case "plugin:app|version":
      return "0.2.0";
    case "pod_usage": {
      const multi = args.pod.startsWith("api-");
      const mk = (name: string, cpu: number, mem: number, extra: object = {}) => ({
        name, cpuMillis: cpu, memoryBytes: mem * 1024 ** 2, cpuRequestMillis: 100, cpuLimitMillis: 250,
        memoryRequestBytes: 128 * 1024 ** 2, memoryLimitBytes: 256 * 1024 ** 2, restarts: 0, ready: true, state: "running", lastTermination: null, ...extra,
      });
      const containers = multi
        ? [mk("api", 113 + Math.random() * 20, 69), mk("envoy", 18 + Math.random() * 4, 41, { cpuLimitMillis: null, memoryLimitBytes: null })]
        : args.pod === "broken"
          ? [mk("broken", 0, 0, { restarts: 7, ready: false, state: "waiting: CrashLoopBackOff", lastTermination: `OOMKilled (exit 137) at ${ago(240)}` })]
          : [mk(args.pod.split("-")[0], 150 + Math.random() * 40, 190 + Math.random() * 10, { restarts: 1, lastTermination: `OOMKilled (exit 137) at ${ago(9000)}` })];
      return { metricsServer: true, containers };
    }
    case "prometheus_target":
      return "monitoring/prometheus-server:80";
    case "pod_history": {
      const end = Date.now() / 1000;
      const n = 120;
      const step = (args.minutes * 60) / n;
      const wave = (base: number, amp: number, phase: number, noise: number) =>
        Array.from({ length: n }, (_, i) => [end - (n - i) * step, Math.max(0, base + amp * Math.sin(i / 9 + phase) + (Math.sin(i * 12.9898 + phase) * 43758.5453 % 1) * noise)] as [number, number]);
      const multi = args.pod.startsWith("api-");
      const names = multi ? ["api", "envoy"] : [args.pod.split("-")[0]];
      return {
        source: "monitoring/prometheus-server:80",
        stepSeconds: step,
        cpu: names.map((name, k) => ({ name, points: wave(k ? 0.02 : 0.16, k ? 0.005 : 0.07, k, k ? 0.004 : 0.03) })),
        memory: names.map((name, k) => ({ name, points: wave((k ? 41 : 185) * 1024 ** 2, (k ? 2 : 22) * 1024 ** 2, k + 1, 3 * 1024 ** 2) })),
        network: [
          { name: "receive", points: wave(42_000, 18_000, 0.5, 6000) },
          { name: "transmit", points: wave(18_000, 9000, 1.7, 3000) },
        ],
        throttling: names.map((name, k) => ({ name, points: wave(k ? 0 : 0.12, k ? 0 : 0.1, 2, 0.04) })),
      };
    }
    case "pod_metrics":
      return (ROWS.pods ?? []).filter((r) => !args.namespaces?.length || args.namespaces.includes(r.namespace)).map((r, i) => ({ namespace: r.namespace, name: r.name, cpuMillis: 2 + i * 37, memoryBytes: (6 + i * 21) * 1024 * 1024, cpuAllocatableMillis: null, memoryAllocatableBytes: null }));
    case "node_metrics":
      return [{ namespace: null, name: "kubedeck-test-control-plane", cpuMillis: 412, memoryBytes: 1.8 * 1024 ** 3, cpuAllocatableMillis: 8000, memoryAllocatableBytes: 7.6 * 1024 ** 3 }];
    case "list_port_forwards":
      return forwards;
    case "helm_list":
      return [
        { name: "hello", namespace: "demo", revision: "3", updated: ago(600), status: "deployed", chart: "hello-0.1.0", appVersion: "1.16.0" },
        { name: "ingress-nginx", namespace: "kube-system", revision: "12", updated: ago(86400 * 9), status: "deployed", chart: "ingress-nginx-4.11.3", appVersion: "1.11.3" },
        { name: "broken-upgrade", namespace: "demo", revision: "4", updated: ago(7200), status: "failed", chart: "api-2.3.0", appVersion: "2.3.0" },
      ].filter((r) => !args.namespaces?.length || args.namespaces.includes(r.namespace));
    case "helm_details":
      return { values: "replicaCount: 2\nimage:\n  tag: 1.16.0\n", manifest: "---\n# Source: hello/templates/deployment.yaml\napiVersion: apps/v1\nkind: Deployment\n", notes: "1. Get the application URL by running these commands: ...", history: HISTORY };
    case "helm_repo_list":
      return [{ name: "bitnami", url: "https://charts.bitnami.com/bitnami" }];
    case "helm_search":
      return [
        { name: "bitnami/redis", version: "21.2.3", appVersion: "8.0.2", description: "Redis(R) is an open source, advanced key-value store." },
        { name: "bitnami/postgresql", version: "16.7.4", appVersion: "17.5.0", description: "PostgreSQL (Postgres) is an open source object-relational database." },
        { name: "bitnami/nginx", version: "20.0.5", appVersion: "1.28.0", description: "NGINX Open Source is a web server that can be also used as a reverse proxy." },
      ].filter((c) => c.name.includes(args.query ?? ""));
    case "helm_chart_versions":
      return ["21.2.3", "21.2.2", "21.1.0"].map((version) => ({ name: args.chart, version, appVersion: "8.0.2", description: "" }));
    case "helm_show_values":
      return "## Sample chart values\nreplicaCount: 1\nimage:\n  tag: \"\"\nresources: {}\n";
    case "helm_install":
    case "helm_upgrade":
      return args.request.dryRun ? "NAME: " + args.request.name + "\n---\n# Source: chart/templates/deployment.yaml\napiVersion: apps/v1\nkind: Deployment\n" : "NOTES:\nThanks for installing.";
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
  metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
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
