//! Kubeconfig contexts and cluster connection.

use std::sync::Arc;

use k8s_openapi::api::core::v1::Namespace;
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::api::{Api, ApiResource, DynamicObject, ListParams, WatchParams};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Client, Config};
use serde::Serialize;
use serde_json::Value;

use crate::kinds;
use crate::state::{err, kube_err, CmdResult, Connection, Session};

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
    auth: Option<AuthSummary>,
}

/// How a context logs in, to tell the user what to renew when credentials expire.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthSummary {
    /// The exec plugin command line, e.g. "aws eks get-token --cluster-name x".
    command: String,
    /// AWS_PROFILE the plugin runs with, if any.
    aws_profile: Option<String>,
}

pub fn auth_summary(kubeconfig: &Kubeconfig, context: &str) -> Option<AuthSummary> {
    let user = kubeconfig.contexts.iter().find(|c| c.name == context)?.context.as_ref()?.user.clone()?;
    let exec = kubeconfig.auth_infos.iter().find(|a| a.name == user)?.auth_info.as_ref()?.exec.clone()?;
    let mut parts = vec![exec.command.clone().unwrap_or_default()];
    // Drop flags that only shape the output.
    let args = exec.args.unwrap_or_default();
    let mut skip = false;
    for a in args {
        if skip {
            skip = false;
            continue;
        }
        if a == "--output" || a == "--region" {
            skip = true;
            continue;
        }
        parts.push(a);
    }
    let aws_profile = exec
        .env
        .unwrap_or_default()
        .iter()
        .find(|e| e.get("name").map(String::as_str) == Some("AWS_PROFILE"))
        .and_then(|e| e.get("value").cloned());
    Some(AuthSummary { command: parts.join(" "), aws_profile })
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

/// How `context` signs in, read from the kubeconfig without connecting.
#[tauri::command]
pub fn context_auth(context: String) -> CmdResult<Option<AuthSummary>> {
    Ok(auth_summary(&Kubeconfig::read().map_err(err)?, &context))
}

#[tauri::command]
pub async fn connect(context: String, state: Session) -> CmdResult<Connected> {
    state.stop_all();
    *state.conn.write().await = None;

    let kubeconfig = Kubeconfig::read().map_err(err)?;
    let auth = auth_summary(&kubeconfig, &context);
    let options = KubeConfigOptions { context: Some(context.clone()), ..Default::default() };
    let config = Config::from_custom_kubeconfig(kubeconfig, &options).await.map_err(err)?;
    let default_namespace = config.default_namespace.clone();
    let client = Client::try_from(config).map_err(err)?;
    // Independent round trips; the streaming probe alone can take up to a second.
    let (version, custom, streaming_lists) = tokio::join!(client.apiserver_version(), custom_kinds(&client), supports_streaming_lists(&client));
    let version = version.map_err(|e| kube_err(&e))?;

    let mut all_kinds = kinds::builtins();
    all_kinds.extend(custom);
    let kinds = Arc::new(all_kinds);

    *state.conn.write().await = Some(Connection { client, context: context.clone(), default_namespace: default_namespace.clone(), kinds, prometheus: Default::default(), streaming_lists });
    Ok(Connected { context, server_version: version.git_version, default_namespace, auth })
}

/// Whether the API server streams a watch's initial state (WatchList, on by default in recent
/// Kubernetes): servers without it reject `sendInitialEvents`, so one short watch on namespaces
/// tells. Users who may not watch namespaces keep the classic list-then-watch.
async fn supports_streaming_lists(client: &Client) -> bool {
    let wp = WatchParams { timeout: Some(1), ..WatchParams::streaming_lists() };
    Api::<Namespace>::all(client.clone()).watch(&wp, "0").await.is_ok()
}

/// Custom resources from the cluster's CRDs. Users who may not list CRDs just get none.
///
/// CRDs carry their whole OpenAPI schema, megabytes on clusters with many operators: they are
/// read as plain JSON (not typed and converted back) and served from the API server's cache.
async fn custom_kinds(client: &Client) -> Vec<kinds::KindDef> {
    let api: Api<DynamicObject> = Api::all_with(client.clone(), &ApiResource::erase::<CustomResourceDefinition>(&()));
    match api.list(&ListParams::default().match_any()).await {
        Ok(list) => {
            let crds: Vec<Value> = list.items.into_iter().map(|c| c.data).collect();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarizes_aws_exec_auth() {
        let kubeconfig = Kubeconfig::from_yaml(
            r#"
apiVersion: v1
kind: Config
clusters: [{ name: c, cluster: { server: "https://example.com" } }]
contexts:
  - { name: prd, context: { cluster: c, user: aws } }
  - { name: plain, context: { cluster: c, user: token } }
users:
  - name: aws
    user:
      exec:
        apiVersion: client.authentication.k8s.io/v1beta1
        command: aws
        args: [--region, us-east-1, eks, get-token, --cluster-name, shop-prd, --output, json]
        env: [{ name: AWS_PROFILE, value: prod }]
  - name: token
    user: { token: abc }
"#,
        )
        .unwrap();
        assert_eq!(
            auth_summary(&kubeconfig, "prd"),
            Some(AuthSummary { command: "aws eks get-token --cluster-name shop-prd".into(), aws_profile: Some("prod".into()) })
        );
        assert_eq!(auth_summary(&kubeconfig, "plain"), None);
    }
}

/// Turns read-only mode on or off for this window (see `AppState::read_only`).
#[tauri::command]
pub fn set_read_only(read_only: bool, state: Session) {
    state.read_only.store(read_only, std::sync::atomic::Ordering::Relaxed);
    if read_only {
        state.close_execs();
    }
}

/// Commands the user approved in this run of the app, so renewing again does not ask again.
static APPROVED_LOGINS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<String>>> = std::sync::LazyLock::new(Default::default);

/// Runs the user's login command (e.g. `aws sso login --profile prod`) so expired
/// credentials can be renewed from the app. The command is typed in the webview, so before
/// running a command for the first time the user confirms it in a native dialog, which a
/// script injected into the page cannot click. Returns the end of its output.
#[tauri::command]
pub async fn run_login(app: tauri::AppHandle, command: String) -> CmdResult<String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let command = command.trim().to_owned();
    if command.is_empty() {
        return Err("No login command set".into());
    }
    let approved = APPROVED_LOGINS.lock().unwrap_or_else(std::sync::PoisonError::into_inner).contains(&command);
    if !approved {
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.dialog()
            .message(format!("kubedeck will run this command on your computer to renew your credentials:\n\n{command}"))
            .title("Run the login command?")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Run".into(), "Cancel".into()))
            .show(move |ok| {
                let _ = tx.send(ok);
            });
        if !rx.await.unwrap_or(false) {
            return Err("Login cancelled".into());
        }
        APPROVED_LOGINS.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(command.clone());
    }
    login(&command).await
}

/// Runs a login command. It may open a browser and wait for it, so it gets five minutes.
pub(crate) async fn login(command: &str) -> CmdResult<String> {
    #[cfg(windows)]
    let mut cmd = tokio::process::Command::new("cmd");
    #[cfg(windows)]
    cmd.args(["/C", command]);
    #[cfg(not(windows))]
    let mut cmd = tokio::process::Command::new("sh");
    #[cfg(not(windows))]
    cmd.args(["-c", command]);
    cmd.stdin(std::process::Stdio::null()).kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output())
        .await
        .map_err(|_| "The login command did not finish within 5 minutes".to_owned())?
        .map_err(|e| format!("Could not run the login command: {e}"))?;
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    let tail: String = text.trim().chars().rev().take(2000).collect::<Vec<_>>().into_iter().rev().collect();
    if output.status.success() {
        Ok(tail)
    } else {
        Err(format!("The login command failed ({}):\n{tail}", output.status))
    }
}
