//! Watching, reading, editing and deleting resources of any kind in `kinds::KINDS`.

use futures::StreamExt;
use kube::api::{Api, DeleteParams, DynamicObject, PostParams};
use kube::runtime::{watcher, WatchStreamExt};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::kinds::{self, KindDef, KindInfo, Row};
use crate::state::{err, AppState, CmdResult};

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WatchMsg {
    /// Full list, sent once the initial listing finishes and again after every re-list.
    Snapshot { rows: Vec<Row> },
    Upsert { row: Row },
    Delete { uid: String },
    Error { message: String },
}

#[tauri::command]
pub fn list_kinds() -> Vec<KindInfo> {
    kinds::infos()
}

fn kind(key: &str) -> CmdResult<&'static KindDef> {
    kinds::find(key).ok_or_else(|| format!("Unknown kind: {key}"))
}

async fn api_for(state: &AppState, def: &KindDef, namespace: Option<&str>) -> CmdResult<Api<DynamicObject>> {
    let client = state.connection().await?.client;
    let ar = def.api_resource();
    Ok(match (def.namespaced, namespace) {
        (true, Some(ns)) => Api::namespaced_with(client, ns, &ar),
        _ => Api::all_with(client, &ar),
    })
}

/// Starts a watch and returns its stream id; stop it with `stop_stream`.
/// `namespace: None` watches every namespace.
#[tauri::command]
pub async fn watch_resources(
    kind_key: String,
    namespace: Option<String>,
    on_event: Channel<WatchMsg>,
    state: State<'_, AppState>,
) -> CmdResult<u64> {
    let def = kind(&kind_key)?;
    let api = api_for(&state, def, namespace.as_deref()).await?;
    let id = state.next_id();

    let task = tauri::async_runtime::spawn(async move {
        let mut stream = watcher(api, watcher::Config::default()).default_backoff().boxed();
        let mut initial: Vec<Row> = Vec::new();
        while let Some(event) = stream.next().await {
            let msg = match event {
                Ok(watcher::Event::Init) => {
                    initial.clear();
                    continue;
                }
                Ok(watcher::Event::InitApply(obj)) => {
                    initial.push(kinds::summarize(def, &obj));
                    continue;
                }
                Ok(watcher::Event::InitDone) => WatchMsg::Snapshot { rows: std::mem::take(&mut initial) },
                Ok(watcher::Event::Apply(obj)) => WatchMsg::Upsert { row: kinds::summarize(def, &obj) },
                Ok(watcher::Event::Delete(obj)) => WatchMsg::Delete { uid: obj.metadata.uid.unwrap_or_default() },
                // The backoff keeps the watch alive; the UI just shows the latest error.
                Err(e) => WatchMsg::Error { message: e.to_string() },
            };
            if on_event.send(msg).is_err() {
                break; // the window went away
            }
        }
    });
    state.track(id, task);
    Ok(id)
}

#[tauri::command]
pub fn stop_stream(id: u64, state: State<'_, AppState>) {
    state.stop(id);
}

#[tauri::command]
pub async fn get_yaml(kind_key: String, namespace: Option<String>, name: String, state: State<'_, AppState>) -> CmdResult<String> {
    let def = kind(&kind_key)?;
    let api = api_for(&state, def, namespace.as_deref()).await?;
    let mut obj = api.get(&name).await.map_err(err)?;
    // Same noise `kubectl edit` hides; it also cannot be sent back on replace.
    obj.metadata.managed_fields = None;
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
    state: State<'_, AppState>,
) -> CmdResult<String> {
    let def = kind(&kind_key)?;
    let api = api_for(&state, def, namespace.as_deref()).await?;
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
pub async fn delete_resource(kind_key: String, namespace: Option<String>, name: String, state: State<'_, AppState>) -> CmdResult<()> {
    let def = kind(&kind_key)?;
    let api = api_for(&state, def, namespace.as_deref()).await?;
    api.delete(&name, &DeleteParams::default()).await.map_err(err)?;
    Ok(())
}
