//! Helm releases, through the `helm` CLI with the connected kube context.
//!
//! The binary is `$KUBEDECK_HELM` if set, otherwise `helm` from PATH.

use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::process::Command;

use crate::state::{AppState, CmdResult};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    name: String,
    namespace: String,
    revision: String,
    updated: String,
    status: String,
    chart: String,
    #[serde(alias = "app_version")]
    app_version: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    revision: u32,
    updated: String,
    status: String,
    chart: String,
    #[serde(alias = "app_version")]
    app_version: String,
    description: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseDetails {
    /// User-supplied values only, like `helm get values`.
    values: String,
    manifest: String,
    notes: String,
    history: Vec<Revision>,
}

async fn helm(state: &AppState, args: &[&str]) -> CmdResult<String> {
    let context = state.connection().await?.context;
    let binary = std::env::var("KUBEDECK_HELM").unwrap_or_else(|_| "helm".into());
    let output = Command::new(&binary)
        .args(args)
        .args(["--kube-context", &context])
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| format!("Could not run {binary}: {e}. Install Helm or set KUBEDECK_HELM to its path."))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(stderr.trim().trim_start_matches("Error: ").to_owned())
    }
}

#[tauri::command]
pub async fn helm_list(namespace: Option<String>, state: State<'_, AppState>) -> CmdResult<Vec<Release>> {
    let mut args = vec!["list", "--output", "json", "--all"];
    match namespace.as_deref() {
        Some(ns) => args.extend(["--namespace", ns]),
        None => args.push("--all-namespaces"),
    }
    let json = helm(&state, &args).await?;
    let mut releases: Vec<Release> = serde_json::from_str(&json).map_err(|e| format!("Unexpected helm output: {e}"))?;
    for r in &mut releases {
        r.updated = iso_time(&r.updated);
    }
    Ok(releases)
}

/// `helm list` prints Go's default time format ("2026-10-21 14:52:02.556408 -0300 -03"),
/// while `helm history` already uses RFC 3339. Normalize to RFC 3339 for the UI.
fn iso_time(go: &str) -> String {
    let mut parts = go.split(' ');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(date), Some(time), Some(offset)) if offset.len() == 5 => {
            format!("{date}T{time}{}:{}", &offset[..3], &offset[3..])
        }
        _ => go.to_owned(),
    }
}

#[tauri::command]
pub async fn helm_details(namespace: String, name: String, state: State<'_, AppState>) -> CmdResult<ReleaseDetails> {
    let ns = namespace.as_str();
    let n = name.as_str();
    let values_args = ["get", "values", n, "--namespace", ns, "--output", "yaml"];
    let manifest_args = ["get", "manifest", n, "--namespace", ns];
    let notes_args = ["get", "notes", n, "--namespace", ns];
    let history_args = ["history", n, "--namespace", ns, "--output", "json"];
    let (values, manifest, notes, history) = tokio::join!(
        helm(&state, &values_args),
        helm(&state, &manifest_args),
        helm(&state, &notes_args),
        helm(&state, &history_args),
    );
    let values = values?;
    let mut history: Vec<Revision> = serde_json::from_str(&history?).map_err(|e| format!("Unexpected helm output: {e}"))?;
    history.sort_by(|a, b| b.revision.cmp(&a.revision));
    Ok(ReleaseDetails {
        // A release installed without custom values prints "null".
        values: if values.trim() == "null" { String::new() } else { values },
        manifest: manifest?,
        // Charts without NOTES.txt make `helm get notes` fail; that is not an error here.
        notes: notes.unwrap_or_default(),
        history,
    })
}

#[tauri::command]
pub async fn helm_rollback(namespace: String, name: String, revision: u32, state: State<'_, AppState>) -> CmdResult<String> {
    helm(&state, &["rollback", &name, &revision.to_string(), "--namespace", &namespace, "--wait", "--timeout", "5m"]).await
}

#[tauri::command]
pub async fn helm_uninstall(namespace: String, name: String, state: State<'_, AppState>) -> CmdResult<String> {
    helm(&state, &["uninstall", &name, "--namespace", &namespace]).await
}

#[cfg(test)]
mod tests {
    #[test]
    fn iso_time_converts_go_format() {
        assert_eq!(super::iso_time("2026-10-21 14:52:02.556408 -0300 -03"), "2026-10-21T14:52:02.556408-03:00");
        assert_eq!(super::iso_time("2026-10-21T14:52:02-03:00"), "2026-10-21T14:52:02-03:00");
    }
}
