//! Rightsizing: what each workload's containers request against what they actually use, so
//! over- and under-provisioned requests stand out. Usage comes from Prometheus (95th
//! percentile CPU and peak memory over 24 hours) when the cluster has one, otherwise from
//! metrics-server (the current moment only).

use std::collections::{BTreeMap, HashMap};

use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, ApiResource, DynamicObject, GroupVersionKind, ListParams};
use kube::Client;
use serde::Serialize;
use serde_json::Value;

use crate::metrics::quantity;
use crate::pod_insights::{prom_get, prometheus};
use crate::state::{kube_err, CmdResult, Session};

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RightsizeRow {
    namespace: String,
    /// Kind key of the owning workload ("deployments", …) or "pods" for bare pods.
    kind_key: String,
    workload: String,
    container: String,
    pods: usize,
    cpu_request_millis: Option<f64>,
    cpu_limit_millis: Option<f64>,
    /// Highest usage among the workload's pods (p95 over 24h with Prometheus).
    cpu_usage_millis: Option<f64>,
    memory_request_bytes: Option<f64>,
    memory_limit_bytes: Option<f64>,
    /// Highest usage among the workload's pods (peak over 24h with Prometheus).
    memory_usage_bytes: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rightsizing {
    /// Where usage comes from and over which period, for the UI to say.
    source: String,
    rows: Vec<RightsizeRow>,
}

type Usage = HashMap<(String, String, String), (Option<f64>, Option<f64>)>;

/// Owning workload of a pod: ReplicaSets are traced to their Deployment by the
/// pod-template-hash suffix, which the Deployment controller always adds.
fn owner(pod: &Pod) -> (String, String) {
    let name = pod.metadata.name.clone().unwrap_or_default();
    let Some(o) = pod.metadata.owner_references.iter().flatten().find(|o| o.controller == Some(true)) else {
        return ("pods".into(), name);
    };
    match o.kind.as_str() {
        "ReplicaSet" => {
            let hash = pod.metadata.labels.as_ref().and_then(|l| l.get("pod-template-hash"));
            match hash.and_then(|h| o.name.strip_suffix(&format!("-{h}"))) {
                Some(deployment) => ("deployments".into(), deployment.into()),
                None => ("pods".into(), name),
            }
        }
        "StatefulSet" => ("statefulsets".into(), o.name.clone()),
        "DaemonSet" => ("daemonsets".into(), o.name.clone()),
        "Job" => ("jobs".into(), o.name.clone()),
        _ => ("pods".into(), name),
    }
}

async fn from_prometheus(state: &Session, namespaces: &[String]) -> Option<(String, Usage)> {
    let (client, target) = prometheus(state).await.ok()?;
    let target = target?;
    // Namespace names are DNS labels: safe inside a regex alternation.
    let ns = if namespaces.is_empty() { ".+".to_owned() } else { namespaces.join("|") };
    let sel = format!(r#"namespace=~"{ns}",container!="",container!="POD""#);
    let cpu = format!("quantile_over_time(0.95, sum by (namespace, pod, container) (rate(container_cpu_usage_seconds_total{{{sel}}}[5m]))[24h:5m])");
    let memory = format!("max by (namespace, pod, container) (max_over_time(container_memory_working_set_bytes{{{sel}}}[24h]))");
    let query = |q: String| {
        let (client, target) = (client.clone(), target.clone());
        async move { prom_get(&client, &target, "/api/v1/query", &[("query", q)]).await }
    };
    let (cpu, memory) = tokio::join!(query(cpu), query(memory));
    let (cpu, memory) = (cpu.ok()?, memory.ok()?);
    let mut usage: Usage = HashMap::new();
    let mut read = |data: &Value, is_cpu: bool| {
        for r in data["result"].as_array().into_iter().flatten() {
            let m = &r["metric"];
            let key = (m["namespace"].as_str().unwrap_or_default().to_owned(), m["pod"].as_str().unwrap_or_default().to_owned(), m["container"].as_str().unwrap_or_default().to_owned());
            let Some(v) = r["value"][1].as_str().and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite()) else { continue };
            let entry = usage.entry(key).or_default();
            if is_cpu {
                entry.0 = Some(v * 1000.0);
            } else {
                entry.1 = Some(v);
            }
        }
    };
    read(&cpu, true);
    read(&memory, false);
    // An empty answer means the metrics are not there (e.g. no cAdvisor scraping).
    if usage.is_empty() {
        return None;
    }
    Some((format!("Prometheus {} · CPU p95 and peak memory over 24h", target.label()), usage))
}

async fn from_metrics_server(client: &Client, namespaces: &[String]) -> Usage {
    let ar = ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk("metrics.k8s.io", "v1beta1", "PodMetrics"), "pods");
    let scopes: Vec<Api<DynamicObject>> = if namespaces.is_empty() {
        vec![Api::all_with(client.clone(), &ar)]
    } else {
        namespaces.iter().map(|ns| Api::namespaced_with(client.clone(), ns, &ar)).collect()
    };
    let lp = ListParams::default();
    let lists = futures::future::join_all(scopes.iter().map(|api| api.list(&lp))).await;
    let mut usage: Usage = HashMap::new();
    for item in lists.into_iter().flat_map(|l| l.map(|l| l.items).unwrap_or_default()) {
        let ns = item.metadata.namespace.clone().unwrap_or_default();
        let pod = item.metadata.name.clone().unwrap_or_default();
        for c in item.data["containers"].as_array().into_iter().flatten() {
            let cpu = c.pointer("/usage/cpu").map(|v| quantity(v) * 1000.0);
            let mem = c.pointer("/usage/memory").map(quantity);
            usage.insert((ns.clone(), pod.clone(), c["name"].as_str().unwrap_or_default().to_owned()), (cpu, mem));
        }
    }
    usage
}

