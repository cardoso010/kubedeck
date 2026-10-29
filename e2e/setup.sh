#!/usr/bin/env bash
# Creates (or completes) the disposable kind cluster the e2e tests run against.
# Safe to re-run. Writes its kubeconfig to .kind-kubeconfig at the repo root, so your
# ~/.kube/config and current context are never touched.
#
#   e2e/setup.sh            # create cluster + fixtures
#   e2e/setup.sh --delete   # remove the cluster
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLUSTER=kubedeck-test
export KUBECONFIG="$ROOT/.kind-kubeconfig"
METRICS_SERVER_VERSION=v0.9.0

if [[ "${1:-}" == "--delete" ]]; then
  kind delete cluster --name "$CLUSTER" --kubeconfig "$KUBECONFIG"
  exit 0
fi

# Two nodes, so draining one can be tested without disturbing everything else.
if ! kind get clusters | grep -qx "$CLUSTER"; then
  kind create cluster --name "$CLUSTER" --kubeconfig "$KUBECONFIG" --wait 120s --config - <<'KIND'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
  - role: worker
KIND
fi
kind export kubeconfig --name "$CLUSTER" --kubeconfig "$KUBECONFIG" >/dev/null
WORKER="$CLUSTER-worker"
if ! kubectl get node "$WORKER" >/dev/null 2>&1; then
  echo "This cluster has no worker node; recreate it: e2e/setup.sh --delete && e2e/setup.sh" >&2
  exit 1
fi
# A test that failed mid-drain may have left the worker cordoned.
kubectl uncordon "$WORKER" >/dev/null
# Let workloads run on the control plane too, so a drained worker leaves room elsewhere.
kubectl taint nodes "$CLUSTER-control-plane" node-role.kubernetes.io/control-plane:NoSchedule- >/dev/null 2>&1 || true

kubectl create namespace demo --dry-run=client -o yaml | kubectl apply -f -
kubectl -n demo get deployment web >/dev/null 2>&1 || kubectl -n demo create deployment web --image=nginx:1.27-alpine --replicas=3
kubectl -n demo get service web >/dev/null 2>&1 || kubectl -n demo expose deployment web --port=80
kubectl -n demo get configmap app-config >/dev/null 2>&1 || kubectl -n demo create configmap app-config --from-literal=LOG_LEVEL=debug --from-literal=FEATURE_X=true
kubectl -n demo get secret app-secret >/dev/null 2>&1 || kubectl -n demo create secret generic app-secret --from-literal=password=hunter2 --from-literal=user=admin
kubectl -n demo get pod ticker >/dev/null 2>&1 || kubectl -n demo run ticker --image=busybox:1.36 -- sh -c 'i=0; while true; do i=$((i+1)); echo "tick $i $(date)"; sleep 1; done'
kubectl -n demo get pod broken >/dev/null 2>&1 || kubectl -n demo run broken --image=busybox:1.36 -- sh -c 'echo boom; exit 1'
# Restarted, scaled and rolled back by the workload test (nothing else uses it).
kubectl -n demo get deployment rollme >/dev/null 2>&1 || kubectl -n demo create deployment rollme --image=nginx:1.27-alpine --replicas=2
# Two replicas that log their own name, for merged workload logs.
kubectl -n demo get deployment chatty >/dev/null 2>&1 || kubectl -n demo create deployment chatty --image=busybox:1.36 --replicas=2 -- sh -c 'while true; do echo "hello from $(hostname)"; sleep 2; done'
# Pinned to the worker, for the drain test (which evicts only this).
kubectl -n demo get deployment drain-me >/dev/null 2>&1 || kubectl -n demo apply -f - <<POD
apiVersion: apps/v1
kind: Deployment
metadata: { name: drain-me }
spec:
  replicas: 1
  selector: { matchLabels: { app: drain-me } }
  template:
    metadata: { labels: { app: drain-me } }
    spec:
      nodeSelector: { kubernetes.io/hostname: $WORKER }
      containers: [{ name: app, image: "busybox:1.36", command: ["sleep", "infinity"] }]
POD
# Problems for the Problems view: out of memory, and an image that does not exist.
kubectl -n demo get pod oom >/dev/null 2>&1 || kubectl -n demo apply -f - <<'POD'
apiVersion: v1
kind: Pod
metadata: { name: oom }
spec:
  containers:
    - name: app
      image: busybox:1.36
      command: ["sh", "-c", "head -c 300m /dev/zero | tail"]
      resources: { limits: { memory: 32Mi } }
POD
kubectl -n demo get deployment bad-image >/dev/null 2>&1 || kubectl -n demo create deployment bad-image --image=registry.invalid/kubedeck/nope:1
# A pod with requests and limits, for the usage-vs-limits view.
# A volume that reports usage: local-path's "local" type (its default hostPath volumes are
# not measured by the kubelet), mounted by a pod that writes 50 MB.
kubectl -n demo get pod writer >/dev/null 2>&1 || kubectl -n demo apply -f - <<'PVC'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data
  annotations: { volumeType: local }
spec:
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 1Gi } }
---
apiVersion: v1
kind: Pod
metadata:
  name: writer
