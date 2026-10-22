//! Kubeconfig contexts and cluster connection.

use std::sync::Arc;

use k8s_openapi::api::core::v1::Namespace;
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::api::{Api, ListParams};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Client, Config};
use serde::Serialize;

use crate::kinds;
use crate::state::{err, CmdResult, Connection, Session};

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
pub async fn connect(context: String, state: Session) -> CmdResult<Connected> {
    state.stop_all();
    *state.conn.write().await = None;

    let kubeconfig = Kubeconfig::read().map_err(err)?;
    let options = KubeConfigOptions { context: Some(context.clone()), ..Default::default() };
    let config = Config::from_custom_kubeconfig(kubeconfig, &options).await.map_err(err)?;
    let default_namespace = config.default_namespace.clone();
    let client = Client::try_from(config).map_err(err)?;
    let version = client.apiserver_version().await.map_err(err)?;

    let mut all_kinds = kinds::builtins();
    all_kinds.extend(custom_kinds(&client).await);
    let kinds = Arc::new(all_kinds);

    *state.conn.write().await = Some(Connection { client, context: context.clone(), default_namespace: default_namespace.clone(), kinds, prometheus: Default::default() });
    Ok(Connected { context, server_version: version.git_version, default_namespace })
}

/// Custom resources from the cluster's CRDs. Users who may not list CRDs just get none.
async fn custom_kinds(client: &Client) -> Vec<kinds::KindDef> {
    let api: Api<CustomResourceDefinition> = Api::all(client.clone());
    match api.list(&ListParams::default()).await {
        Ok(list) => {
            let crds: Vec<_> = list.items.iter().filter_map(|c| serde_json::to_value(c).ok()).collect();
            kinds::from_crds(&crds)
        }
        Err(_) => vec![],
    }
}

#[tauri::command]
pub async fn list_namespaces(state: Session) -> CmdResult<Vec<String>> {
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
