//! Volume usage for PersistentVolumeClaims, its history, and expanding a claim.
//!
//! Usage comes from Prometheus (`kubelet_volume_stats_*`) when the cluster has one, otherwise
//! straight from the kubelets' stats summary through the API server's node proxy. Either way
//! only volume plugins that measure themselves report anything (CSI drivers such as EBS do;
//! hostPath volumes do not), so a claim without usage is normal, not an error.

use std::collections::{BTreeMap, BTreeSet};

use k8s_openapi::api::core::v1::{PersistentVolumeClaim, Pod};
use k8s_openapi::api::storage::v1::StorageClass;
use kube::api::{Api, ListParams, Patch, PatchParams};
use kube::Client;
use serde::Serialize;
use serde_json::{json, Value};

use crate::metrics::quantity;
use crate::pod_insights::{prom_get, prometheus, Series};
use crate::state::{err, kube_err, CmdResult, Session};

#[derive(Serialize, Clone, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VolumeStats {
    pub namespace: String,
    pub claim: String,
    pub capacity_bytes: f64,
    pub used_bytes: f64,
    pub available_bytes: f64,
    pub inodes: Option<f64>,
    pub inodes_used: Option<f64>,
}

impl VolumeStats {
    pub fn used_fraction(&self) -> f64 {
        if self.capacity_bytes > 0.0 { self.used_bytes / self.capacity_bytes } else { 0.0 }
    }
}

/// "1.5Gi"-style size for messages.
pub fn format_bytes(bytes: f64) -> String {
    const UNITS: [&str; 5] = ["B", "Ki", "Mi", "Gi", "Ti"];
    let mut v = bytes.max(0.0);
    let mut unit = 0;
    while v >= 1024.0 && unit < UNITS.len() - 1 {
        v /= 1024.0;
        unit += 1;
    }
    if unit == 0 || v >= 100.0 { format!("{v:.0}{}", UNITS[unit]) } else { format!("{v:.1}{}", UNITS[unit]) }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeUsage {
    /// Where the numbers come from, for the UI to say.
    source: String,
    volumes: Vec<VolumeStats>,
}

/// Usage of every claim in `namespaces` (all when empty) that Prometheus knows about.
pub(crate) async fn from_prometheus(client: &Client, target: &crate::pod_insights::PromTarget, namespaces: &[String]) -> Option<Vec<VolumeStats>> {
    // Namespace names are DNS labels: safe inside a regex alternation.
    let ns = if namespaces.is_empty() { ".+".to_owned() } else { namespaces.join("|") };
    let q = |metric: &str| format!(r#"max by (namespace, persistentvolumeclaim) (kubelet_volume_stats_{metric}{{namespace=~"{ns}"}})"#);
    let query = |metric: &'static str| {
        let (client, target, q) = (client.clone(), target.clone(), q(metric));
        async move { prom_get(&client, &target, "/api/v1/query", &[("query", q)]).await }
    };
    let (capacity, used, available, inodes, inodes_used) =
        tokio::join!(query("capacity_bytes"), query("used_bytes"), query("available_bytes"), query("inodes"), query("inodes_used"));
    let mut by_claim: BTreeMap<(String, String), VolumeStats> = BTreeMap::new();
    let mut read = |data: &Value, set: fn(&mut VolumeStats, f64)| {
        for r in data["result"].as_array().into_iter().flatten() {
            let (Some(ns), Some(claim)) = (r["metric"]["namespace"].as_str(), r["metric"]["persistentvolumeclaim"].as_str()) else { continue };
            let Some(v) = r["value"][1].as_str().and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite()) else { continue };
            let entry = by_claim.entry((ns.into(), claim.into())).or_insert_with(|| VolumeStats { namespace: ns.into(), claim: claim.into(), ..Default::default() });
            set(entry, v);
        }
    };
    read(&capacity.ok()?, |s, v| s.capacity_bytes = v);
    read(&used.ok()?, |s, v| s.used_bytes = v);
    read(&available.ok()?, |s, v| s.available_bytes = v);
    if let Ok(d) = inodes {
        read(&d, |s, v| s.inodes = Some(v));
    }
    if let Ok(d) = inodes_used {
        read(&d, |s, v| s.inodes_used = Some(v));
    }
    // An empty answer means the kubelet metrics are not scraped: let the caller fall back.
    (!by_claim.is_empty()).then(|| by_claim.into_values().collect())
}