spec:
  containers:
    - name: writer
      image: busybox:1.36
      command: ["sh", "-c", "dd if=/dev/zero of=/data/fill bs=1M count=50; sleep infinity"]
      volumeMounts: [{ name: data, mountPath: /data }]
  volumes:
    - name: data
      persistentVolumeClaim: { claimName: data }
PVC
kubectl -n demo get pod limited >/dev/null 2>&1 || kubectl -n demo apply -f - <<'POD'
apiVersion: v1
kind: Pod
metadata:
  name: limited
spec:
  containers:
    - name: app
      image: busybox:1.36
      command: ["sh", "-c", "while true; do :; done"]
      env:
        - { name: API_TOKEN, value: do-not-send-this }
      resources:
        requests: { cpu: 10m, memory: 16Mi }
        limits: { cpu: 50m, memory: 64Mi }
POD
# A second namespace, for multi-namespace views.
kubectl create namespace demo2 --dry-run=client -o yaml | kubectl apply -f -
kubectl -n demo2 get deployment worker >/dev/null 2>&1 || kubectl -n demo2 create deployment worker --image=busybox:1.36 --replicas=2 -- sleep infinity
kubectl apply -f "$ROOT/e2e/widgets-crd.yaml" >/dev/null 2>&1 || { sleep 3; kubectl apply -f "$ROOT/e2e/widgets-crd.yaml"; }

# Helm release with two revisions, for the history and rollback tests.
HELM="${KUBEDECK_HELM:-$(ls "$ROOT"/src-tauri/binaries/helm-* 2>/dev/null | grep -v '\.version$' | head -1)}"
HELM="${HELM:-helm}"
if ! "$HELM" status hello -n demo >/dev/null 2>&1; then
  chart="$(mktemp -d)/hello"
  "$HELM" create "$chart" >/dev/null
  "$HELM" install hello "$chart" -n demo --wait --timeout 3m
  "$HELM" upgrade hello "$chart" -n demo --set replicaCount=2 --wait --timeout 3m
  rm -rf "$(dirname "$chart")"
fi

# metrics-server; kind's kubelets use self-signed certificates.
if ! kubectl -n kube-system get deployment metrics-server >/dev/null 2>&1; then
  kubectl apply -f "https://github.com/kubernetes-sigs/metrics-server/releases/download/$METRICS_SERVER_VERSION/components.yaml"
  kubectl -n kube-system patch deployment metrics-server --type=json \
    -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
fi

# A second context that logs in through an exec plugin (e2e/auth-plugin.sh) handing out the
# token in e2e/.auth-token, so the tests can revoke and renew its credentials: what an expired
# AWS session looks like to the app.
touch "$ROOT/e2e/.auth-token"
kubectl config set-credentials kubedeck-auth --exec-api-version=client.authentication.k8s.io/v1beta1 --exec-command="$ROOT/e2e/auth-plugin.sh" >/dev/null
kubectl config set-context kind-kubedeck-auth --cluster="kind-$CLUSTER" --user=kubedeck-auth >/dev/null

# A minimal Prometheus (server only, 10s scrapes) for the pod metrics history.
PROMETHEUS_CHART_VERSION=29.37.1
if ! "$HELM" status prometheus -n monitoring >/dev/null 2>&1; then
  "$HELM" install prometheus oci://ghcr.io/prometheus-community/charts/prometheus --version "$PROMETHEUS_CHART_VERSION" \
    -n monitoring --create-namespace \
    --set alertmanager.enabled=false --set prometheus-pushgateway.enabled=false \
    --set prometheus-node-exporter.enabled=false --set kube-state-metrics.enabled=false \
    --set server.persistentVolume.enabled=false --set server.global.scrape_interval=10s \
    --wait --timeout 5m
fi

kubectl -n demo rollout status deployment/web --timeout=180s
kubectl -n demo rollout status deployment/chatty --timeout=180s
kubectl -n demo rollout status deployment/drain-me --timeout=180s
kubectl -n demo rollout status deployment/rollme --timeout=180s
kubectl -n demo2 rollout status deployment/worker --timeout=180s
kubectl -n kube-system rollout status deployment/metrics-server --timeout=180s
echo "Waiting for the first metrics..."
for _ in $(seq 1 60); do
  kubectl top pod limited -n demo >/dev/null 2>&1 && break
  sleep 3
done
echo "Waiting for Prometheus to have pod samples..."
for _ in $(seq 1 60); do
  # A few throttling samples of the limited pod, so rates over them exist.
  kubectl get --raw "/api/v1/namespaces/monitoring/services/prometheus-server:80/proxy/api/v1/query?query=count_over_time(container_cpu_cfs_throttled_periods_total%7Bnamespace%3D%22demo%22%2Cpod%3D%22limited%22%7D%5B2m%5D)%3E%3D4" 2>/dev/null | grep -q '"value"' && break
  sleep 3
done
echo "Waiting for Prometheus to have volume samples..."
for _ in $(seq 1 60); do
  kubectl get --raw "/api/v1/namespaces/monitoring/services/prometheus-server:80/proxy/api/v1/query?query=kubelet_volume_stats_used_bytes%7Bnamespace%3D%22demo%22%2Cpersistentvolumeclaim%3D%22data%22%7D" 2>/dev/null | grep -q '"value"' && break
  sleep 3
done
echo "kind cluster '$CLUSTER' ready. KUBECONFIG=$KUBECONFIG"
