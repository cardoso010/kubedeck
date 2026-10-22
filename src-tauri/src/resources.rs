//! Watching, reading, editing and deleting resources of any kind the connection knows.

use std::collections::HashMap;

use futures::StreamExt;
use kube::api::{Api, DeleteParams, DynamicObject, GroupVersionKind, PostParams};
use serde::Deserialize;
use kube::runtime::{watcher, WatchStreamExt};
use serde::Serialize;
use tauri::ipc::Channel;

use crate::kinds::{self, KindDef, KindInfo, Row};
use crate::state::{err, is_unauthorized, kube_err, AppState, CmdResult, Session};

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WatchMsg {
    /// Full list, sent once the initial listing finishes and again after every re-list.
    Snapshot { rows: Vec<Row> },
    Upsert { row: Row },
    Delete { uid: String },
    /// `unauthorized`: the cluster rejected the credentials, so retrying the same ones is pointless.
    Error { message: String, unauthorized: bool },
}

/// Built-in kinds before connecting; built-ins plus the cluster's custom resources after.
#[tauri::command]
pub async fn list_kinds(state: Session) -> CmdResult<Vec<KindInfo>> {
    Ok(match state.conn.read().await.as_ref() {
        Some(conn) => conn.kinds.iter().map(KindInfo::from).collect(),
        None => kinds::builtins().iter().map(KindInfo::from).collect(),
    })
}

/// The kind definition and an API handle for it, scoped to `namespace` when the kind is namespaced.
async fn api_for(state: &AppState, kind_key: &str, namespace: Option<&str>) -> CmdResult<(KindDef, Api<DynamicObject>)> {
    let conn = state.connection().await?;
    let def = conn.kind(kind_key)?;
    let ar = def.api_resource();
    let api = match (def.namespaced, namespace) {
        (true, Some(ns)) => Api::namespaced_with(conn.client, ns, &ar),
        _ => Api::all_with(conn.client, &ar),
    };
    Ok((def, api))
}

/// Starts a watch and returns its stream id; stop it with `stop_stream`.
///
/// `namespaces` empty (or a cluster-scoped kind) watches everything. Otherwise there is one
/// watch per namespace, since the API cannot list "namespace in (a, b)" and watching the whole
/// cluster to filter here would be heavy and needs cluster-wide RBAC. Their events are merged
/// into one stream.
#[tauri::command]
pub async fn watch_resources(
    kind_key: String,
    namespaces: Vec<String>,
    on_event: Channel<WatchMsg>,
    state: Session,
) -> CmdResult<u64> {
    let conn = state.connection().await?;
    let def = conn.kind(&kind_key)?;
    let ar = def.api_resource();
    let scopes: Vec<(Option<String>, Api<DynamicObject>)> = if !def.namespaced || namespaces.is_empty() {
        vec![(None, Api::all_with(conn.client.clone(), &ar))]
    } else {
        namespaces.into_iter().map(|ns| (Some(ns.clone()), Api::namespaced_with(conn.client.clone(), &ns, &ar))).collect()
    };
    let id = state.next_id();

    let task = tauri::async_runtime::spawn(async move {
        let labels: Vec<Option<String>> = scopes.iter().map(|(ns, _)| ns.clone()).collect();
        let streams = scopes
            .into_iter()
            .enumerate()
            .map(|(i, (_, api))| watcher(api, watcher::Config::default()).default_backoff().map(move |e| (i, e)).boxed());
        let mut merged = futures::stream::select_all(streams);

        let n = labels.len();
        let mut current: Vec<HashMap<String, Row>> = vec![HashMap::new(); n];
        let mut initial: Vec<Vec<Row>> = vec![Vec::new(); n];
        // A scope counts as listed after its first full list, or its first error (e.g. no RBAC
        // in that namespace), so one bad namespace cannot keep the table loading forever.
        let mut listed = vec![false; n];
        let snapshot = |current: &[HashMap<String, Row>]| WatchMsg::Snapshot { rows: current.iter().flat_map(|m| m.values().cloned()).collect() };

        while let Some((i, event)) = merged.next().await {
            let mut msgs = Vec::new();
            match event {
                Ok(watcher::Event::Init) => initial[i].clear(),
                Ok(watcher::Event::InitApply(obj)) => initial[i].push(kinds::summarize(&def, &obj)),
                Ok(watcher::Event::InitDone) => {
                    current[i] = std::mem::take(&mut initial[i]).into_iter().map(|r| (r.uid.clone(), r)).collect();
                    listed[i] = true;
                    // Fill the table in one go once every scope has listed; later re-lists resend all.
                    if listed.iter().all(|l| *l) {
                        msgs.push(snapshot(&current));
                    }
                }
                Ok(watcher::Event::Apply(obj)) => {
                    let row = kinds::summarize(&def, &obj);
                    current[i].insert(row.uid.clone(), row.clone());
                    msgs.push(WatchMsg::Upsert { row });
                }
                Ok(watcher::Event::Delete(obj)) => {
                    let uid = obj.metadata.uid.unwrap_or_default();
                    current[i].remove(&uid);
                    msgs.push(WatchMsg::Delete { uid });
                }
                // The backoff keeps the watch alive; the UI just shows the latest error.
                Err(e) => {
                    let (detail, unauthorized) = match &e {
                        watcher::Error::InitialListFailed(k) | watcher::Error::WatchStartFailed(k) | watcher::Error::WatchFailed(k) => (kube_err(k), is_unauthorized(k)),
                        other => (other.to_string(), false),
                    };
                    let message = match &labels[i] {
                        Some(ns) => format!("{ns}: {detail}"),
                        None => detail,
                    };
                    msgs.push(WatchMsg::Error { message, unauthorized });
                    if !std::mem::replace(&mut listed[i], true) && listed.iter().all(|l| *l) {
                        msgs.push(snapshot(&current));
                    }
                }
            }
            for msg in msgs {
                if on_event.send(msg).is_err() {
                    return; // the window went away
                }
            }
        }
    });
    state.track(id, task);
    Ok(id)
}

