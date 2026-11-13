//! Rightsizing: what each workload's containers request against what they actually use, so
//! over- and under-provisioned requests stand out. Usage comes from Prometheus (95th
//! percentile CPU and peak memory over 24 hours) when the cluster has one, otherwise from
//! metrics-server (the current moment only).

use std::collections::{BTreeMap, HashMap};

use k8s_openapi::api::core::v1::{Container, Pod, PodSpec};
use kube::api::{Api, ApiResource, DynamicObject, GroupVersionKind, ListParams, Patch, PatchParams};
use kube::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::metrics::quantity;
use crate::prometheus::{prom_get, prometheus};
use crate::state::{kube_err, CmdResult, Session};

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RightsizeRow {
    namespace: String,
    /// Kind key of the owning workload ("deployments", …) or "pods" for bare pods.
    kind_key: String,
    workload: String,
    container: String,
    /// A native sidecar: an init container with restartPolicy Always, running beside the app.
    sidecar: bool,
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

/// Owning workload of a pod, or the pod itself when it has none.
fn owner(pod: &Pod) -> (String, String) {
    match crate::owners::workload_of(pod) {
        Some((kind, name)) => (kind.into(), name),
        None => ("pods".into(), pod.metadata.name.clone().unwrap_or_default()),
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
        for (c, sidecar) in pod.spec.iter().flat_map(running_containers) {
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
                sidecar,
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

/// The containers that run for the pod's whole life: the app containers, then native sidecars
/// (init containers with restartPolicy Always), flagged as such.
pub(crate) fn running_containers(spec: &PodSpec) -> impl Iterator<Item = (&Container, bool)> {
    let sidecars = spec.init_containers.iter().flatten().filter(|c| c.restart_policy.as_deref() == Some("Always"));
    spec.containers.iter().map(|c| (c, false)).chain(sidecars.map(|c| (c, true)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewRequests {
    pub(crate) namespace: String,
    pub(crate) kind_key: String,
    pub(crate) workload: String,
    pub(crate) container: String,
    pub(crate) cpu_millis: Option<f64>,
    pub(crate) memory_bytes: Option<f64>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutcome {
    /// The pod, or the workload when its template was changed.
    pub(crate) target: String,
    pub(crate) ok: bool,
    pub(crate) message: String,
}

/// Where new requests go: the running pods, resized in place without a restart (they return
/// to the template's values when replaced), or the workload's pod template (permanent, rolls
/// the pods).
#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ApplyTo {
    Pods,
    Workload,
}

const TEMPLATED: &[&str] = &["deployments", "statefulsets", "daemonsets"];

fn quantities(r: &NewRequests) -> CmdResult<serde_json::Map<String, Value>> {
    let mut requests = serde_json::Map::new();
    if let Some(cpu) = r.cpu_millis.filter(|v| *v > 0.0) {
        requests.insert("cpu".into(), format!("{}m", cpu.round() as u64).into());
    }
    if let Some(mem) = r.memory_bytes.filter(|v| *v > 0.0) {
        let mem = mem.round() as u64;
        const MI: u64 = 1024 * 1024;
        requests.insert("memory".into(), if mem.is_multiple_of(MI) { format!("{}Mi", mem / MI) } else { mem.to_string() }.into());
    }
    if requests.is_empty() {
        return Err("Nothing to change: give a CPU or memory request".into());
    }
    Ok(requests)
}

/// A strategic merge patch that sets one container's requests, in whichever list holds it
/// (sidecars live in initContainers); both lists merge by container name.
fn requests_patch(spec: &PodSpec, container: &str, requests: &serde_json::Map<String, Value>) -> CmdResult<Value> {
    let list = match running_containers(spec).find(|(c, _)| c.name == container) {
        Some((_, false)) => "containers",
        Some((_, true)) => "initContainers",
        None => return Err(format!("No container named {container}")),
    };
    Ok(json!({ "spec": { list: [{ "name": container, "resources": { "requests": requests } }] } }))
}

/// Sets new requests on a workload container, either on its running pods through the
/// pods/resize subresource (Kubernetes 1.33+, no restart) or on the workload's template.
#[tauri::command]
pub async fn apply_requests(request: NewRequests, to: ApplyTo, dry_run: bool, state: Session) -> CmdResult<Vec<ApplyOutcome>> {
    if !dry_run {
        state.writable()?;
    }
    let requests = quantities(&request)?;
    let conn = state.connection().await?;
    let pp = PatchParams { dry_run, ..Default::default() };

    if to == ApplyTo::Workload {
        if !TEMPLATED.contains(&request.kind_key.as_str()) {
            return Err("Only Deployments, StatefulSets and DaemonSets have a pod template to update; resize the running pods instead".into());
        }
        let ar = conn.kind(&request.kind_key)?.api_resource();
        let api: Api<DynamicObject> = Api::namespaced_with(conn.client, &request.namespace, &ar);
        let object = api.get(&request.workload).await.map_err(|e| kube_err(&e))?;
        let spec: PodSpec = serde_json::from_value(object.data["spec"]["template"]["spec"].clone()).map_err(|e| e.to_string())?;
        let patch = json!({ "spec": { "template": requests_patch(&spec, &request.container, &requests)? } });
        api.patch(&request.workload, &pp, &Patch::Strategic(&patch)).await.map_err(|e| kube_err(&e))?;
        let message = if dry_run { "the server accepts the new template" } else { "template updated; its pods are replaced as in a rollout" };
        return Ok(vec![ApplyOutcome { target: request.workload, ok: true, message: message.into() }]);
    }

    let api = Api::<Pod>::namespaced(conn.client, &request.namespace);
    let pods = api.list(&ListParams::default().fields("status.phase=Running")).await.map_err(|e| kube_err(&e))?.items;
    // Pods on their way out (a rollout in progress) would only waste a resize.
    let pods: Vec<Pod> = pods
        .into_iter()
        .filter(|p| p.metadata.deletion_timestamp.is_none() && owner(p) == (request.kind_key.clone(), request.workload.clone()))
        .collect();
    if pods.is_empty() {
        return Err(format!("{} has no running pods to resize", request.workload));
    }
    let mut out = Vec::new();
    for pod in pods {
        let name = pod.metadata.name.clone().unwrap_or_default();
        let result = match pod.spec.as_ref().map(|s| requests_patch(s, &request.container, &requests)) {
            Some(Ok(patch)) => api.patch_subresource("resize", &name, &pp, &Patch::Strategic(&patch)).await.map_err(|e| kube_err(&e)),
            Some(Err(e)) => Err(e),
            None => Err("pod without a spec".into()),
        };
        out.push(match result {
            Ok(_) if dry_run => ApplyOutcome { target: name, ok: true, message: "the server accepts the resize".into() },
            Ok(_) => ApplyOutcome { target: name, ok: true, message: "resized in place; the kubelet applies it without a restart".into() },
            Err(e) => ApplyOutcome { target: name, ok: false, message: e },
        });
    }
    Ok(out)
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

    #[test]
    fn pods_without_a_workload_stand_for_themselves() {
        let pod: Pod = serde_json::from_value(json!({ "metadata": { "name": "p-1" } })).unwrap();
        assert_eq!(owner(&pod), ("pods".into(), "p-1".into()));
    }

    #[test]
    fn builds_resize_patches() {
        let spec: PodSpec = serde_json::from_value(json!({
            "containers": [{ "name": "app" }],
            "initContainers": [{ "name": "setup" }, { "name": "proxy", "restartPolicy": "Always" }]
        }))
        .unwrap();
        let r = NewRequests { namespace: "n".into(), kind_key: "pods".into(), workload: "w".into(), container: "app".into(), cpu_millis: Some(249.6), memory_bytes: Some(96.0 * 1024.0 * 1024.0) };
        let q = quantities(&r).unwrap();
        assert_eq!(Value::Object(q.clone()), json!({ "cpu": "250m", "memory": "96Mi" }));
        assert_eq!(requests_patch(&spec, "app", &q).unwrap(), json!({ "spec": { "containers": [{ "name": "app", "resources": { "requests": { "cpu": "250m", "memory": "96Mi" } } }] } }));
        assert!(requests_patch(&spec, "proxy", &q).unwrap()["spec"]["initContainers"].is_array());
        // Plain init containers have finished by the time anyone resizes.
        assert!(requests_patch(&spec, "setup", &q).is_err());
        assert!(quantities(&NewRequests { cpu_millis: None, memory_bytes: None, ..r }).is_err());
    }
}
