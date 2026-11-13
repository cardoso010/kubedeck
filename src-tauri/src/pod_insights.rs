//! Per-pod metrics for the details drawer: current usage against requests and limits
//! (metrics-server plus the pod itself), and history from the cluster's Prometheus.

use std::collections::BTreeMap;

use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, ApiResource, DynamicObject, GroupVersionKind};
use kube::Client;
use serde::Serialize;
use serde_json::Value;

use crate::metrics::quantity;
use crate::prometheus::{prom_get, prometheus, series, Series};
use crate::state::{err, CmdResult, Session};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ContainerUsage {
    name: String,
    /// A native sidecar (init container with restartPolicy Always) rather than an app container.
    sidecar: bool,
    /// None when metrics-server has no sample for it (not installed, or the container just started).
    cpu_millis: Option<f64>,
    memory_bytes: Option<f64>,
    cpu_request_millis: Option<f64>,
    cpu_limit_millis: Option<f64>,
    memory_request_bytes: Option<f64>,
    memory_limit_bytes: Option<f64>,
    restarts: i32,
    ready: bool,
    /// running, waiting (with reason) or terminated (with reason).
    state: String,
    /// Why the previous run ended, e.g. "OOMKilled (exit 137) at 2026-10-22T12:00:00Z".
    last_termination: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodUsage {
    metrics_server: bool,
    containers: Vec<ContainerUsage>,
    /// Devices (GPUs and the like) the pod claims through Dynamic Resource Allocation.
    devices: Vec<DeviceClaim>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceClaim {
    /// The claim's name in the pod spec.
    name: String,
    /// The ResourceClaim object, once there is one (templates create it with the pod).
    claim: Option<String>,
    allocated: bool,
    /// Allocated devices as driver/pool/device.
    devices: Vec<String>,
}

/// What a ResourceClaim (resource.k8s.io/v1) was given, read as JSON so clusters without
/// the API (before Kubernetes 1.34) or with another version cost nothing.
fn allocated_devices(claim: &Value) -> Option<Vec<String>> {
    let results = claim.pointer("/status/allocation/devices/results")?.as_array()?;
    Some(
        results
            .iter()
            .map(|r| ["driver", "pool", "device"].iter().map(|k| r[k].as_str().unwrap_or("?")).collect::<Vec<_>>().join("/"))
            .collect(),
    )
}

async fn device_claims(client: &Client, pod: &Pod) -> Vec<DeviceClaim> {
    let Some(claims) = pod.spec.as_ref().and_then(|s| s.resource_claims.as_ref()).filter(|c| !c.is_empty()) else {
        return Vec::new();
    };
    let namespace = pod.metadata.namespace.clone().unwrap_or_default();
    let statuses = pod.status.as_ref().and_then(|s| s.resource_claim_statuses.clone()).unwrap_or_default();
    let ar = ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk("resource.k8s.io", "v1", "ResourceClaim"), "resourceclaims");
    let api = Api::<DynamicObject>::namespaced_with(client.clone(), &namespace, &ar);
    let mut out = Vec::new();
    for c in claims {
        // A claim from a template gets a generated name, reported in the pod's status.
        let claim = c.resource_claim_name.clone().or_else(|| statuses.iter().find(|s| s.name == c.name).and_then(|s| s.resource_claim_name.clone()));
        let devices = match &claim {
            Some(name) => api.get(name).await.ok().and_then(|o| serde_json::to_value(o).ok()).and_then(|v| allocated_devices(&v)),
            None => None,
        };
        out.push(DeviceClaim { name: c.name.clone(), claim, allocated: devices.is_some(), devices: devices.unwrap_or_default() });
    }
    out
}

/// Current usage of each container, with its requests, limits, restarts and last termination.
#[tauri::command]
pub async fn pod_usage(namespace: String, pod: String, state: Session) -> CmdResult<PodUsage> {
    let client = state.connection().await?.client;
    let spec_pod = Api::<Pod>::namespaced(client.clone(), &namespace).get(&pod).await?;

    let ar = ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk("metrics.k8s.io", "v1beta1", "PodMetrics"), "pods");
    let metrics = Api::<DynamicObject>::namespaced_with(client.clone(), &namespace, &ar).get(&pod).await.ok();
    let usage: BTreeMap<String, (f64, f64)> = metrics
        .as_ref()
        .and_then(|m| m.data["containers"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|c| {
            let name = c["name"].as_str()?.to_owned();
            Some((name, (quantity(&c["usage"]["cpu"]) * 1000.0, quantity(&c["usage"]["memory"]))))
        })
        .collect();

    let status = spec_pod.status.clone().unwrap_or_default();
    let statuses: Vec<_> = status.container_statuses.into_iter().flatten().chain(status.init_container_statuses.into_iter().flatten()).collect();
    let containers = spec_pod
        .spec
        .iter()
        .flat_map(crate::rightsizing::running_containers)
        .map(|(c, sidecar)| {
            let resources = c.resources.as_ref();
            let get = |map: Option<&BTreeMap<String, k8s_openapi::apimachinery::pkg::api::resource::Quantity>>, key: &str| {
                map.and_then(|m| m.get(key)).map(|q| quantity(&Value::String(q.0.clone())))
            };
            let requests = resources.and_then(|r| r.requests.as_ref());
            let limits = resources.and_then(|r| r.limits.as_ref());
            let status = statuses.iter().find(|s| s.name == c.name);
            let current = status.and_then(|s| s.state.as_ref());
            let state = match current {
                Some(s) if s.running.is_some() => "running".to_owned(),
                Some(s) if s.waiting.is_some() => format!("waiting: {}", s.waiting.as_ref().and_then(|w| w.reason.clone()).unwrap_or_default()),
                Some(s) if s.terminated.is_some() => format!("terminated: {}", s.terminated.as_ref().and_then(|t| t.reason.clone()).unwrap_or_default()),
                _ => "unknown".to_owned(),
            };
            let last_termination = status.and_then(|s| s.last_state.as_ref()).and_then(|l| l.terminated.as_ref()).map(|t| {
                let when = t.finished_at.as_ref().and_then(|f| serde_json::to_value(f).ok()).and_then(|v| v.as_str().map(str::to_owned));
                format!(
                    "{} (exit {}){}",
                    t.reason.clone().unwrap_or_else(|| "Terminated".into()),
                    t.exit_code,
                    when.map(|w| format!(" at {w}")).unwrap_or_default()
                )
            });
            ContainerUsage {
                name: c.name.clone(),
                sidecar,
                cpu_millis: usage.get(&c.name).map(|u| u.0),
                memory_bytes: usage.get(&c.name).map(|u| u.1),
                cpu_request_millis: get(requests, "cpu").map(|v| v * 1000.0),
                cpu_limit_millis: get(limits, "cpu").map(|v| v * 1000.0),
                memory_request_bytes: get(requests, "memory"),
                memory_limit_bytes: get(limits, "memory"),
                restarts: status.map(|s| s.restart_count).unwrap_or(0),
                ready: status.map(|s| s.ready).unwrap_or(false),
                state,
                last_termination,
            }
        })
        .collect();
    let devices = device_claims(&client, &spec_pod).await;
    Ok(PodUsage { metrics_server: metrics.is_some(), containers, devices })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodHistory {
    source: String,
    step_seconds: u64,
    /// Cores.
    cpu: Vec<Series>,
    /// Working-set bytes, what the OOM killer looks at.
    memory: Vec<Series>,
    /// Bytes per second.
    network: Vec<Series>,
    /// Fraction of CFS periods throttled, 0..1.
    throttling: Vec<Series>,
}

/// Pod history over the last `minutes`, per container where it applies.
#[tauri::command]
pub async fn pod_history(namespace: String, pod: String, minutes: u64, state: Session) -> CmdResult<PodHistory> {
    let (client, target) = prometheus(&state).await?;
    let target = target.ok_or("No Prometheus found in this cluster")?;
    let minutes = minutes.clamp(5, 7 * 24 * 60);
    // ~120 points per chart; never below the 10–15s scrape interval.
    let step = (minutes * 60 / 120).max(15);
    let window = format!("{}s", (step * 4).max(60));
    let end = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(err)?.as_secs();
    let start = end - minutes * 60;

    // Namespace and pod names are DNS labels, so they need no escaping in PromQL.
    let sel = format!(r#"namespace="{namespace}",pod="{pod}""#);
    let containers = format!(r#"{sel},container!="",container!="POD""#);
    let queries = [
        format!("sum by (container) (rate(container_cpu_usage_seconds_total{{{containers}}}[{window}]))"),
        format!("sum by (container) (container_memory_working_set_bytes{{{containers}}})"),
        format!(r#"label_replace(sum(rate(container_network_receive_bytes_total{{{sel}}}[{window}])), "container", "receive", "", "")"#),
        format!(r#"label_replace(sum(rate(container_network_transmit_bytes_total{{{sel}}}[{window}])), "container", "transmit", "", "")"#),
        format!(
            "sum by (container) (rate(container_cpu_cfs_throttled_periods_total{{{containers}}}[{window}])) / sum by (container) (rate(container_cpu_cfs_periods_total{{{containers}}}[{window}]))"
        ),
    ];
    let range = |q: String| {
        let (client, target) = (client.clone(), target.clone());
        async move {
            let params = [("query", q), ("start", start.to_string()), ("end", end.to_string()), ("step", step.to_string())];
            prom_get(&client, &target, "/api/v1/query_range", &params).await
        }
    };
    let [cpu, memory, rx, tx, throttling] = queries;
    let (cpu, memory, rx, tx, throttling) = tokio::join!(range(cpu), range(memory), range(rx), range(tx), range(throttling));

    let mut network = series(&rx?);
    network.extend(series(&tx?));
    Ok(PodHistory {
        source: target.label(),
        step_seconds: step,
        cpu: series(&cpu?),
        memory: series(&memory?),
        network,
        // Not every runtime exports CFS counters; an empty chart is better than an error.
        throttling: throttling.map(|d| series(&d)).unwrap_or_default(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeHistory {
    source: String,
    cpu: Vec<Series>,
    memory: Vec<Series>,
}

/// CPU (cores) and memory (working set) of a whole node over the last `minutes`, from the
/// root cgroup. Different Prometheus setups name the node in different labels; try each.
#[tauri::command]
pub async fn node_history(name: String, minutes: u64, state: Session) -> CmdResult<NodeHistory> {
    let (client, target) = prometheus(&state).await?;
    let target = target.ok_or("No Prometheus found in this cluster")?;
    let minutes = minutes.clamp(5, 7 * 24 * 60);
    let step = (minutes * 60 / 120).max(15);
    let window = format!("{}s", (step * 4).max(60));
    let end = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(err)?.as_secs();
    let start = end - minutes * 60;
    let either = |metric: &str, rate: bool| {
        ["node", "instance", "kubernetes_io_hostname"]
            .iter()
            .map(|label| {
                let sel = format!(r#"{metric}{{id="/",{label}="{name}"}}"#);
                if rate { format!("sum(rate({sel}[{window}]))") } else { format!("sum({sel})") }
            })
            .collect::<Vec<_>>()
            .join(" or ")
    };
    let range = |q: String| {
        let (client, target) = (client.clone(), target.clone());
        async move {
            let params = [("query", q), ("start", start.to_string()), ("end", end.to_string()), ("step", step.to_string())];
            prom_get(&client, &target, "/api/v1/query_range", &params).await
        }
    };
    let (cpu, memory) = tokio::join!(range(either("container_cpu_usage_seconds_total", true)), range(either("container_memory_working_set_bytes", false)));
    let named = |data: Value, label: &str| {
        let mut list = series(&data);
        list.iter_mut().for_each(|s| s.name = label.to_owned());
        list
    };
    Ok(NodeHistory { source: target.label(), cpu: named(cpu?, "node"), memory: named(memory?, "node") })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_allocated_devices() {
        let claim = json!({ "status": { "allocation": { "devices": { "results": [
            { "request": "gpu", "driver": "gpu.nvidia.com", "pool": "node-1", "device": "gpu-0" },
            { "request": "gpu", "driver": "gpu.nvidia.com", "pool": "node-1", "device": "gpu-1" }
        ] } } } });
        assert_eq!(allocated_devices(&claim), Some(vec!["gpu.nvidia.com/node-1/gpu-0".to_owned(), "gpu.nvidia.com/node-1/gpu-1".to_owned()]));
        assert_eq!(allocated_devices(&json!({ "status": {} })), None, "not allocated yet");
    }
}
