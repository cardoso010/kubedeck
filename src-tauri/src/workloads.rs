//! Everyday workload actions: restart, scale, pause, rollout history and rollback, plus the
//! events of any object.

use k8s_openapi::api::apps::v1::{Deployment, ReplicaSet};
use k8s_openapi::api::core::v1::Event;
use kube::api::{Api, ListParams, Patch, PatchParams};
use serde::Serialize;
use serde_json::json;

use crate::state::{kube_err, CmdResult, Session};

/// Kinds that have a pod template (restart) or a replica count (scale), by kind key.
const RESTARTABLE: &[&str] = &["deployments", "statefulsets", "daemonsets"];
const SCALABLE: &[&str] = &["deployments", "statefulsets"];

async fn dynamic_api(state: &Session, kind_key: &str, namespace: &str) -> CmdResult<Api<kube::api::DynamicObject>> {
    let conn = state.connection().await?;
    let def = conn.kind(kind_key)?;
    Ok(Api::namespaced_with(conn.client, namespace, &def.api_resource()))
}

/// `kubectl rollout restart`: bumps a pod-template annotation so every pod is replaced.
#[tauri::command]
pub async fn rollout_restart(kind_key: String, namespace: String, name: String, state: Session) -> CmdResult<()> {
    if !RESTARTABLE.contains(&kind_key.as_str()) {
        return Err(format!("{kind_key} cannot be restarted"));
    }
    // Like kubectl: an RFC 3339 timestamp, so every restart changes the template.
    let now = jiff::Timestamp::now().to_string();
    let patch = json!({ "spec": { "template": { "metadata": { "annotations": { "kubectl.kubernetes.io/restartedAt": now } } } } });
    dynamic_api(&state, &kind_key, &namespace)
        .await?
        .patch(&name, &PatchParams::default(), &Patch::Merge(&patch))
        .await
        .map_err(|e| kube_err(&e))?;
    Ok(())
}

#[tauri::command]
pub async fn scale(kind_key: String, namespace: String, name: String, replicas: i32, state: Session) -> CmdResult<()> {
    if !SCALABLE.contains(&kind_key.as_str()) {
        return Err(format!("{kind_key} cannot be scaled"));
    }
    if !(0..=1000).contains(&replicas) {
        return Err("Replicas must be between 0 and 1000".into());
    }
    let patch = json!({ "spec": { "replicas": replicas } });
    dynamic_api(&state, &kind_key, &namespace)
        .await?
        .patch(&name, &PatchParams::default(), &Patch::Merge(&patch))
        .await
        .map_err(|e| kube_err(&e))?;
    Ok(())
}

