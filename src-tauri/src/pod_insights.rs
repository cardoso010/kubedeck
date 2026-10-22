//! Per-pod metrics for the details drawer: current usage against requests and limits
//! (metrics-server plus the pod itself), and history from the cluster's Prometheus.
//!
//! Prometheus is reached through the API server's service proxy with the user's own
//! credentials, so it needs no port forward or extra configuration. It is found by looking
//! for the usual service names, or set with `KUBEDECK_PROMETHEUS=namespace/service:port`.

use std::collections::BTreeMap;

use k8s_openapi::api::core::v1::{Pod, Service};
use kube::api::{Api, ApiResource, DynamicObject, GroupVersionKind, ListParams};
use kube::Client;
use serde::Serialize;
use serde_json::Value;

use crate::metrics::quantity;
use crate::state::{err, CmdResult, Session};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ContainerUsage {
    name: String,
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
}

/// Current usage of each container, with its requests, limits, restarts and last termination.
#[tauri::command]
pub async fn pod_usage(namespace: String, pod: String, state: Session) -> CmdResult<PodUsage> {
    let client = state.connection().await?.client;
    let spec_pod = Api::<Pod>::namespaced(client.clone(), &namespace).get(&pod).await.map_err(err)?;

    let ar = ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk("metrics.k8s.io", "v1beta1", "PodMetrics"), "pods");
    let metrics = Api::<DynamicObject>::namespaced_with(client, &namespace, &ar).get(&pod).await.ok();
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

    let statuses = spec_pod.status.as_ref().and_then(|s| s.container_statuses.clone()).unwrap_or_default();
    let containers = spec_pod
        .spec
        .iter()
        .flat_map(|s| &s.containers)
        .map(|c| {
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
    Ok(PodUsage { metrics_server: metrics.is_some(), containers })
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PromTarget {
    namespace: String,
    service: String,
    port: String,
}

impl PromTarget {
    fn proxy_path(&self, api: &str) -> String {
        format!("/api/v1/namespaces/{}/services/{}:{}/proxy{api}", self.namespace, self.service, self.port)
    }

    pub fn label(&self) -> String {
        format!("{}/{}:{}", self.namespace, self.service, self.port)
    }
}

/// Service names that usually front Prometheus (community chart, operator, kube-prometheus-stack).
const KNOWN_NAMES: &[&str] = &["prometheus-server", "prometheus-operated", "prometheus-k8s", "kube-prometheus-stack-prometheus", "prometheus"];
const NOT_PROMETHEUS: &[&str] = &["alertmanager", "node-exporter", "pushgateway", "operator", "kube-state", "adapter", "blackbox", "thanos-sidecar"];

/// Candidates in order of likelihood: known names first, then anything that looks like one.
fn candidates(services: &[Service]) -> Vec<PromTarget> {
    let mut found: Vec<(usize, PromTarget)> = services
        .iter()
        .filter_map(|svc| {
            let name = svc.metadata.name.clone()?;
            let rank = KNOWN_NAMES.iter().position(|k| *k == name).or_else(|| {
                (name.contains("prometheus") && !NOT_PROMETHEUS.iter().any(|n| name.contains(n))).then_some(KNOWN_NAMES.len())
            })?;
            let ports = svc.spec.as_ref()?.ports.clone().unwrap_or_default();
            let port = ports
                .iter()
                .find(|p| matches!(p.name.as_deref(), Some("http-web" | "web" | "http")))
                .or_else(|| ports.iter().find(|p| p.port == 9090))
                .or_else(|| ports.first())?;
            Some((rank, PromTarget { namespace: svc.metadata.namespace.clone()?, service: name, port: port.port.to_string() }))
        })
        .collect();
    found.sort_by_key(|(rank, t)| (*rank, t.namespace.clone()));
    found.into_iter().map(|(_, t)| t).collect()
}

pub(crate) async fn prom_get(client: &Client, target: &PromTarget, api: &str, params: &[(&str, String)]) -> Result<Value, String> {
    let query = form_urlencoded::Serializer::new(String::new()).extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str()))).finish();
    let request = http::Request::get(format!("{}?{query}", target.proxy_path(api))).body(Vec::new()).map_err(err)?;
    let text = client.request_text(request).await.map_err(err)?;
    let json: Value = serde_json::from_str(&text).map_err(|_| "Prometheus returned something that is not JSON".to_owned())?;
    if json["status"] != "success" {
        return Err(json["error"].as_str().unwrap_or("Prometheus query failed").to_owned());
    }
    Ok(json["data"].clone())
}