#[tauri::command]
pub fn stop_stream(id: u64, state: Session) {
    state.stop(id);
}

#[tauri::command]
pub async fn get_yaml(kind_key: String, namespace: Option<String>, name: String, reveal: Option<bool>, state: Session) -> CmdResult<String> {
    let (_, api) = api_for(&state, &kind_key, namespace.as_deref()).await?;
    let mut obj = api.get(&name).await.map_err(err)?;
    // Same noise `kubectl edit` hides; it also cannot be sent back on replace.
    obj.metadata.managed_fields = None;
    if kind_key == "secrets" && reveal != Some(true) {
        crate::secrets::mask(&mut obj);
    }
    serde_yaml::to_string(&obj).map_err(err)
}

/// Replaces the object with the edited YAML. The `resourceVersion` it carries makes the
/// API server reject the write if someone else changed the object meanwhile.
#[tauri::command]
pub async fn replace_yaml(
    kind_key: String,
    namespace: Option<String>,
    name: String,
    yaml: String,
    state: Session,
) -> CmdResult<String> {
    state.writable()?;
    let (_, api) = api_for(&state, &kind_key, namespace.as_deref()).await?;
    let mut obj: DynamicObject = serde_yaml::from_str(&yaml).map_err(|e| format!("Invalid YAML: {e}"))?;
    if obj.metadata.name.as_deref() != Some(name.as_str()) {
        return Err("Changing metadata.name is not supported; create a new resource instead".into());
    }
    obj.metadata.managed_fields = None;
    let mut saved = api.replace(&name, &PostParams { field_manager: Some("kubedeck".into()), ..Default::default() }, &obj).await.map_err(err)?;
    saved.metadata.managed_fields = None;
    serde_yaml::to_string(&saved).map_err(err)
}

#[tauri::command]
pub async fn delete_resource(kind_key: String, namespace: Option<String>, name: String, state: Session) -> CmdResult<()> {
    state.writable()?;
    let (_, api) = api_for(&state, &kind_key, namespace.as_deref()).await?;
    api.delete(&name, &DeleteParams::default()).await.map_err(err)?;
    Ok(())
}

/// Creates every object in `yaml` (one or more documents separated by `---`), in order.
/// Namespaced objects without a namespace go to `namespace`. With `dry_run` the API server
/// validates them without saving. Returns "Kind name" for each one.
#[tauri::command]
pub async fn create_resources(yaml: String, namespace: Option<String>, dry_run: bool, state: Session) -> CmdResult<Vec<String>> {
    if !dry_run {
        state.writable()?;
    }
    let client = state.connection().await?.client;
    let mut docs = Vec::new();
    for (i, doc) in serde_yaml::Deserializer::from_str(&yaml).enumerate() {
        let value = serde_yaml::Value::deserialize(doc).map_err(|e| format!("Document {}: invalid YAML: {e}", i + 1))?;
        if value.is_null() {
            continue;
        }
        let obj: DynamicObject = serde_yaml::from_value(value).map_err(|e| format!("Document {}: {e}", i + 1))?;
        docs.push(obj);
    }
    if docs.is_empty() {
        return Err("Nothing to create: the YAML has no objects".into());
    }
    let params = PostParams { dry_run, field_manager: Some("kubedeck".into()) };
    let mut created = Vec::new();
    for (i, mut obj) in docs.into_iter().enumerate() {
        let types = obj.types.clone().ok_or_else(|| format!("Document {}: apiVersion and kind are required", i + 1))?;
        let gvk = GroupVersionKind::try_from(&types).map_err(|e| format!("Document {}: {e}", i + 1))?;
        let (ar, caps) = kube::discovery::pinned_kind(&client, &gvk).await.map_err(|e| format!("Document {} ({}): {}", i + 1, types.kind, kube_err(&e)))?;
        let api: Api<DynamicObject> = if caps.scope == kube::discovery::Scope::Namespaced {
            let ns = obj.metadata.namespace.clone().or_else(|| namespace.clone()).ok_or_else(|| format!("Document {}: {} needs a namespace", i + 1, types.kind))?;
            obj.metadata.namespace = Some(ns.clone());
            Api::namespaced_with(client.clone(), &ns, &ar)
        } else {
            Api::all_with(client.clone(), &ar)
        };
        let saved = api.create(&params, &obj).await.map_err(|e| format!("Document {} ({} {}): {}", i + 1, types.kind, obj.metadata.name.as_deref().or(obj.metadata.generate_name.as_deref()).unwrap_or("?"), kube_err(&e)))?;
        let name = saved.metadata.name.unwrap_or_default();
        created.push(match saved.metadata.namespace {
            Some(ns) => format!("{} {ns}/{name}", types.kind),
            None => format!("{} {name}", types.kind),
        });
    }
    Ok(created)
}