/// Reads the claim volumes out of one kubelet stats summary.
fn summary_volumes(summary: &Value) -> Vec<VolumeStats> {
    let mut out = Vec::new();
    for pod in summary["pods"].as_array().into_iter().flatten() {
        for v in pod["volume"].as_array().into_iter().flatten() {
            let Some(pvc) = v.get("pvcRef") else { continue };
            let f = |k: &str| v[k].as_f64();
            out.push(VolumeStats {
                namespace: pvc["namespace"].as_str().unwrap_or_default().into(),
                claim: pvc["name"].as_str().unwrap_or_default().into(),
                capacity_bytes: f("capacityBytes").unwrap_or(0.0),
                used_bytes: f("usedBytes").unwrap_or(0.0),
                available_bytes: f("availableBytes").unwrap_or(0.0),
                inodes: f("inodes"),
                inodes_used: f("inodesUsed"),
            });
        }
    }
    out
}

/// Asks only the nodes that run pods mounting a claim in `namespaces`. Needs `nodes/proxy`;
/// nodes that refuse just contribute nothing.
pub(crate) async fn from_kubelets(client: &Client, namespaces: &[String]) -> Vec<VolumeStats> {
    let scopes: Vec<Api<Pod>> = if namespaces.is_empty() { vec![Api::all(client.clone())] } else { namespaces.iter().map(|ns| Api::namespaced(client.clone(), ns)).collect() };
    let lp = ListParams::default().fields("status.phase=Running");
    let lists = futures::future::join_all(scopes.iter().map(|api| api.list(&lp))).await;
    let nodes: BTreeSet<String> = lists
        .into_iter()
        .filter_map(Result::ok)
        .flat_map(|l| l.items)
        .filter(|p| p.spec.as_ref().is_some_and(|s| s.volumes.iter().flatten().any(|v| v.persistent_volume_claim.is_some())))
        .filter_map(|p| p.spec.and_then(|s| s.node_name))
        .collect();
    let summaries = futures::future::join_all(nodes.iter().map(|node| {
        let client = client.clone();
        async move {
            let request = http::Request::get(format!("/api/v1/nodes/{node}/proxy/stats/summary")).body(Vec::new()).ok()?;
            serde_json::from_str::<Value>(&client.request_text(request).await.ok()?).ok()
        }
    }))
    .await;
    let mut seen = BTreeSet::new();
    summaries
        .into_iter()
        .flatten()
        .flat_map(|s| summary_volumes(&s))
        // A claim mounted by several pods on one node is reported once per pod.
        .filter(|v| (namespaces.is_empty() || namespaces.contains(&v.namespace)) && seen.insert((v.namespace.clone(), v.claim.clone())))
        .collect()
}

