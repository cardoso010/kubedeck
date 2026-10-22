//! Node details (capacity, what is requested and used, conditions, taints), cordon and drain.

use k8s_openapi::api::core::v1::{Node, Pod};
use kube::api::{Api, ApiResource, DynamicObject, EvictParams, GroupVersionKind, ListParams, Patch, PatchParams};
use serde::Serialize;
use serde_json::{json, Value};

use crate::metrics::quantity;
use crate::state::{kube_err, CmdResult, Session};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeSummary {
    cpu_capacity_millis: f64,
    cpu_allocatable_millis: f64,
    /// Sum of the CPU requests of the pods on the node.
    cpu_requested_millis: f64,
    cpu_usage_millis: Option<f64>,
    memory_capacity_bytes: f64,
    memory_allocatable_bytes: f64,
    memory_requested_bytes: f64,
    memory_usage_bytes: Option<f64>,
    pods: usize,
    max_pods: f64,
    unschedulable: bool,
    conditions: Vec<NodeCondition>,
    taints: Vec<String>,
    info: Vec<(String, String)>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeCondition {
    r#type: String,
    status: String,
    reason: String,
    message: String,
    /// True when this condition means trouble.
    bad: bool,
}

fn q(map: Option<&std::collections::BTreeMap<String, k8s_openapi::apimachinery::pkg::api::resource::Quantity>>, key: &str) -> f64 {
    map.and_then(|m| m.get(key)).map(|v| quantity(&Value::String(v.0.clone()))).unwrap_or(0.0)
}

fn running(p: &Pod) -> bool {
    !matches!(p.status.as_ref().and_then(|s| s.phase.as_deref()), Some("Succeeded" | "Failed"))
}

#[tauri::command]
pub async fn node_summary(name: String, state: Session) -> CmdResult<NodeSummary> {
    let client = state.connection().await?.client;
    let node = Api::<Node>::all(client.clone()).get(&name).await.map_err(|e| kube_err(&e))?;
    let pods: Vec<Pod> = Api::<Pod>::all(client.clone())
        .list(&ListParams::default().fields(&format!("spec.nodeName={name}")))
        .await
        .map_err(|e| kube_err(&e))?
        .items
        .into_iter()
        .filter(running)
        .collect();
    let ar = ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk("metrics.k8s.io", "v1beta1", "NodeMetrics"), "nodes");
    let usage = Api::<DynamicObject>::all_with(client, &ar).get(&name).await.ok();

    let status = node.status.clone().unwrap_or_default();
    let (mut cpu_req, mut mem_req) = (0.0, 0.0);
    for p in &pods {
        for c in p.spec.iter().flat_map(|s| s.containers.iter()) {
            let requests = c.resources.as_ref().and_then(|r| r.requests.as_ref());
            cpu_req += q(requests, "cpu") * 1000.0;
            mem_req += q(requests, "memory");
        }
    }
    let info = status.node_info.as_ref().map(|i| {
        vec![
            ("Kubelet".into(), i.kubelet_version.clone()),
            ("OS".into(), i.os_image.clone()),
            ("Container runtime".into(), i.container_runtime_version.clone()),
            ("Kernel".into(), i.kernel_version.clone()),
            ("Architecture".into(), i.architecture.clone()),
        ]
    });
    let labels = node.metadata.labels.clone().unwrap_or_default();
    let mut info = info.unwrap_or_default();
    for (label, key) in [("Instance type", "node.kubernetes.io/instance-type"), ("Zone", "topology.kubernetes.io/zone"), ("Node pool", "karpenter.sh/nodepool"), ("Capacity type", "karpenter.sh/capacity-type")] {
        if let Some(v) = labels.get(key) {
            info.push((label.into(), v.clone()));
        }
    }
    Ok(NodeSummary {
        cpu_capacity_millis: q(status.capacity.as_ref(), "cpu") * 1000.0,
        cpu_allocatable_millis: q(status.allocatable.as_ref(), "cpu") * 1000.0,
        cpu_requested_millis: cpu_req,
        cpu_usage_millis: usage.as_ref().and_then(|u| u.data.pointer("/usage/cpu")).map(|v| quantity(v) * 1000.0),
        memory_capacity_bytes: q(status.capacity.as_ref(), "memory"),
        memory_allocatable_bytes: q(status.allocatable.as_ref(), "memory"),
        memory_requested_bytes: mem_req,
        memory_usage_bytes: usage.as_ref().and_then(|u| u.data.pointer("/usage/memory")).map(quantity),
        pods: pods.len(),
        max_pods: q(status.allocatable.as_ref(), "pods"),
        unschedulable: node.spec.as_ref().and_then(|s| s.unschedulable).unwrap_or(false),
        conditions: status
            .conditions
            .unwrap_or_default()
            .into_iter()
            .map(|c| NodeCondition {
                bad: if c.type_ == "Ready" { c.status != "True" } else { c.status == "True" },
                r#type: c.type_,
                status: c.status,
                reason: c.reason.unwrap_or_default(),
                message: c.message.unwrap_or_default(),
            })
            .collect(),
        taints: node.spec.and_then(|s| s.taints).unwrap_or_default().into_iter().map(|t| format!("{}={}:{}", t.key, t.value.unwrap_or_default(), t.effect)).collect(),
        info,
    })
}

