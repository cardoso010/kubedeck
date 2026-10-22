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

kind get clusters | grep -qx "$CLUSTER" || kind create cluster --name "$CLUSTER" --kubeconfig "$KUBECONFIG" --wait 120s
kind export kubeconfig --name "$CLUSTER" --kubeconfig "$KUBECONFIG" >/dev/null

kubectl create namespace demo --dry-run=client -o yaml | kubectl apply -f -
kubectl -n demo get deployment web >/dev/null 2>&1 || kubectl -n demo create deployment web --image=nginx:1.27-alpine --replicas=3
kubectl -n demo get service web >/dev/null 2>&1 || kubectl -n demo expose deployment web --port=80
kubectl -n demo get configmap app-config >/dev/null 2>&1 || kubectl -n demo create configmap app-config --from-literal=LOG_LEVEL=debug --from-literal=FEATURE_X=true
kubectl -n demo get pod ticker >/dev/null 2>&1 || kubectl -n demo run ticker --image=busybox:1.36 -- sh -c 'i=0; while true; do i=$((i+1)); echo "tick $i $(date)"; sleep 1; done'
kubectl -n demo get pod broken >/dev/null 2>&1 || kubectl -n demo run broken --image=busybox:1.36 -- sh -c 'echo boom; exit 1'
# A pod with requests and limits, for the usage-vs-limits view.
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
echo "kind cluster '$CLUSTER' ready. KUBECONFIG=$KUBECONFIG"
