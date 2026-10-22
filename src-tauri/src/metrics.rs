//! CPU and memory usage from the metrics API (metrics-server).

use k8s_openapi::api::core::v1::Node;
use kube::api::{Api, ApiResource, DynamicObject, GroupVersionKind, ListParams};
use kube::Client;
use serde::Serialize;
use serde_json::Value;

use crate::state::{CmdResult, Session};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    namespace: Option<String>,
    name: String,
    cpu_millis: f64,
    memory_bytes: f64,
    /// Nodes only: allocatable capacity, to show usage as a percentage.
    cpu_allocatable_millis: Option<f64>,
    memory_allocatable_bytes: Option<f64>,
}

fn metrics_api(client: Client, plural: &str, kind: &str, namespace: Option<&str>) -> Api<DynamicObject> {
    let ar = ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk("metrics.k8s.io", "v1beta1", kind), plural);
    match namespace {
        Some(ns) => Api::namespaced_with(client, ns, &ar),
        None => Api::all_with(client, &ar),
    }
}

/// Clusters without metrics-server answer 404; the UI then simply hides the columns.
fn metrics_error(e: kube::Error) -> String {
    match e {
        kube::Error::Api(ref s) if s.code == 404 || s.code == 503 => "metrics-unavailable".into(),
        other => other.to_string(),
    }
}

/// Pod usage in `namespaces` (every namespace when empty).
#[tauri::command]
pub async fn pod_metrics(namespaces: Vec<String>, state: Session) -> CmdResult<Vec<Usage>> {
    let client = state.connection().await?.client;
    let scopes: Vec<Option<&str>> = if namespaces.is_empty() { vec![None] } else { namespaces.iter().map(|n| Some(n.as_str())).collect() };
    let lists = futures::future::join_all(scopes.into_iter().map(|ns| {
        let api = metrics_api(client.clone(), "pods", "PodMetrics", ns);
        async move { api.list(&ListParams::default()).await }
    }))
    .await;
    let mut items = Vec::new();
    for list in lists {
        items.extend(list.map_err(metrics_error)?.items);
    }
    Ok(items
        .into_iter()
        .map(|m| {
            let containers = m.data["containers"].as_array().cloned().unwrap_or_default();
            let total = |resource: &str| containers.iter().filter_map(|c| c.pointer(&format!("/usage/{resource}"))).map(quantity).sum::<f64>();
            Usage {
                namespace: m.metadata.namespace,
                name: m.metadata.name.unwrap_or_default(),
                cpu_millis: total("cpu") * 1000.0,
                memory_bytes: total("memory"),
                cpu_allocatable_millis: None,
                memory_allocatable_bytes: None,
            }
        })
        .collect())
}

#[tauri::command]
pub async fn node_metrics(state: Session) -> CmdResult<Vec<Usage>> {
    let client = state.connection().await?.client;
    let usage = metrics_api(client.clone(), "nodes", "NodeMetrics", None).list(&ListParams::default()).await.map_err(metrics_error)?;
    let nodes = Api::<Node>::all(client).list(&ListParams::default()).await.map_err(|e| e.to_string())?;
    Ok(usage
        .items
        .into_iter()
        .map(|m| {
            let name = m.metadata.name.unwrap_or_default();
            let allocatable = nodes.items.iter().find(|n| n.metadata.name.as_deref() == Some(name.as_str())).and_then(|n| n.status.as_ref()?.allocatable.clone());
            let alloc = |r: &str| allocatable.as_ref().and_then(|a| a.get(r)).map(|q| quantity(&Value::String(q.0.clone())));
            Usage {
                namespace: None,
                cpu_millis: m.data.pointer("/usage/cpu").map(quantity).unwrap_or(0.0) * 1000.0,
                memory_bytes: m.data.pointer("/usage/memory").map(quantity).unwrap_or(0.0),
                cpu_allocatable_millis: alloc("cpu").map(|c| c * 1000.0),
                memory_allocatable_bytes: alloc("memory"),
                name,
            }
        })
        .collect())
}

/// Parses a Kubernetes quantity ("250m", "1.5", "128Mi", "1500000n", "1e3") into base units
/// (cores for CPU, bytes for memory).
pub fn quantity(v: &Value) -> f64 {
    let Some(s) = v.as_str() else { return v.as_f64().unwrap_or(0.0) };
    let s = s.trim();
    const SUFFIXES: &[(&str, f64)] = &[
        ("Ki", 1024.0),
        ("Mi", 1024.0 * 1024.0),
        ("Gi", 1024.0 * 1024.0 * 1024.0),
        ("Ti", 1024.0 * 1024.0 * 1024.0 * 1024.0),
        ("Pi", 1024.0 * 1024.0 * 1024.0 * 1024.0 * 1024.0),
        ("Ei", 1024.0 * 1024.0 * 1024.0 * 1024.0 * 1024.0 * 1024.0),
        ("n", 1e-9),
        ("u", 1e-6),
        ("m", 1e-3),
        ("k", 1e3),
        ("M", 1e6),
        ("G", 1e9),
        ("T", 1e12),
        ("P", 1e15),
        ("E", 1e18),
    ];
    for (suffix, factor) in SUFFIXES {
        if let Some(number) = s.strip_suffix(suffix) {
            return number.parse::<f64>().map(|n| n * factor).unwrap_or(0.0);
        }
    }
    s.parse().unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::quantity;
    use serde_json::json;

    #[test]
    fn parses_kubernetes_quantities() {
        let close = |a: f64, b: f64| (a - b).abs() < 1e-9 * b.abs().max(1.0);
        assert!(close(quantity(&json!("250m")), 0.25));
        assert!(close(quantity(&json!("1500000n")), 0.0015));
        assert!(close(quantity(&json!("2")), 2.0));
        assert!(close(quantity(&json!("1.5")), 1.5));
        assert!(close(quantity(&json!("128Mi")), 134_217_728.0));
        assert!(close(quantity(&json!("16323736Ki")), 16_715_505_664.0));
        assert!(close(quantity(&json!("1G")), 1e9));
        assert!(close(quantity(&json!("1e3")), 1000.0));
        assert_eq!(quantity(&json!("garbage")), 0.0);
    }
}
