//! Triage: what is wrong across the selected namespaces (the Problems view), and how an
//! object relates to others (owners, pods, services, ingresses, config it uses, its node).

use std::collections::BTreeMap;

use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::batch::v1::Job;
use k8s_openapi::api::core::v1::{Node, PersistentVolumeClaim, Pod, Service};
use k8s_openapi::api::networking::v1::Ingress;
use kube::api::{Api, ListParams};
use kube::Client;
use serde::Serialize;

use crate::state::{kube_err, CmdResult, Session};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    /// "critical" or "warning".
    severity: &'static str,
    kind_key: &'static str,
    namespace: Option<String>,
    name: String,
    reason: String,
    message: String,
    since: Option<String>,
}

const CRASHING: &[&str] = &["CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError", "CreateContainerError", "InvalidImageName", "RunContainerError"];
/// Pods pending or not ready for less than this are probably just starting.
const GRACE_SECONDS: i64 = 180;

fn ts<T: Serialize>(t: Option<&T>) -> Option<String> {
    t.and_then(|t| serde_json::to_value(t).ok()).and_then(|v| v.as_str().map(str::to_owned))
}

fn older_than(created: Option<&String>, seconds: i64) -> bool {
    created
        .and_then(|c| c.parse::<jiff::Timestamp>().ok())
        .map(|c| jiff::Timestamp::now().duration_since(c).as_secs() > seconds)
        .unwrap_or(true)
}

fn pod_problems(pod: &Pod) -> Vec<Problem> {
    let name = pod.metadata.name.clone().unwrap_or_default();
    let namespace = pod.metadata.namespace.clone();
    let created = ts(pod.metadata.creation_timestamp.as_ref());
    let status = pod.status.clone().unwrap_or_default();
    let problem = |severity, reason: String, message: String, since: Option<String>| Problem { severity, kind_key: "pods", namespace: namespace.clone(), name: name.clone(), reason, message, since };
    let mut out = Vec::new();

    for c in status.container_statuses.iter().flatten().chain(status.init_container_statuses.iter().flatten()) {
        if let Some(waiting) = c.state.as_ref().and_then(|s| s.waiting.as_ref())
            && let Some(reason) = waiting.reason.as_deref().filter(|r| CRASHING.contains(r))
        {
            let mut message = format!("{}: {}", c.name, waiting.message.clone().unwrap_or_default());
            if let Some(last) = c.last_state.as_ref().and_then(|l| l.terminated.as_ref()) {
                message.push_str(&format!(" (last exit {} {}, {} restarts)", t_reason(last.reason.as_deref()), last.exit_code, c.restart_count));
            }
            out.push(problem("critical", reason.to_owned(), message.trim_end_matches(": ").to_owned(), created.clone()));
            continue;
        }
        // Between restarts a crash-looping container shows as terminated, not waiting.
        if let Some(t) = c.state.as_ref().and_then(|s| s.terminated.as_ref())
            && t.exit_code != 0
            && pod.spec.as_ref().and_then(|s| s.restart_policy.as_deref()) != Some("Never")
        {
            out.push(problem("critical", t_reason(t.reason.as_deref()).to_owned(), format!("{} exited with code {} ({} restarts)", c.name, t.exit_code, c.restart_count), ts(t.finished_at.as_ref())));
            continue;
        }
        if let Some(last) = c.last_state.as_ref().and_then(|l| l.terminated.as_ref())
            && last.reason.as_deref() == Some("OOMKilled")
        {
            let when = ts(last.finished_at.as_ref());
            if !older_than(when.as_ref(), 24 * 3600) {
                out.push(problem("warning", "OOMKilled".into(), format!("{} ran out of memory and was restarted ({} restarts)", c.name, c.restart_count), when));
            }
        }
    }
    if !out.is_empty() {
        return out;
    }

    match status.phase.as_deref() {
        Some("Pending") if older_than(created.as_ref(), GRACE_SECONDS) => {
            let unschedulable = status.conditions.iter().flatten().find(|c| c.type_ == "PodScheduled" && c.status == "False");
            let (reason, message) = match unschedulable {
                Some(c) => (c.reason.clone().unwrap_or_else(|| "Unschedulable".into()), c.message.clone().unwrap_or_default()),
                None => ("Pending".into(), "Waiting to start".into()),
            };
            out.push(problem("warning", reason, message, created));
        }
        Some("Failed") => out.push(problem("warning", status.reason.clone().unwrap_or_else(|| "Failed".into()), status.message.clone().unwrap_or_default(), created)),
        Some("Running") => {
            let not_ready = status.conditions.iter().flatten().find(|c| c.type_ == "Ready" && c.status == "False");
            if let Some(c) = not_ready
                && older_than(ts(c.last_transition_time.as_ref()).as_ref(), GRACE_SECONDS)
                && pod.metadata.deletion_timestamp.is_none()
            {
                out.push(problem("warning", "NotReady".into(), c.message.clone().unwrap_or_else(|| "A container is not passing its readiness probe".into()), ts(c.last_transition_time.as_ref())));
            }
        }
        _ => {}
    }
    out
}