/// Used and free space of the claims in `namespaces` (all when empty).
#[tauri::command]
pub async fn volume_usage(namespaces: Vec<String>, state: Session) -> CmdResult<VolumeUsage> {
    let (client, target) = prometheus(&state).await?;
    if let Some(target) = &target
        && let Some(volumes) = from_prometheus(&client, target, &namespaces).await
    {
        return Ok(VolumeUsage { source: format!("Prometheus {}", target.label()), volumes });
    }
    Ok(VolumeUsage { source: "kubelet stats (current)".into(), volumes: from_kubelets(&client, &namespaces).await })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeHistory {
    source: String,
    used: Vec<Series>,
}

/// Used bytes of one claim over the last `minutes`, from Prometheus.
#[tauri::command]
pub async fn volume_history(namespace: String, claim: String, minutes: u64, state: Session) -> CmdResult<VolumeHistory> {
    let (client, target) = prometheus(&state).await?;
    let target = target.ok_or("No Prometheus found in this cluster")?;
    let minutes = minutes.clamp(5, 30 * 24 * 60);
    let step = (minutes * 60 / 120).max(30);
    let end = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(err)?.as_secs();
    let q = format!(r#"label_replace(max(kubelet_volume_stats_used_bytes{{namespace="{namespace}",persistentvolumeclaim="{claim}"}}), "container", "used", "", "")"#);
    let params = [("query", q), ("start", (end - minutes * 60).to_string()), ("end", end.to_string()), ("step", step.to_string())];
    let data = prom_get(&client, &target, "/api/v1/query_range", &params).await?;
    Ok(VolumeHistory { source: target.label(), used: crate::pod_insights::series(&data) })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpandInfo {
    /// The size requested now, e.g. "10Gi".
    requested: String,
    storage_class: Option<String>,
    /// Whether the claim's StorageClass allows growing volumes.
    expandable: bool,
}

/// What `expand_volume` needs to know before offering it.
#[tauri::command]
pub async fn volume_expand_info(namespace: String, name: String, state: Session) -> CmdResult<ExpandInfo> {
    expand_info(&state.connection().await?.client, &namespace, &name).await
}

async fn expand_info(client: &Client, namespace: &str, name: &str) -> CmdResult<ExpandInfo> {
    let pvc = Api::<PersistentVolumeClaim>::namespaced(client.clone(), namespace).get(name).await.map_err(|e| kube_err(&e))?;
    let requested = requested_size(&pvc);
    let storage_class = pvc.spec.and_then(|s| s.storage_class_name);
    let expandable = match &storage_class {
        Some(sc) => Api::<StorageClass>::all(client.clone()).get(sc).await.ok().and_then(|sc| sc.allow_volume_expansion).unwrap_or(false),
        None => false,
    };
    Ok(ExpandInfo { requested, storage_class, expandable })
}

fn requested_size(pvc: &PersistentVolumeClaim) -> String {
    pvc.spec.as_ref().and_then(|s| s.resources.as_ref()).and_then(|r| r.requests.as_ref()).and_then(|r| r.get("storage")).map(|q| q.0.clone()).unwrap_or_default()
}

/// Grows a claim to `size` (e.g. "20Gi"). Volumes can only grow, and only when their
/// StorageClass allows it; the file system is resized by the driver, sometimes only after
/// the pod restarts.
#[tauri::command]
pub async fn expand_volume(namespace: String, name: String, size: String, state: Session) -> CmdResult<()> {
    state.writable()?;
    let client = state.connection().await?.client;
    let info = expand_info(&client, &namespace, &name).await?;
    let new = quantity(&Value::String(size.trim().into()));
    if !size.trim().chars().next().is_some_and(|c| c.is_ascii_digit()) || new <= 0.0 {
        return Err(format!("\"{size}\" is not a size; use something like 20Gi"));
    }
    if new <= quantity(&Value::String(info.requested.clone())) {
        return Err(format!("Volumes can only grow: {name} already requests {}", info.requested));
    }
    if !info.expandable {
        return Err(match info.storage_class {
            Some(sc) => format!("The StorageClass {sc} does not allow volume expansion (allowVolumeExpansion is not true)"),
            None => format!("{name} has no StorageClass, so it cannot be expanded"),
        });
    }
    let api = Api::<PersistentVolumeClaim>::namespaced(client, &namespace);
    api.patch(&name, &PatchParams::default(), &Patch::Merge(&json!({ "spec": { "resources": { "requests": { "storage": size.trim() } } } })))
        .await
        .map_err(|e| kube_err(&e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_claim_volumes_from_a_kubelet_summary() {
        let summary = json!({ "pods": [{ "volume": [
            { "name": "token", "usedBytes": 1, "capacityBytes": 9 },
            { "name": "data", "pvcRef": { "name": "data", "namespace": "demo" }, "usedBytes": 50.0, "capacityBytes": 200.0, "availableBytes": 150.0, "inodes": 10.0, "inodesUsed": 2.0 }
        ]}]});
        let v = summary_volumes(&summary);
        assert_eq!(v.len(), 1);
        assert_eq!((v[0].claim.as_str(), v[0].used_fraction()), ("data", 0.25));
        assert_eq!(v[0].inodes_used, Some(2.0));
    }

    #[test]
    fn formats_sizes() {
        assert_eq!(format_bytes(512.0), "512B");
        assert_eq!(format_bytes(1.5 * 1024.0 * 1024.0 * 1024.0), "1.5Gi");
        assert_eq!(format_bytes(200.0 * 1024.0 * 1024.0), "200Mi");
    }
}