/// `kubectl rollout pause|resume` for deployments.
#[tauri::command]
pub async fn set_paused(namespace: String, name: String, paused: bool, state: Session) -> CmdResult<()> {
    let api: Api<Deployment> = Api::namespaced(state.connection().await?.client, &namespace);
    api.patch(&name, &PatchParams::default(), &Patch::Merge(&json!({ "spec": { "paused": paused } })))
        .await
        .map_err(|e| kube_err(&e))?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    revision: i64,
    replica_set: String,
    created: Option<String>,
    replicas: i32,
    images: Vec<String>,
    change_cause: Option<String>,
    current: bool,
    /// The pod template of this revision, for diffing revisions.
    template_yaml: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RolloutStatus {
    replicas: i32,
    ready: i32,
    updated: i32,
    available: i32,
    paused: bool,
    revisions: Vec<Revision>,
}

const REVISION: &str = "deployment.kubernetes.io/revision";

async fn owned_replica_sets(api_rs: &Api<ReplicaSet>, deployment: &Deployment) -> CmdResult<Vec<ReplicaSet>> {
    let uid = deployment.metadata.uid.clone().unwrap_or_default();
    let labels = deployment
        .spec
        .as_ref()
        .and_then(|s| s.selector.match_labels.clone())
        .unwrap_or_default()
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join(",");
    let list = api_rs.list(&ListParams::default().labels(&labels)).await.map_err(|e| kube_err(&e))?;
    Ok(list
        .items
        .into_iter()
        .filter(|rs| rs.metadata.owner_references.iter().flatten().any(|o| o.uid == uid))
        .collect())
}

fn revision_of(rs: &ReplicaSet) -> i64 {
    rs.metadata.annotations.as_ref().and_then(|a| a.get(REVISION)).and_then(|r| r.parse().ok()).unwrap_or(0)
}

/// A ReplicaSet's pod template as the deployment would carry it (without the hash label).
fn template_of(rs: &ReplicaSet) -> Option<k8s_openapi::api::core::v1::PodTemplateSpec> {
    let mut template = rs.spec.as_ref()?.template.clone()?;
    if let Some(labels) = template.metadata.as_mut().and_then(|m| m.labels.as_mut()) {
        labels.remove("pod-template-hash");
    }
    Some(template)
}

/// Replica counts and the revision history of a deployment, newest first.
#[tauri::command]
pub async fn rollout_status(namespace: String, name: String, state: Session) -> CmdResult<RolloutStatus> {
    let client = state.connection().await?.client;
    let deployment = Api::<Deployment>::namespaced(client.clone(), &namespace).get(&name).await.map_err(|e| kube_err(&e))?;
    let current = deployment.metadata.annotations.as_ref().and_then(|a| a.get(REVISION)).and_then(|r| r.parse::<i64>().ok());
    let mut revisions: Vec<Revision> = owned_replica_sets(&Api::namespaced(client, &namespace), &deployment)
        .await?
        .iter()
        .map(|rs| {
            let template = template_of(rs);
            let revision = revision_of(rs);
            Revision {
                revision,
                replica_set: rs.metadata.name.clone().unwrap_or_default(),
                created: rs.metadata.creation_timestamp.as_ref().and_then(|t| serde_json::to_value(t).ok()).and_then(|v| v.as_str().map(str::to_owned)),
                replicas: rs.status.as_ref().map(|s| s.replicas).unwrap_or(0),
                images: template.iter().flat_map(|t| t.spec.iter()).flat_map(|s| s.containers.iter()).filter_map(|c| c.image.clone()).collect(),
                change_cause: rs.metadata.annotations.as_ref().and_then(|a| a.get("kubernetes.io/change-cause")).cloned(),
                current: Some(revision) == current,
                template_yaml: template.and_then(|t| serde_yaml::to_string(&t).ok()).unwrap_or_default(),
            }
        })
        .collect();
    revisions.sort_by_key(|r| std::cmp::Reverse(r.revision));
    let status = deployment.status.unwrap_or_default();
    let spec = deployment.spec.unwrap_or_default();
    Ok(RolloutStatus {
        replicas: spec.replicas.unwrap_or(1),
        ready: status.ready_replicas.unwrap_or(0),
        updated: status.updated_replicas.unwrap_or(0),
        available: status.available_replicas.unwrap_or(0),
        paused: spec.paused.unwrap_or(false),
        revisions,
    })
}

/// `kubectl rollout undo --to-revision`: puts that revision's pod template back, which the
/// deployment controller rolls out as a new revision.
#[tauri::command]
pub async fn rollback(namespace: String, name: String, revision: i64, state: Session) -> CmdResult<()> {
    let client = state.connection().await?.client;
    let api: Api<Deployment> = Api::namespaced(client.clone(), &namespace);
    let deployment = api.get(&name).await.map_err(|e| kube_err(&e))?;
    let target = owned_replica_sets(&Api::namespaced(client, &namespace), &deployment)
        .await?
        .into_iter()
        .find(|rs| revision_of(rs) == revision)
        .ok_or_else(|| format!("Revision {revision} not found (its ReplicaSet may have been cleaned up)"))?;
    let template = template_of(&target).ok_or("That revision has no pod template")?;
    // Replace only the template: a full update would race the controller, which keeps
    // writing the deployment while a rollout is going on, and a merge patch could not
    // remove keys the old template did not have.
    let patch: json_patch::Patch = serde_json::from_value(json!([
        { "op": "replace", "path": "/spec/template", "value": template }
    ]))
    .map_err(|e| e.to_string())?;
    api.patch(&name, &PatchParams::default(), &Patch::Json::<()>(patch)).await.map_err(|e| kube_err(&e))?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRow {
    /// Normal or Warning.
    r#type: String,
    reason: String,
    message: String,
    count: i32,
    last_seen: Option<String>,
    source: String,
}

/// Events about one object, newest first.
#[tauri::command]
pub async fn object_events(namespace: Option<String>, uid: String, state: Session) -> CmdResult<Vec<EventRow>> {
    let client = state.connection().await?.client;
    let api: Api<Event> = match &namespace {
        Some(ns) => Api::namespaced(client, ns),
        None => Api::all(client),
    };
    let list = api.list(&ListParams::default().fields(&format!("involvedObject.uid={uid}"))).await.map_err(|e| kube_err(&e))?;
    let time = |v: Option<serde_json::Value>| v.and_then(|v| v.as_str().map(str::to_owned));
    let mut rows: Vec<EventRow> = list
        .items
        .into_iter()
        .map(|e| {
            let last = time(e.last_timestamp.as_ref().and_then(|t| serde_json::to_value(t).ok()))
                .or_else(|| time(e.event_time.as_ref().and_then(|t| serde_json::to_value(t).ok())))
                .or_else(|| time(e.metadata.creation_timestamp.as_ref().and_then(|t| serde_json::to_value(t).ok())));
            EventRow {
                r#type: e.type_.unwrap_or_default(),
                reason: e.reason.unwrap_or_default(),
                message: e.message.unwrap_or_default(),
                count: e.count.unwrap_or(1),
                last_seen: last,
                source: e.reporting_component.filter(|s| !s.is_empty()).or_else(|| e.source.and_then(|s| s.component)).unwrap_or_default(),
            }
        })
        .collect();
    rows.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
    Ok(rows)
}
