//! Helm releases, through the `helm` CLI with the connected kube context.
//!
//! The binary is `$KUBEDECK_HELM` if set, otherwise the copy bundled next to the app
//! executable (Tauri `externalBin`, fetched by scripts/fetch-helm.mjs), otherwise `helm`
//! from PATH.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::state::{AppState, CmdResult, Session};

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

fn helm_binary() -> PathBuf {
    if let Some(path) = std::env::var_os("KUBEDECK_HELM") {
        return path.into();
    }
    let bundled = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(if cfg!(windows) { "helm.exe" } else { "helm" })));
    match bundled {
        Some(path) if path.is_file() => path,
        _ => "helm".into(),
    }
}

/// Runs helm against the connected cluster's kube context.
pub(crate) async fn helm(state: &AppState, args: &[&str]) -> CmdResult<String> {
    let context = state.connection().await?.context;
    run(state, args, Some(&context)).await
}

/// Runs helm commands that do not talk to a cluster (repositories, search, chart values).
pub(crate) async fn helm_local(state: &AppState, args: &[&str]) -> CmdResult<String> {
    run(state, args, None).await
}

async fn run(state: &AppState, args: &[&str], context: Option<&str>) -> CmdResult<String> {
    let binary = helm_binary();
    let binary_name = binary.display();
    let mut command = Command::new(&binary);
    command.args(args).envs(state.helm_env.iter().map(|(k, v)| (k, v))).kill_on_drop(true);
    if let Some(context) = context {
        command.args(["--kube-context", context]);
    }
    let output = command
        .output()
        .await
        .map_err(|e| format!("Could not run {binary_name}: {e}. Install Helm or set KUBEDECK_HELM to its path."))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(stderr.trim().trim_start_matches("Error: ").to_owned())
    }
}

/// Above this many selected namespaces, one `--all-namespaces` call filtered here is cheaper
/// than a helm process per namespace (each re-runs the kubeconfig exec plugin, e.g.
/// `aws eks get-token`).
const PER_NAMESPACE_LIMIT: usize = 3;

