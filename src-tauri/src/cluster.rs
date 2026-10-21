//! Kubeconfig contexts and cluster connection.

use k8s_openapi::api::core::v1::Namespace;
use kube::api::{Api, ListParams};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Client, Config};
use serde::Serialize;
use tauri::State;

use crate::state::{err, AppState, CmdResult, Connection};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextInfo {
    name: String,
    cluster: String,
    namespace: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Contexts {
    contexts: Vec<ContextInfo>,
    current: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connected {
    context: String,
    server_version: String,
    default_namespace: String,
}

#[tauri::command]
pub fn list_contexts() -> CmdResult<Contexts> {
    let kubeconfig = Kubeconfig::read().map_err(err)?;
    let contexts = kubeconfig
        .contexts
        .iter()
        .map(|c| ContextInfo {
            name: c.name.clone(),
            cluster: c.context.as_ref().map(|x| x.cluster.clone()).unwrap_or_default(),
            namespace: c.context.as_ref().and_then(|x| x.namespace.clone()),
        })
        .collect();
    Ok(Contexts { contexts, current: kubeconfig.current_context })
}

#[tauri::command]
pub async fn connect(context: String, state: State<'_, AppState>) -> CmdResult<Connected> {
    state.stop_all();
    *state.conn.write().await = None;

    let kubeconfig = Kubeconfig::read().map_err(err)?;
    let options = KubeConfigOptions { context: Some(context.clone()), ..Default::default() };
    let config = Config::from_custom_kubeconfig(kubeconfig, &options).await.map_err(err)?;
    let default_namespace = config.default_namespace.clone();
    let client = Client::try_from(config).map_err(err)?;
    let version = client.apiserver_version().await.map_err(err)?;

    *state.conn.write().await = Some(Connection { client, default_namespace: default_namespace.clone() });
    Ok(Connected { context, server_version: version.git_version, default_namespace })
}

#[tauri::command]
pub async fn list_namespaces(state: State<'_, AppState>) -> CmdResult<Vec<String>> {
    let conn = state.connection().await?;
    let api: Api<Namespace> = Api::all(conn.client);
    match api.list(&ListParams::default()).await {
        Ok(list) => {
            let mut names: Vec<String> = list.items.into_iter().filter_map(|n| n.metadata.name).collect();
            names.sort();
            Ok(names)
        }
        // Users without cluster-wide list rights still get their context's namespace.
        Err(_) => Ok(vec![conn.default_namespace]),
    }
}