fn t_reason(r: Option<&str>) -> &str {
    r.unwrap_or("Terminated")
}

async fn list_scoped<K>(client: &Client, namespaces: &[String]) -> Vec<K>
where
    K: kube::Resource<Scope = k8s_openapi::NamespaceResourceScope> + Clone + serde::de::DeserializeOwned + std::fmt::Debug,
    K::DynamicType: Default,
{
    let apis: Vec<Api<K>> = if namespaces.is_empty() { vec![Api::all(client.clone())] } else { namespaces.iter().map(|ns| Api::namespaced(client.clone(), ns)).collect() };
    let params = ListParams::default();
    let lists = futures::future::join_all(apis.iter().map(|a| a.list(&params))).await;
    // A namespace the user may not read just contributes nothing.
    lists.into_iter().filter_map(Result::ok).flat_map(|l| l.items).collect()
}

/// Everything that looks wrong in `namespaces` (all when empty), worst first.
#[tauri::command]
pub async fn cluster_problems(namespaces: Vec<String>, state: Session) -> CmdResult<Vec<Problem>> {
    let client = state.connection().await?.client;
    let (pods, deployments, statefulsets, daemonsets, jobs, pvcs) = tokio::join!(
        list_scoped::<Pod>(&client, &namespaces),
        list_scoped::<Deployment>(&client, &namespaces),
        list_scoped::<StatefulSet>(&client, &namespaces),
        list_scoped::<DaemonSet>(&client, &namespaces),
        list_scoped::<Job>(&client, &namespaces),
        list_scoped::<PersistentVolumeClaim>(&client, &namespaces),
    );
    let mut out: Vec<Problem> = pods.iter().flat_map(pod_problems).collect();

    for d in &deployments {
        let spec = d.spec.clone().unwrap_or_default();
        let status = d.status.clone().unwrap_or_default();
        let want = spec.replicas.unwrap_or(1);
        let available = status.available_replicas.unwrap_or(0);
        let stuck = status.conditions.iter().flatten().find(|c| c.type_ == "Progressing" && c.reason.as_deref() == Some("ProgressDeadlineExceeded"));
        if stuck.is_some() || (available < want && !spec.paused.unwrap_or(false)) {
            let deployment_since = ts(status.conditions.iter().flatten().find(|c| c.type_ == "Available").and_then(|c| c.last_transition_time.as_ref()));
            if stuck.is_none() && !older_than(deployment_since.as_ref(), GRACE_SECONDS) {
                continue;
            }
            out.push(Problem {
                severity: if stuck.is_some() || available == 0 { "critical" } else { "warning" },
                kind_key: "deployments",
                namespace: d.metadata.namespace.clone(),
                name: d.metadata.name.clone().unwrap_or_default(),
                reason: if stuck.is_some() { "ProgressDeadlineExceeded".into() } else { "Unavailable".into() },
                message: format!("{available}/{want} replicas available{}", stuck.and_then(|c| c.message.clone()).map(|m| format!(": {m}")).unwrap_or_default()),
                since: deployment_since,
            });
        }
    }
    for s in &statefulsets {
        let want = s.spec.as_ref().and_then(|sp| sp.replicas).unwrap_or(1);
        let ready = s.status.as_ref().and_then(|st| st.ready_replicas).unwrap_or(0);
        if ready < want {
            out.push(Problem { severity: "warning", kind_key: "statefulsets", namespace: s.metadata.namespace.clone(), name: s.metadata.name.clone().unwrap_or_default(), reason: "NotReady".into(), message: format!("{ready}/{want} replicas ready"), since: None });
        }
    }
    for d in &daemonsets {
        let unavailable = d.status.as_ref().and_then(|s| s.number_unavailable).unwrap_or(0);
        if unavailable > 0 {
            out.push(Problem { severity: "warning", kind_key: "daemonsets", namespace: d.metadata.namespace.clone(), name: d.metadata.name.clone().unwrap_or_default(), reason: "Unavailable".into(), message: format!("{unavailable} node(s) without a ready pod"), since: None });
        }
    }
    for j in &jobs {
        if let Some(c) = j.status.as_ref().and_then(|s| s.conditions.as_ref()).and_then(|cs| cs.iter().find(|c| c.type_ == "Failed" && c.status == "True")) {
            out.push(Problem { severity: "warning", kind_key: "jobs", namespace: j.metadata.namespace.clone(), name: j.metadata.name.clone().unwrap_or_default(), reason: c.reason.clone().unwrap_or_else(|| "Failed".into()), message: c.message.clone().unwrap_or_default(), since: ts(c.last_transition_time.as_ref()) });
        }
    }
    for p in &pvcs {
        if p.status.as_ref().and_then(|s| s.phase.as_deref()) == Some("Pending") && older_than(ts(p.metadata.creation_timestamp.as_ref()).as_ref(), GRACE_SECONDS) {
            out.push(Problem { severity: "warning", kind_key: "persistentvolumeclaims", namespace: p.metadata.namespace.clone(), name: p.metadata.name.clone().unwrap_or_default(), reason: "Pending".into(), message: "The volume claim is not bound".into(), since: ts(p.metadata.creation_timestamp.as_ref()) });
        }
    }
    // Nodes are cluster-wide; listing them may be forbidden.
    if let Ok(nodes) = Api::<Node>::all(client).list(&ListParams::default()).await {
        for n in nodes.items {
            let name = n.metadata.name.clone().unwrap_or_default();
            for c in n.status.iter().flat_map(|s| s.conditions.iter().flatten()) {
                let bad = match c.type_.as_str() {
                    "Ready" => c.status != "True",
                    "MemoryPressure" | "DiskPressure" | "PIDPressure" | "NetworkUnavailable" => c.status == "True",
                    _ => false,
                };
                if bad {
                    out.push(Problem {
                        severity: if c.type_ == "Ready" { "critical" } else { "warning" },
                        kind_key: "nodes",
                        namespace: None,
                        name: name.clone(),
                        reason: if c.type_ == "Ready" { "NotReady".into() } else { c.type_.clone() },
                        message: c.message.clone().unwrap_or_default(),
                        since: ts(c.last_transition_time.as_ref()),
                    });
                }
            }
        }
    }
    out.sort_by(|a, b| (a.severity != "critical", &a.namespace, &a.name).cmp(&(b.severity != "critical", &b.namespace, &b.name)));
    Ok(out)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RelatedItem {
    kind_key: String,
    namespace: Option<String>,
    name: String,
    /// A short state, e.g. "Running" or "3/3".
    status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelatedGroup {
    relation: String,
    items: Vec<RelatedItem>,
}

fn item(kind_key: &str, namespace: Option<&str>, name: &str, status: impl Into<String>) -> RelatedItem {
    RelatedItem { kind_key: kind_key.into(), namespace: namespace.map(str::to_owned), name: name.into(), status: status.into() }
}

fn pod_item(p: &Pod) -> RelatedItem {
    let phase = p.status.as_ref().and_then(|s| s.phase.clone()).unwrap_or_default();
    item("pods", p.metadata.namespace.as_deref(), p.metadata.name.as_deref().unwrap_or_default(), phase)
}

fn selects(selector: &BTreeMap<String, String>, labels: Option<&BTreeMap<String, String>>) -> bool {
    !selector.is_empty() && labels.is_some_and(|l| selector.iter().all(|(k, v)| l.get(k) == Some(v)))
}

async fn pods_matching(client: &Client, ns: &str, selector: &BTreeMap<String, String>) -> Vec<Pod> {
    if selector.is_empty() {
        return vec![];
    }
    let labels = selector.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(",");
    Api::<Pod>::namespaced(client.clone(), ns).list(&ListParams::default().labels(&labels)).await.map(|l| l.items).unwrap_or_default()
}

/// Services in `ns` whose selector matches any of `pods`.
async fn services_for(client: &Client, ns: &str, pods: &[Pod]) -> Vec<RelatedItem> {
    let services = Api::<Service>::namespaced(client.clone(), ns).list(&ListParams::default()).await.map(|l| l.items).unwrap_or_default();
    services
        .iter()
        .filter(|s| {
            let selector = s.spec.as_ref().and_then(|sp| sp.selector.clone()).unwrap_or_default();
            pods.iter().any(|p| selects(&selector, p.metadata.labels.as_ref()))
        })
        .map(|s| item("services", Some(ns), s.metadata.name.as_deref().unwrap_or_default(), s.spec.as_ref().and_then(|sp| sp.type_.clone()).unwrap_or_default()))
        .collect()
}

/// Config a pod uses: config maps, secrets and volume claims, from volumes and env.
fn pod_uses(p: &Pod) -> Vec<RelatedItem> {
    let ns = p.metadata.namespace.as_deref();
    let mut set: BTreeMap<(String, String), ()> = BTreeMap::new();
    if let Some(spec) = &p.spec {
        for v in spec.volumes.iter().flatten() {
            if let Some(cm) = &v.config_map {
                set.insert(("configmaps".into(), cm.name.clone()), ());
            }
            if let Some(s) = v.secret.as_ref().and_then(|s| s.secret_name.clone()) {
                set.insert(("secrets".into(), s), ());
            }
            if let Some(pvc) = &v.persistent_volume_claim {
                set.insert(("persistentvolumeclaims".into(), pvc.claim_name.clone()), ());
            }
        }
        for c in spec.containers.iter().chain(spec.init_containers.iter().flatten()) {
            for from in c.env_from.iter().flatten() {
                if let Some(cm) = &from.config_map_ref {
                    set.insert(("configmaps".into(), cm.name.clone()), ());
                }
                if let Some(s) = &from.secret_ref {
                    set.insert(("secrets".into(), s.name.clone()), ());
                }
            }
            for e in c.env.iter().flatten() {
                if let Some(src) = &e.value_from {
                    if let Some(cm) = &src.config_map_key_ref {
                        set.insert(("configmaps".into(), cm.name.clone()), ());
                    }
                    if let Some(s) = &src.secret_key_ref {
                        set.insert(("secrets".into(), s.name.clone()), ());
                    }
                }
            }
        }
    }
    set.into_keys().map(|(k, n)| item(&k, ns, &n, "")).collect()
}

/// Objects related to `name`, grouped by relation.
#[tauri::command]
pub async fn related(kind_key: String, namespace: Option<String>, name: String, state: Session) -> CmdResult<Vec<RelatedGroup>> {
    let client = state.connection().await?.client;
    let ns = namespace.as_deref().unwrap_or("default");
    let mut groups: Vec<RelatedGroup> = Vec::new();
    let mut push = |relation: &str, items: Vec<RelatedItem>| {
        if !items.is_empty() {
            groups.push(RelatedGroup { relation: relation.into(), items });
        }
    };

    match kind_key.as_str() {
        "pods" => {
            let pod = Api::<Pod>::namespaced(client.clone(), ns).get(&name).await.map_err(|e| kube_err(&e))?;
            // Owner chain: ReplicaSet → Deployment, Job → CronJob, or a direct controller.
            let mut owners = Vec::new();
            for o in pod.metadata.owner_references.iter().flatten().filter(|o| o.controller == Some(true)) {
                match o.kind.as_str() {
                    "ReplicaSet" => {
                        if let Ok(rs) = Api::<ReplicaSet>::namespaced(client.clone(), ns).get(&o.name).await {
                            for d in rs.metadata.owner_references.iter().flatten().filter(|d| d.kind == "Deployment") {
                                owners.push(item("deployments", Some(ns), &d.name, ""));
                            }
                        }
                    }
                    "Job" => {
                        owners.push(item("jobs", Some(ns), &o.name, ""));
                        if let Ok(job) = Api::<Job>::namespaced(client.clone(), ns).get(&o.name).await {
                            for c in job.metadata.owner_references.iter().flatten().filter(|c| c.kind == "CronJob") {
                                owners.push(item("cronjobs", Some(ns), &c.name, ""));
                            }
                        }
                    }
                    "StatefulSet" => owners.push(item("statefulsets", Some(ns), &o.name, "")),
                    "DaemonSet" => owners.push(item("daemonsets", Some(ns), &o.name, "")),
                    _ => {}
                }
            }
            push("Owned by", owners);
            push("Exposed by", services_for(&client, ns, std::slice::from_ref(&pod)).await);
            push("Uses", pod_uses(&pod));
            if let Some(node) = pod.spec.as_ref().and_then(|s| s.node_name.clone()) {
                push("Runs on", vec![item("nodes", None, &node, "")]);
            }
        }
        "deployments" | "statefulsets" | "daemonsets" | "jobs" => {
            let selector = match kind_key.as_str() {
                "deployments" => Api::<Deployment>::namespaced(client.clone(), ns).get(&name).await.map_err(|e| kube_err(&e))?.spec.and_then(|s| s.selector.match_labels),
                "statefulsets" => Api::<StatefulSet>::namespaced(client.clone(), ns).get(&name).await.map_err(|e| kube_err(&e))?.spec.and_then(|s| s.selector.match_labels),
                "daemonsets" => Api::<DaemonSet>::namespaced(client.clone(), ns).get(&name).await.map_err(|e| kube_err(&e))?.spec.and_then(|s| s.selector.match_labels),
                _ => Api::<Job>::namespaced(client.clone(), ns).get(&name).await.map_err(|e| kube_err(&e))?.spec.and_then(|s| s.selector).and_then(|s| s.match_labels),
            }
            .unwrap_or_default();
            let pods = pods_matching(&client, ns, &selector).await;
            push("Exposed by", services_for(&client, ns, &pods).await);
            let mut uses: BTreeMap<(String, String), RelatedItem> = BTreeMap::new();
            for p in &pods {
                for u in pod_uses(p) {
                    uses.insert((u.kind_key.clone(), u.name.clone()), u);
                }
            }
            push("Pods", pods.iter().map(pod_item).collect());
            push("Uses", uses.into_values().collect());
        }
        "services" => {
            let svc = Api::<Service>::namespaced(client.clone(), ns).get(&name).await.map_err(|e| kube_err(&e))?;
            let selector = svc.spec.and_then(|s| s.selector).unwrap_or_default();
            push("Routes to", pods_matching(&client, ns, &selector).await.iter().map(pod_item).collect());
            let ingresses = Api::<Ingress>::namespaced(client.clone(), ns).list(&ListParams::default()).await.map(|l| l.items).unwrap_or_default();
            push(
                "Exposed by",
                ingresses
                    .iter()
                    .filter(|i| ingress_services(i).contains(&name))
                    .map(|i| item("ingresses", Some(ns), i.metadata.name.as_deref().unwrap_or_default(), ""))
                    .collect(),
            );
        }
        "ingresses" => {
            let ing = Api::<Ingress>::namespaced(client.clone(), ns).get(&name).await.map_err(|e| kube_err(&e))?;
            push("Routes to", ingress_services(&ing).iter().map(|s| item("services", Some(ns), s, "")).collect());
        }
        "configmaps" | "secrets" => {
            let pods = Api::<Pod>::namespaced(client.clone(), ns).list(&ListParams::default()).await.map(|l| l.items).unwrap_or_default();
            push("Used by", pods.iter().filter(|p| pod_uses(p).iter().any(|u| u.kind_key == kind_key && u.name == name)).map(pod_item).collect());
        }
        "nodes" => {
            let pods = Api::<Pod>::all(client.clone()).list(&ListParams::default().fields(&format!("spec.nodeName={name}"))).await.map_err(|e| kube_err(&e))?;
            push("Pods", pods.items.iter().map(pod_item).collect());
        }
        _ => {}
    }
    Ok(groups)
}

fn ingress_services(i: &Ingress) -> Vec<String> {
    let spec = i.spec.clone().unwrap_or_default();
    let mut names: Vec<String> = spec
        .rules
        .iter()
        .flatten()
        .flat_map(|r| r.http.iter().flat_map(|h| h.paths.iter()))
        .filter_map(|p| p.backend.service.as_ref().map(|s| s.name.clone()))
        .chain(spec.default_backend.and_then(|b| b.service).map(|s| s.name))
        .collect();
    names.sort();
    names.dedup();
    names
}
