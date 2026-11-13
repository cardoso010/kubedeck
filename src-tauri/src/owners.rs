//! Which workload owns a pod, read from the pod alone (no extra API calls).

use k8s_openapi::api::core::v1::Pod;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{ObjectMeta, OwnerReference};

/// The object's managing controller: the owner reference marked `controller: true`.
pub fn controller(meta: &ObjectMeta) -> Option<&OwnerReference> {
    meta.owner_references.iter().flatten().find(|o| o.controller == Some(true))
}

/// The workload a pod belongs to, as (kind key, name). A ReplicaSet is traced to its
/// Deployment by the pod-template-hash suffix the Deployment controller always adds (a bare
/// ReplicaSet has none); a Job's CronJob takes another lookup, so Jobs stop at the Job.
pub fn workload_of(pod: &Pod) -> Option<(&'static str, String)> {
    let o = controller(&pod.metadata)?;
    match o.kind.as_str() {
        "ReplicaSet" => {
            let hash = pod.metadata.labels.as_ref()?.get("pod-template-hash")?;
            Some(("deployments", o.name.strip_suffix(&format!("-{hash}"))?.to_owned()))
        }
        "StatefulSet" => Some(("statefulsets", o.name.clone())),
        "DaemonSet" => Some(("daemonsets", o.name.clone())),
        "Job" => Some(("jobs", o.name.clone())),
        _ => None,
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
        assert_eq!(workload_of(&pod(Some("ReplicaSet"), "web-7c6cdd646", Some("7c6cdd646"))), Some(("deployments", "web".into())));
        assert_eq!(workload_of(&pod(Some("ReplicaSet"), "plain-rs", None)), None, "a bare ReplicaSet");
        assert_eq!(workload_of(&pod(Some("StatefulSet"), "db", None)), Some(("statefulsets", "db".into())));
        assert_eq!(workload_of(&pod(Some("Job"), "migrate-29", None)), Some(("jobs", "migrate-29".into())));
        assert_eq!(workload_of(&pod(None, "", None)), None);
    }
}