/// `kubectl cordon` / `uncordon`.
#[tauri::command]
pub async fn cordon(name: String, unschedulable: bool, state: Session) -> CmdResult<()> {
    state.writable()?;
    let api: Api<Node> = Api::all(state.connection().await?.client);
    api.patch(&name, &PatchParams::default(), &Patch::Merge(&json!({ "spec": { "unschedulable": unschedulable } })))
        .await
        .map_err(|e| kube_err(&e))?;
    Ok(())
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DrainReport {
    /// "namespace/name" of pods evicted (or that would be, in a dry run).
    evicted: Vec<String>,
    /// Pods left alone, with why.
    skipped: Vec<(String, String)>,
    /// Evictions refused, usually by a PodDisruptionBudget.
    failed: Vec<(String, String)>,
}

/// `kubectl drain --ignore-daemonsets`: cordons the node, then evicts its pods through the
/// eviction API (so PodDisruptionBudgets apply). DaemonSet pods, static pods and pods
/// without a controller (which would be gone for good) are skipped and reported.
/// `pod_selector` limits it to matching pods; `dry_run` only reports.
#[tauri::command]
pub async fn drain(name: String, pod_selector: Option<String>, dry_run: bool, state: Session) -> CmdResult<DrainReport> {
    if !dry_run {
        state.writable()?;
    }
    let client = state.connection().await?.client;
    if !dry_run {
        Api::<Node>::all(client.clone())
            .patch(&name, &PatchParams::default(), &Patch::Merge(&json!({ "spec": { "unschedulable": true } })))
            .await
            .map_err(|e| kube_err(&e))?;
    }
    let mut params = ListParams::default().fields(&format!("spec.nodeName={name}"));
    if let Some(sel) = pod_selector.as_deref().filter(|s| !s.trim().is_empty()) {
        params = params.labels(sel);
    }
    let pods = Api::<Pod>::all(client.clone()).list(&params).await.map_err(|e| kube_err(&e))?.items;
    let mut report = DrainReport::default();
    for p in pods {
        let ns = p.metadata.namespace.clone().unwrap_or_default();
        let pod_name = p.metadata.name.clone().unwrap_or_default();
        let id = format!("{ns}/{pod_name}");
        let controller = p.metadata.owner_references.iter().flatten().find(|o| o.controller == Some(true));
        let skip = if p.metadata.deletion_timestamp.is_some() {
            Some("already terminating")
        } else if p.metadata.annotations.as_ref().is_some_and(|a| a.contains_key("kubernetes.io/config.mirror")) {
            Some("static pod, managed by the kubelet")
        } else if controller.is_some_and(|c| c.kind == "DaemonSet") {
            Some("DaemonSet pod, it would come back on this node")
        } else if !running(&p) {
            Some("already finished")
        } else if controller.is_none() {
            Some("no controller would recreate it; delete it yourself if that is fine")
        } else {
            None
        };
        if let Some(reason) = skip {
            report.skipped.push((id, reason.into()));
            continue;
        }
        if dry_run {
            report.evicted.push(id);
            continue;
        }
        match Api::<Pod>::namespaced(client.clone(), &ns).evict(&pod_name, &EvictParams::default()).await {
            Ok(_) => report.evicted.push(id),
            Err(kube::Error::Api(s)) if s.code == 429 => report.failed.push((id, "blocked by a PodDisruptionBudget; try again later".into())),
            Err(e) => report.failed.push((id, kube_err(&e))),
        }
    }
    Ok(report)
}