/// Releases in `namespaces` (every namespace when empty).
#[tauri::command]
pub async fn helm_list(namespaces: Vec<String>, state: Session) -> CmdResult<Vec<Release>> {
    let scopes: Vec<Vec<&str>> = if namespaces.is_empty() || namespaces.len() > PER_NAMESPACE_LIMIT {
        vec![vec!["--all-namespaces"]]
    } else {
        namespaces.iter().map(|ns| vec!["--namespace", ns.as_str()]).collect()
    };
    let outputs = futures::future::join_all(scopes.iter().map(|scope| {
        let mut args = vec!["list", "--output", "json", "--all"];
        args.extend(scope);
        let state = &*state;
        async move { helm(state, &args).await }
    }))
    .await;
    let mut releases = Vec::new();
    for json in outputs {
        let mut list: Vec<Release> = serde_json::from_str(&json?).map_err(|e| format!("Unexpected helm output: {e}"))?;
        releases.append(&mut list);
    }
    if !namespaces.is_empty() {
        releases.retain(|r| namespaces.contains(&r.namespace));
    }
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

/// Masks the Secrets a chart rendered (`helm get manifest` prints them with their values),
/// keeping every other document, comments included, as helm printed it.
fn mask_manifest(manifest: &str) -> String {
    let mut out = Vec::new();
    for doc in manifest.split("\n---") {
        let parsed: Option<kube::api::DynamicObject> = serde_yaml::from_str(doc).ok();
        match parsed {
            Some(mut obj) if obj.types.as_ref().is_some_and(|t| t.kind == "Secret") => {
                crate::secrets::mask(&mut obj);
                // Keep helm's "# Source: chart/templates/x.yaml" line, which says where it came from.
                let comments: String = doc.lines().take_while(|l| l.trim().is_empty() || l.starts_with('#')).map(|l| format!("{l}\n")).collect();
                out.push(format!("{comments}{}", serde_yaml::to_string(&obj).unwrap_or_default().trim_end()));
            }
            _ => out.push(doc.to_owned()),
        }
    }
    out.join("\n---")
}

/// Hides values under keys that usually hold credentials (`password`, `token`, `apiKey`…).
/// User-supplied values often carry them, and the UI shows them in plain text.
fn mask_values(values: &str) -> String {
    fn walk(v: &mut serde_yaml::Value) {
        match v {
            serde_yaml::Value::Mapping(map) => {
                for (k, v) in map.iter_mut() {
                    let sensitive = k.as_str().is_some_and(|k| {
                        let k = k.to_ascii_lowercase().replace(['_', '-'], "");
                        ["password", "passwd", "secret", "token", "apikey", "privatekey", "credential", "accesskey"].iter().any(|s| k.contains(s))
                    });
                    if sensitive && !matches!(v, serde_yaml::Value::Mapping(_) | serde_yaml::Value::Sequence(_) | serde_yaml::Value::Null) {
                        *v = serde_yaml::Value::String(crate::secrets::MASK.into());
                    } else {
                        walk(v);
                    }
                }
            }
            serde_yaml::Value::Sequence(items) => items.iter_mut().for_each(walk),
            _ => {}
        }
    }
    match serde_yaml::from_str::<serde_yaml::Value>(values) {
        Ok(mut v) => {
            walk(&mut v);
            serde_yaml::to_string(&v).unwrap_or_default()
        }
        Err(_) => values.to_owned(),
    }
}

/// Values, manifest, notes and history of a release. Secrets and credential-looking values
/// are masked unless `reveal`, as `get_yaml` does for Secret objects.
#[tauri::command]
pub async fn helm_details(namespace: String, name: String, reveal: Option<bool>, state: Session) -> CmdResult<ReleaseDetails> {
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
    let reveal = reveal.unwrap_or(false);
    let values = values?;
    let manifest = manifest?;
    let mut history: Vec<Revision> = serde_json::from_str(&history?).map_err(|e| format!("Unexpected helm output: {e}"))?;
    history.sort_by_key(|r| std::cmp::Reverse(r.revision));
    Ok(ReleaseDetails {
        // A release installed without custom values prints "null".
        values: match values.trim() {
            "null" => String::new(),
            _ if reveal => values,
            _ => mask_values(&values),
        },
        manifest: if reveal { manifest } else { mask_manifest(&manifest) },
        // Charts without NOTES.txt make `helm get notes` fail; that is not an error here.
        notes: notes.unwrap_or_default(),
        history,
    })
}

#[tauri::command]
pub async fn helm_rollback(namespace: String, name: String, revision: u32, state: Session) -> CmdResult<String> {
    state.writable()?;
    helm(&state, &["rollback", &name, &revision.to_string(), "--namespace", &namespace, "--wait", "--timeout", "5m"]).await
}

#[tauri::command]
pub async fn helm_uninstall(namespace: String, name: String, state: Session) -> CmdResult<String> {
    state.writable()?;
    helm(&state, &["uninstall", &name, "--namespace", &namespace]).await
}

#[cfg(test)]
mod tests {
    #[test]
    fn masks_rendered_secrets_and_credential_values() {
        let manifest = "---\n# Source: app/templates/cm.yaml\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\ndata:\n  color: blue\n---\n# Source: app/templates/secret.yaml\napiVersion: v1\nkind: Secret\nmetadata:\n  name: s\ndata:\n  password: aHVudGVyMg==\n";
        let masked = super::mask_manifest(manifest);
        assert!(!masked.contains("aHVudGVyMg=="), "{masked}");
        assert!(masked.contains("color: blue") && masked.contains("# Source: app/templates/secret.yaml"), "{masked}");

        let values = super::mask_values("auth:\n  adminPassword: hunter2\n  api_key: abc\n  user: admin\nreplicas: 2\ntls:\n  secretName: my-tls\n");
        assert!(!values.contains("hunter2") && !values.contains("abc"), "{values}");
        assert!(values.contains("user: admin") && values.contains("replicas: 2"), "{values}");
    }

    #[test]
    fn iso_time_converts_go_format() {
        assert_eq!(super::iso_time("2026-10-21 14:52:02.556408 -0300 -03"), "2026-10-21T14:52:02.556408-03:00");
        assert_eq!(super::iso_time("2026-10-21T14:52:02-03:00"), "2026-10-21T14:52:02-03:00");
    }
}
