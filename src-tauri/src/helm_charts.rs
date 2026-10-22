//! Chart repositories, chart search, and installing or upgrading releases from charts.
//!
//! Repositories live in Helm's own config (`helm repo list` shows the same ones), so the app
//! and the CLI stay in sync.

use serde::{Deserialize, Serialize};

use crate::helm::{helm, helm_local};
use crate::state::{err, AppState, CmdResult, Session};

#[derive(Serialize, Deserialize)]
pub struct Repo {
    name: String,
    url: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chart {
    /// `<repo>/<chart>`, usable as a chart reference.
    name: String,
    version: String,
    #[serde(alias = "app_version")]
    app_version: String,
    description: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartAction {
    namespace: String,
    /// Release name.
    name: String,
    /// `repo/chart`, `oci://...`, a URL or a local path; anything `helm install` accepts.
    chart: String,
    version: Option<String>,
    /// Values YAML; passed as a values file.
    values: String,
    #[serde(default)]
    create_namespace: bool,
    /// Render and validate against the cluster without changing anything.
    #[serde(default)]
    dry_run: bool,
}

#[tauri::command]
pub async fn helm_repo_list(state: Session) -> CmdResult<Vec<Repo>> {
    match helm_local(&state, &["repo", "list", "--output", "json"]).await {
        Ok(json) => serde_json::from_str(&json).map_err(|e| format!("Unexpected helm output: {e}")),
        // Helm treats "no repositories configured" as an error.
        Err(e) if e.contains("no repositories") => Ok(vec![]),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn helm_repo_add(name: String, url: String, state: Session) -> CmdResult<()> {
    helm_local(&state, &["repo", "add", &name, &url, "--force-update"]).await.map(drop)
}

#[tauri::command]
pub async fn helm_repo_remove(name: String, state: Session) -> CmdResult<()> {
    helm_local(&state, &["repo", "remove", &name]).await.map(drop)
}

/// Refreshes every repository index, like `helm repo update`.
#[tauri::command]
pub async fn helm_repo_update(state: Session) -> CmdResult<()> {
    helm_local(&state, &["repo", "update"]).await.map(drop)
}

/// Latest version of each chart matching `query` (all charts when empty).
#[tauri::command]
pub async fn helm_search(query: String, state: Session) -> CmdResult<Vec<Chart>> {
    let mut args = vec!["search", "repo", "--output", "json"];
    if !query.trim().is_empty() {
        args.push(query.trim());
    }
    let json = helm_local(&state, &args).await?;
    serde_json::from_str(&json).map_err(|e| format!("Unexpected helm output: {e}"))
}

/// Every version of `chart` (a `repo/chart` reference), newest first. Other references
/// (OCI, URLs, paths) have no searchable index and return nothing.
#[tauri::command]
pub async fn helm_chart_versions(chart: String, state: Session) -> CmdResult<Vec<Chart>> {
    if chart.contains("://") || chart.starts_with('.') || chart.starts_with('/') {
        return Ok(vec![]);
    }
    let json = helm_local(&state, &["search", "repo", &chart, "--versions", "--output", "json"]).await?;
    let charts: Vec<Chart> = serde_json::from_str(&json).map_err(|e| format!("Unexpected helm output: {e}"))?;
    // Search matches substrings; keep the chart itself.
    Ok(charts.into_iter().filter(|c| c.name == chart).collect())
}

/// The chart's default values.yaml.
#[tauri::command]
pub async fn helm_show_values(chart: String, version: Option<String>, state: Session) -> CmdResult<String> {
    let mut args = vec!["show", "values", chart.as_str()];
    if let Some(v) = version.as_deref().filter(|v| !v.is_empty()) {
        args.extend(["--version", v]);
    }
    helm_local(&state, &args).await
}

#[tauri::command]
pub async fn helm_install(request: ChartAction, state: Session) -> CmdResult<String> {
    chart_action("install", request, &state).await
}

/// Upgrades with exactly the given values (the UI starts from the release's current ones),
/// so values removed in the editor really go away.
#[tauri::command]
pub async fn helm_upgrade(request: ChartAction, state: Session) -> CmdResult<String> {
    chart_action("upgrade", request, &state).await
}

async fn chart_action(verb: &str, r: ChartAction, state: &AppState) -> CmdResult<String> {
    if !r.dry_run {
        state.writable()?;
    }
    let values_file = std::env::temp_dir().join(format!("kubedeck-values-{}-{}.yaml", std::process::id(), state.next_id()));
    std::fs::write(&values_file, &r.values).map_err(err)?;
    let values_path = values_file.to_string_lossy().into_owned();

    let mut args = vec![verb, r.name.as_str(), r.chart.as_str(), "--namespace", r.namespace.as_str(), "--values", values_path.as_str()];
    if let Some(v) = r.version.as_deref().filter(|v| !v.is_empty()) {
        args.extend(["--version", v]);
    }
    if r.create_namespace && verb == "install" {
        args.push("--create-namespace");
    }
    if r.dry_run {
        // Server-side: also validates the manifests against the cluster's API.
        args.push("--dry-run=server");
    }
    let result = helm(state, &args).await;
    let _ = std::fs::remove_file(&values_file);
    result
}