async fn detect(client: &Client) -> Option<PromTarget> {
    let configured = std::env::var("KUBEDECK_PROMETHEUS").ok().and_then(|v| {
        let (namespace, rest) = v.split_once('/')?;
        let (service, port) = rest.split_once(':').unwrap_or((rest, "9090"));
        Some(PromTarget { namespace: namespace.into(), service: service.into(), port: port.into() })
    });
    let list = match configured {
        Some(t) => vec![t],
        // Listing services cluster-wide may be forbidden; then there is no history.
        None => candidates(&Api::<Service>::all(client.clone()).list(&ListParams::default()).await.ok()?.items),
    };
    for target in list {
        if prom_get(client, &target, "/api/v1/query", &[("query", "vector(1)".into())]).await.is_ok() {
            return Some(target);
        }
    }
    None
}

pub(crate) async fn prometheus(state: &Session) -> CmdResult<(Client, Option<PromTarget>)> {
    let conn = state.connection().await?;
    let target = conn.prometheus.get_or_init(|| detect(&conn.client)).await.clone();
    Ok((conn.client, target))
}

/// The Prometheus this cluster's history comes from, as "namespace/service:port".
#[tauri::command]
pub async fn prometheus_target(state: Session) -> CmdResult<Option<String>> {
    Ok(prometheus(&state).await?.1.map(|t| t.label()))
}

#[derive(Serialize)]
pub struct Series {
    /// Container name, or what the series measures ("receive", "transmit").
    name: String,
    /// [unix seconds, value] pairs.
    points: Vec<(f64, f64)>,
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

/// Reads a Prometheus matrix result.
fn series(data: &Value) -> Vec<Series> {
    let mut out: Vec<Series> = data["result"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|r| Series {
            name: r["metric"]["container"].as_str().unwrap_or("pod").to_owned(),
            points: r["values"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|p| Some((p[0].as_f64()?, p[1].as_str()?.parse::<f64>().ok().filter(|v| v.is_finite())?)))
                .collect(),
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn service(namespace: &str, name: &str, ports: Value) -> Service {
        serde_json::from_value(json!({ "metadata": { "name": name, "namespace": namespace }, "spec": { "ports": ports } })).unwrap()
    }

    #[test]
    fn finds_prometheus_services_in_order_of_likelihood() {
        let services = [
            service("monitoring", "kube-prometheus-stack-alertmanager", json!([{ "name": "http-web", "port": 9093 }])),
            service("monitoring", "my-prometheus", json!([{ "port": 9090 }])),
            service("monitoring", "prometheus-operated", json!([{ "name": "web", "port": 9090 }])),
            service("default", "kubernetes", json!([{ "port": 443 }])),
        ];
        let found = candidates(&services);
        assert_eq!(found.len(), 2, "{found:?}");
        assert_eq!(found[0], PromTarget { namespace: "monitoring".into(), service: "prometheus-operated".into(), port: "9090".into() });
        assert_eq!(found[1].service, "my-prometheus");
        assert_eq!(found[0].proxy_path("/api/v1/query"), "/api/v1/namespaces/monitoring/services/prometheus-operated:9090/proxy/api/v1/query");
    }

    #[test]
    fn reads_matrix_results() {
        let data = json!({ "result": [
            { "metric": { "container": "web" }, "values": [[100.0, "0.5"], [115.0, "NaN"], [130.0, "0.25"]] },
            { "metric": {}, "values": [[100.0, "1"]] }
        ]});
        let s = series(&data);
        assert_eq!(s[0].name, "pod");
        assert_eq!(s[1].name, "web");
        assert_eq!(s[1].points, vec![(100.0, 0.5), (130.0, 0.25)], "NaN samples are dropped");
    }
}
