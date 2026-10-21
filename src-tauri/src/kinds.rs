//! Resource kinds the UI can browse, and how each one is summarized into table rows.

use kube::api::{ApiResource, DynamicObject, GroupVersionKind};
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Copy)]
pub struct KindDef {
    pub key: &'static str,
    pub label: &'static str,
    pub group: &'static str,
    pub version: &'static str,
    pub kind: &'static str,
    pub plural: &'static str,
    pub namespaced: bool,
    pub columns: &'static [&'static str],
}

impl KindDef {
    pub fn api_resource(&self) -> ApiResource {
        ApiResource::from_gvk_with_plural(
            &GroupVersionKind::gvk(self.group, self.version, self.kind),
            self.plural,
        )
    }
}

pub const KINDS: &[KindDef] = &[
    KindDef { key: "pods", label: "Pods", group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true, columns: &["Ready", "Status", "Restarts", "Node"] },
    KindDef { key: "deployments", label: "Deployments", group: "apps", version: "v1", kind: "Deployment", plural: "deployments", namespaced: true, columns: &["Ready", "Up-to-date", "Available"] },
    KindDef { key: "statefulsets", label: "StatefulSets", group: "apps", version: "v1", kind: "StatefulSet", plural: "statefulsets", namespaced: true, columns: &["Ready"] },
    KindDef { key: "daemonsets", label: "DaemonSets", group: "apps", version: "v1", kind: "DaemonSet", plural: "daemonsets", namespaced: true, columns: &["Desired", "Ready"] },
    KindDef { key: "jobs", label: "Jobs", group: "batch", version: "v1", kind: "Job", plural: "jobs", namespaced: true, columns: &["Completions", "Status"] },
    KindDef { key: "cronjobs", label: "CronJobs", group: "batch", version: "v1", kind: "CronJob", plural: "cronjobs", namespaced: true, columns: &["Schedule", "Suspend", "Active"] },
    KindDef { key: "services", label: "Services", group: "", version: "v1", kind: "Service", plural: "services", namespaced: true, columns: &["Type", "Cluster IP", "Ports"] },
    KindDef { key: "ingresses", label: "Ingresses", group: "networking.k8s.io", version: "v1", kind: "Ingress", plural: "ingresses", namespaced: true, columns: &["Class", "Hosts"] },
    KindDef { key: "configmaps", label: "ConfigMaps", group: "", version: "v1", kind: "ConfigMap", plural: "configmaps", namespaced: true, columns: &["Keys"] },
    KindDef { key: "secrets", label: "Secrets", group: "", version: "v1", kind: "Secret", plural: "secrets", namespaced: true, columns: &["Type", "Keys"] },
    KindDef { key: "events", label: "Events", group: "", version: "v1", kind: "Event", plural: "events", namespaced: true, columns: &["Type", "Reason", "Object", "Message"] },
    KindDef { key: "nodes", label: "Nodes", group: "", version: "v1", kind: "Node", plural: "nodes", namespaced: false, columns: &["Status", "Roles", "Version"] },
    KindDef { key: "namespaces", label: "Namespaces", group: "", version: "v1", kind: "Namespace", plural: "namespaces", namespaced: false, columns: &["Status"] },
];

pub fn find(key: &str) -> Option<&'static KindDef> {
    KINDS.iter().find(|k| k.key == key)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KindInfo {
    key: &'static str,
    label: &'static str,
    namespaced: bool,
    columns: &'static [&'static str],
}

pub fn infos() -> Vec<KindInfo> {
    KINDS
        .iter()
        .map(|k| KindInfo { key: k.key, label: k.label, namespaced: k.namespaced, columns: k.columns })
        .collect()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub uid: String,
    pub name: String,
    pub namespace: Option<String>,
    pub created: Option<String>,
    pub cells: Vec<String>,
    /// Container names, for pods only (used by logs and terminal).
    pub containers: Vec<String>,
    /// TCP ports that can be port-forwarded (container ports for pods, service ports for services).
    pub ports: Vec<u16>,
}

