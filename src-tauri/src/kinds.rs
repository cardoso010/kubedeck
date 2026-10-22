//! Resource kinds the UI can browse, and how each one is summarized into table rows.

use kube::api::{ApiResource, DynamicObject, GroupVersionKind};
use serde::Serialize;
use serde_json::Value;

/// A browsable resource type: one of the built-ins below, or a CRD found on the cluster.
#[derive(Clone)]
pub struct KindDef {
    /// "pods" for built-ins; "<plural>.<group>" (like kubectl) for custom resources.
    pub key: String,
    pub label: String,
    pub group: String,
    pub version: String,
    pub kind: String,
    pub plural: String,
    pub namespaced: bool,
    pub columns: Vec<String>,
    /// For custom resources: the JSONPath of each column, from the CRD's printer columns.
    pub column_paths: Vec<String>,
    pub custom: bool,
}

impl KindDef {
    pub fn api_resource(&self) -> ApiResource {
        ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk(&self.group, &self.version, &self.kind), &self.plural)
    }
}

struct Builtin {
    key: &'static str,
    label: &'static str,
    group: &'static str,
    version: &'static str,
    kind: &'static str,
    namespaced: bool,
    columns: &'static [&'static str],
}

const BUILTINS: &[Builtin] = &[
    Builtin { key: "pods", label: "Pods", group: "", version: "v1", kind: "Pod", namespaced: true, columns: &["Ready", "Status", "Restarts", "Node"] },
    Builtin { key: "deployments", label: "Deployments", group: "apps", version: "v1", kind: "Deployment", namespaced: true, columns: &["Ready", "Up-to-date", "Available"] },
    Builtin { key: "statefulsets", label: "StatefulSets", group: "apps", version: "v1", kind: "StatefulSet", namespaced: true, columns: &["Ready"] },
    Builtin { key: "daemonsets", label: "DaemonSets", group: "apps", version: "v1", kind: "DaemonSet", namespaced: true, columns: &["Desired", "Ready"] },
    Builtin { key: "jobs", label: "Jobs", group: "batch", version: "v1", kind: "Job", namespaced: true, columns: &["Completions", "Status"] },
    Builtin { key: "cronjobs", label: "CronJobs", group: "batch", version: "v1", kind: "CronJob", namespaced: true, columns: &["Schedule", "Suspend", "Active"] },
    Builtin { key: "services", label: "Services", group: "", version: "v1", kind: "Service", namespaced: true, columns: &["Type", "Cluster IP", "Ports"] },
    Builtin { key: "ingresses", label: "Ingresses", group: "networking.k8s.io", version: "v1", kind: "Ingress", namespaced: true, columns: &["Class", "Hosts"] },
    Builtin { key: "configmaps", label: "ConfigMaps", group: "", version: "v1", kind: "ConfigMap", namespaced: true, columns: &["Keys"] },
    Builtin { key: "secrets", label: "Secrets", group: "", version: "v1", kind: "Secret", namespaced: true, columns: &["Type", "Keys"] },
    Builtin { key: "persistentvolumeclaims", label: "PersistentVolumeClaims", group: "", version: "v1", kind: "PersistentVolumeClaim", namespaced: true, columns: &["Status", "Capacity", "Storage class"] },
    Builtin { key: "events", label: "Events", group: "", version: "v1", kind: "Event", namespaced: true, columns: &["Type", "Reason", "Object", "Message"] },
    Builtin { key: "nodes", label: "Nodes", group: "", version: "v1", kind: "Node", namespaced: false, columns: &["Status", "Roles", "Version"] },
    Builtin { key: "namespaces", label: "Namespaces", group: "", version: "v1", kind: "Namespace", namespaced: false, columns: &["Status"] },
];