/// Requests, limits and usage per workload container in `namespaces` (all when empty).
#[tauri::command]
pub async fn rightsizing(namespaces: Vec<String>, state: Session) -> CmdResult<Rightsizing> {
    let client = state.connection().await?.client;
    let lp = ListParams::default().fields("status.phase=Running");
    let pods: Vec<Pod> = if namespaces.is_empty() {
        Api::<Pod>::all(client.clone()).list(&lp).await.map_err(|e| kube_err(&e))?.items
    } else {
        let lists = futures::future::join_all(namespaces.iter().map(|ns| {
            let api = Api::<Pod>::namespaced(client.clone(), ns);
            let lp = lp.clone();
            async move { api.list(&lp).await }
        }))
        .await;
        let mut pods = Vec::new();
        for list in lists {
            pods.extend(list.map_err(|e| kube_err(&e))?.items);
        }
        pods
    };

    let (source, usage) = match from_prometheus(&state, &namespaces).await {
        Some(found) => found,
        None => ("metrics-server · current usage only (no Prometheus history)".to_owned(), from_metrics_server(&client, &namespaces).await),
    };

    let mut rows: BTreeMap<(String, String, String, String), RightsizeRow> = BTreeMap::new();
    for pod in &pods {
        let ns = pod.metadata.namespace.clone().unwrap_or_default();
        let pod_name = pod.metadata.name.clone().unwrap_or_default();
        let (kind_key, workload) = owner(pod);
        for c in pod.spec.iter().flat_map(|s| s.containers.iter()) {
            let resources = c.resources.as_ref();
            let get = |which: Option<&BTreeMap<String, k8s_openapi::apimachinery::pkg::api::resource::Quantity>>, key: &str| {
                which.and_then(|m| m.get(key)).map(|q| quantity(&Value::String(q.0.clone())))
            };
            let requests = resources.and_then(|r| r.requests.as_ref());
            let limits = resources.and_then(|r| r.limits.as_ref());
            let row = rows.entry((ns.clone(), kind_key.clone(), workload.clone(), c.name.clone())).or_insert_with(|| RightsizeRow {
                namespace: ns.clone(),
                kind_key: kind_key.clone(),
                workload: workload.clone(),
                container: c.name.clone(),
                cpu_request_millis: get(requests, "cpu").map(|v| v * 1000.0),
                cpu_limit_millis: get(limits, "cpu").map(|v| v * 1000.0),
                memory_request_bytes: get(requests, "memory"),
                memory_limit_bytes: get(limits, "memory"),
                ..Default::default()
            });
            row.pods += 1;
            if let Some(&(cpu, mem)) = usage.get(&(ns.clone(), pod_name.clone(), c.name.clone())) {
                row.cpu_usage_millis = max(row.cpu_usage_millis, cpu);
                row.memory_usage_bytes = max(row.memory_usage_bytes, mem);
            }
        }
    }
    Ok(Rightsizing { source, rows: rows.into_values().collect() })
}

fn max(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pod(owner_kind: Option<&str>, owner_name: &str, hash: Option<&str>) -> Pod {
        serde_json::from_value(serde_json::json!({
            "metadata": {
                "name": "p-1",
                "labels": hash.map(|h| serde_json::json!({ "pod-template-hash": h })).unwrap_or(serde_json::json!({})),
                "ownerReferences": owner_kind.map(|k| serde_json::json!([{ "apiVersion": "apps/v1", "kind": k, "name": owner_name, "uid": "u", "controller": true }])).unwrap_or(serde_json::json!([])),
            }
        }))
        .unwrap()
    }

    #[test]
    fn traces_pods_to_their_workload() {
        assert_eq!(owner(&pod(Some("ReplicaSet"), "web-7c6cdd646", Some("7c6cdd646"))), ("deployments".into(), "web".into()));
        assert_eq!(owner(&pod(Some("ReplicaSet"), "plain-rs", None)), ("pods".into(), "p-1".into()));
        assert_eq!(owner(&pod(Some("StatefulSet"), "db", None)), ("statefulsets".into(), "db".into()));
        assert_eq!(owner(&pod(None, "", None)), ("pods".into(), "p-1".into()));
    }
}