pub fn summarize(def: &KindDef, obj: &DynamicObject) -> Row {
    let meta = &obj.metadata;
    let d = &obj.data;
    let created = meta
        .creation_timestamp
        .as_ref()
        .and_then(|t| serde_json::to_value(t).ok())
        .and_then(|v| v.as_str().map(str::to_owned));
    let mut containers = Vec::new();
    let mut ports = Vec::new();

    let cells = match def.key {
        "pods" => {
            let statuses = arr(d, "/status/containerStatuses");
            let total = arr(d, "/spec/containers").len();
            let ready = statuses.iter().filter(|c| c["ready"].as_bool() == Some(true)).count();
            let restarts: i64 = statuses.iter().filter_map(|c| c["restartCount"].as_i64()).sum();
            containers = arr(d, "/spec/containers").iter().filter_map(|c| c["name"].as_str().map(str::to_owned)).collect();
            ports = arr(d, "/spec/containers").iter().flat_map(|c| tcp_ports(c.get("ports"), "containerPort")).collect();
            vec![format!("{ready}/{total}"), pod_status(d, meta.deletion_timestamp.is_some()), restarts.to_string(), s(d, "/spec/nodeName")]
        }
        "deployments" => vec![
            format!("{}/{}", n(d, "/status/readyReplicas"), n(d, "/spec/replicas")),
            n(d, "/status/updatedReplicas"),
            n(d, "/status/availableReplicas"),
        ],
        "statefulsets" => vec![format!("{}/{}", n(d, "/status/readyReplicas"), n(d, "/spec/replicas"))],
        "daemonsets" => vec![n(d, "/status/desiredNumberScheduled"), n(d, "/status/numberReady")],
        "jobs" => {
            let done = arr(d, "/status/conditions").iter().find(|c| c["status"] == "True").and_then(|c| c["type"].as_str()).unwrap_or("Running").to_owned();
            vec![format!("{}/{}", n(d, "/status/succeeded"), n(d, "/spec/completions")), done]
        }
        "cronjobs" => vec![s(d, "/spec/schedule"), d.pointer("/spec/suspend").and_then(Value::as_bool).unwrap_or(false).to_string(), arr(d, "/status/active").len().to_string()],
        "services" => {
            ports = tcp_ports(d.pointer("/spec/ports"), "port");
            let port_list = arr(d, "/spec/ports")
                .iter()
                .map(|p| format!("{}/{}", p["port"], p["protocol"].as_str().unwrap_or("TCP")))
                .collect::<Vec<_>>()
                .join(", ");
            vec![s(d, "/spec/type"), s(d, "/spec/clusterIP"), port_list]
        }
        "ingresses" => {
            let hosts = arr(d, "/spec/rules").iter().filter_map(|r| r["host"].as_str()).collect::<Vec<_>>().join(", ");
            vec![s(d, "/spec/ingressClassName"), hosts]
        }
        "configmaps" => vec![key_count(d, &["data", "binaryData"])],
        // Only key names are counted: secret values never leave the backend in table rows.
        "secrets" => vec![s(d, "/type"), key_count(d, &["data", "stringData"])],
        "events" => vec![
            s(d, "/type"),
            s(d, "/reason"),
            format!("{}/{}", s(d, "/involvedObject/kind"), s(d, "/involvedObject/name")),
            s(d, "/message"),
        ],
        "nodes" => {
            let ready = arr(d, "/status/conditions").iter().find(|c| c["type"] == "Ready").map(|c| if c["status"] == "True" { "Ready" } else { "NotReady" }).unwrap_or("Unknown");
            let roles = meta
                .labels
                .iter()
                .flatten()
                .filter_map(|(k, _)| k.strip_prefix("node-role.kubernetes.io/"))
                .collect::<Vec<_>>()
                .join(",");
            vec![ready.to_owned(), roles, s(d, "/status/nodeInfo/kubeletVersion")]
        }
        "namespaces" => vec![s(d, "/status/phase")],
        _ => vec![],
    };

    Row {
        uid: meta.uid.clone().unwrap_or_default(),
        name: meta.name.clone().unwrap_or_default(),
        namespace: meta.namespace.clone(),
        created,
        cells,
        containers,
        ports,
    }
}

fn tcp_ports(list: Option<&Value>, field: &str) -> Vec<u16> {
    list.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|p| p["protocol"].as_str().unwrap_or("TCP") == "TCP")
        .filter_map(|p| p[field].as_u64().and_then(|n| u16::try_from(n).ok()))
        .collect()
}

/// Mirrors the STATUS column of `kubectl get pods`.
fn pod_status(d: &Value, deleting: bool) -> String {
    if deleting {
        return "Terminating".into();
    }
    for c in arr(d, "/status/containerStatuses") {
        if let Some(reason) = c.pointer("/state/waiting/reason").and_then(Value::as_str) {
            return reason.into();
        }
        if let Some(reason) = c.pointer("/state/terminated/reason").and_then(Value::as_str) {
            return reason.into();
        }
    }
    s(d, "/status/phase")
}

fn arr<'a>(d: &'a Value, ptr: &str) -> &'a [Value] {
    d.pointer(ptr).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn s(d: &Value, ptr: &str) -> String {
    d.pointer(ptr).and_then(Value::as_str).unwrap_or("").to_owned()
}

fn n(d: &Value, ptr: &str) -> String {
    d.pointer(ptr).and_then(Value::as_i64).unwrap_or(0).to_string()
}

fn key_count(d: &Value, fields: &[&str]) -> String {
    fields.iter().filter_map(|f| d.get(*f).and_then(Value::as_object)).map(|m| m.len()).sum::<usize>().to_string()
}