pub fn builtins() -> Vec<KindDef> {
    BUILTINS
        .iter()
        .map(|b| KindDef {
            key: b.key.into(),
            label: b.label.into(),
            group: b.group.into(),
            version: b.version.into(),
            kind: b.kind.into(),
            plural: b.key.into(),
            namespaced: b.namespaced,
            columns: b.columns.iter().map(|c| (*c).into()).collect(),
            column_paths: vec![],
            custom: false,
        })
        .collect()
}

/// Builds kinds from `CustomResourceDefinition` objects, using the storage version
/// (falling back to the first served one) and the printer columns `kubectl get` shows.
pub fn from_crds(crds: &[Value]) -> Vec<KindDef> {
    let mut kinds: Vec<KindDef> = crds
        .iter()
        .filter_map(|crd| {
            let spec = crd.get("spec")?;
            let group = spec["group"].as_str()?.to_owned();
            let plural = spec.pointer("/names/plural")?.as_str()?.to_owned();
            let versions = spec["versions"].as_array()?;
            let version = versions
                .iter()
                .find(|v| v["storage"] == true && v["served"] == true)
                .or_else(|| versions.iter().find(|v| v["served"] == true))?;
            let (columns, column_paths) = arr(version, "/additionalPrinterColumns")
                .iter()
                // kubectl hides priority > 0 columns without -o wide; Age is shown by the table already.
                .filter(|c| c["priority"].as_i64().unwrap_or(0) == 0 && c["jsonPath"] != ".metadata.creationTimestamp")
                .filter_map(|c| Some((c["name"].as_str()?.to_owned(), c["jsonPath"].as_str()?.to_owned())))
                .unzip();
            Some(KindDef {
                key: format!("{plural}.{group}"),
                label: spec.pointer("/names/kind")?.as_str()?.to_owned(),
                version: version["name"].as_str()?.to_owned(),
                kind: spec.pointer("/names/kind")?.as_str()?.to_owned(),
                namespaced: spec["scope"] == "Namespaced",
                group,
                plural,
                columns,
                column_paths,
                custom: true,
            })
        })
        .collect();
    kinds.sort_by(|a, b| (&a.group, &a.label).cmp(&(&b.group, &b.label)));
    kinds
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KindInfo {
    key: String,
    label: String,
    namespaced: bool,
    columns: Vec<String>,
    /// API group for custom resources, used to group them in the sidebar.
    group: Option<String>,
}

impl From<&KindDef> for KindInfo {
    fn from(k: &KindDef) -> Self {
        KindInfo {
            key: k.key.clone(),
            label: k.label.clone(),
            namespaced: k.namespaced,
            columns: k.columns.clone(),
            group: k.custom.then(|| k.group.clone()),
        }
    }
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
    /// Desired replicas, for workloads that can be scaled.
    pub replicas: Option<i32>,
    /// Deployments with rollouts paused.
    pub paused: bool,
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

    let cells = match def.key.as_str() {
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
        "persistentvolumeclaims" => vec![s(d, "/status/phase"), s(d, "/status/capacity/storage"), s(d, "/spec/storageClassName")],
        _ => {
            // Custom resources: printer column paths are relative to the whole object,
            // and `data` holds everything but metadata.
            let mut root = d.clone();
            if let (Some(obj), Ok(m)) = (root.as_object_mut(), serde_json::to_value(meta)) {
                obj.insert("metadata".into(), m);
            }
            def.column_paths.iter().map(|p| json_path(&root, p)).collect()
        }
    };

    Row {
        uid: meta.uid.clone().unwrap_or_default(),
        name: meta.name.clone().unwrap_or_default(),
        namespace: meta.namespace.clone(),
        created,
        cells,
        containers,
        ports,
        replicas: matches!(def.key.as_str(), "deployments" | "statefulsets").then(|| d.pointer("/spec/replicas").and_then(Value::as_i64).unwrap_or(1) as i32),
        paused: d.pointer("/spec/paused").and_then(Value::as_bool).unwrap_or(false),
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

/// Evaluates the JSONPath subset used by CRD printer columns: `.a.b`, `.a[0]`,
/// `.a[*].b` and filters like `.conditions[?(@.type=="Ready")].status`.
pub fn json_path(root: &Value, path: &str) -> String {
    let mut current: Vec<&Value> = vec![root];
    let mut rest = path.trim().trim_start_matches('{').trim_end_matches('}').trim_start_matches('$');
    while !rest.is_empty() {
        if let Some(r) = rest.strip_prefix('.') {
            let end = r.find(['.', '[']).unwrap_or(r.len());
            let key = &r[..end];
            current = current.into_iter().filter_map(|v| v.get(key)).collect();
            rest = &r[end..];
        } else if let Some(r) = rest.strip_prefix('[') {
            let Some(end) = r.find(']') else { return String::new() };
            let selector = &r[..end];
            rest = &r[end + 1..];
            let items = current.into_iter().flat_map(|v| v.as_array().map(|a| a.iter().collect::<Vec<_>>()).unwrap_or_default());
            current = if selector == "*" {
                items.collect()
            } else if let Ok(i) = selector.parse::<usize>() {
                items.collect::<Vec<_>>().get(i).copied().into_iter().collect()
            } else if let Some(filter) = selector.strip_prefix("?(@.").and_then(|f| f.strip_suffix(')')) {
                let Some((field, expected)) = filter.split_once("==") else { return String::new() };
                let expected = expected.trim().trim_matches(['"', '\'']);
                items.filter(|v| v.get(field.trim()).map(scalar).as_deref() == Some(expected)).collect()
            } else {
                return String::new();
            };
        } else {
            return String::new();
        }
    }
    current.into_iter().map(scalar).collect::<Vec<_>>().join(",")
}

fn scalar(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn json_path_covers_printer_column_forms() {
        let obj = json!({
            "spec": { "replicas": 3, "hosts": ["a", "b"], "suspend": false },
            "status": { "phase": "Ready", "conditions": [
                { "type": "Synced", "status": "True" },
                { "type": "Ready", "status": "False", "reason": "Pending" }
            ]}
        });
        assert_eq!(json_path(&obj, ".status.phase"), "Ready");
        assert_eq!(json_path(&obj, ".spec.replicas"), "3");
        assert_eq!(json_path(&obj, ".spec.suspend"), "false");
        assert_eq!(json_path(&obj, ".spec.hosts[1]"), "b");
        assert_eq!(json_path(&obj, ".spec.hosts[*]"), "a,b");
        assert_eq!(json_path(&obj, r#".status.conditions[?(@.type=="Ready")].status"#), "False");
        assert_eq!(json_path(&obj, ".status.conditions[?(@.type=='Ready')].reason"), "Pending");
        assert_eq!(json_path(&obj, ".status.missing"), "");
        assert_eq!(json_path(&obj, "{.status.phase}"), "Ready");
    }

    #[test]
    fn crds_become_kinds_with_printer_columns() {
        let crd = json!({ "spec": {
            "group": "cert-manager.io",
            "names": { "kind": "Certificate", "plural": "certificates" },
            "scope": "Namespaced",
            "versions": [
                { "name": "v1alpha2", "served": true, "storage": false },
                { "name": "v1", "served": true, "storage": true, "additionalPrinterColumns": [
                    { "name": "Ready", "jsonPath": ".status.conditions[?(@.type==\"Ready\")].status" },
                    { "name": "Secret", "jsonPath": ".spec.secretName" },
                    { "name": "Issuer", "jsonPath": ".spec.issuerRef.name", "priority": 1 },
                    { "name": "Age", "jsonPath": ".metadata.creationTimestamp" }
                ]}
            ]
        }});
        let kinds = from_crds(&[crd]);
        assert_eq!(kinds.len(), 1);
        let k = &kinds[0];
        assert_eq!(k.key, "certificates.cert-manager.io");
        assert_eq!(k.version, "v1");
        assert!(k.namespaced && k.custom);
        assert_eq!(k.columns, ["Ready", "Secret"]);
    }
}
