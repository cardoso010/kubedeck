//! Self-update from the repository's GitHub releases.
//!
//! The release workflow publishes a `latest.json` whose download URLs are GitHub API asset
//! URLs; the official updater plugin fetches it and the bundle, then verifies the bundle
//! signature against the public key in tauri.conf.json.
//!
//! Requests go out anonymously unless a GitHub token is around (`GITHUB_TOKEN`/`GH_TOKEN`, or
//! a logged-in GitHub CLI): a token lifts the anonymous rate limit and is what makes updates
//! work from a private repository or fork. No token ships in the app.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::state::{err, CmdResult};

/// `owner/name` of the repository whose releases carry updates; overridable for forks.
const DEFAULT_REPO: &str = "cardoso010/kubedeck";

#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum UpdateStatus {
    UpToDate,
    Available { version: String, notes: Option<String>, date: Option<String> },
    Error { message: String },
}

#[derive(Deserialize)]
struct Release {
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    /// API URL of the asset; with `Accept: application/octet-stream` it serves the file.
    url: String,
}

fn repo() -> String {
    std::env::var("KUBEDECK_UPDATE_REPO").unwrap_or_else(|_| DEFAULT_REPO.into())
}

async fn github_token() -> Option<String> {
    for var in ["GITHUB_TOKEN", "GH_TOKEN"] {
        if let Ok(token) = std::env::var(var)
            && !token.trim().is_empty()
        {
            return Some(token.trim().to_owned());
        }
    }
    let output = tokio::process::Command::new("gh").args(["auth", "token"]).output().await.ok()?;
    let token = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (output.status.success() && !token.is_empty()).then_some(token)
}

/// Finds the API URL of `latest.json` in the newest published release.
async fn manifest_url(token: Option<&str>) -> Result<String, String> {
    let mut request = reqwest::Client::new().get(format!("https://api.github.com/repos/{}/releases/latest", repo()));
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "kubedeck-updater")
        .send()
        .await
        .map_err(err)?;
    match response.status().as_u16() {
        200 => {}
        // GitHub answers 404 both for "no release yet" and "no access to this repository".
        404 if token.is_none() => return Err(format!("No published release found in {}. If the repository is private, run `gh auth login`.", repo())),
        404 => return Err(format!("No published release found in {}, or your GitHub account cannot access it.", repo())),
        401 => return Err("GitHub rejected the token. Run `gh auth login` again.".into()),
        403 | 429 if token.is_none() => return Err("GitHub's anonymous rate limit was reached; try again later, or run `gh auth login`.".into()),
        code => return Err(format!("GitHub API returned HTTP {code}")),
    }
    let release: Release = response.json().await.map_err(err)?;
    release
        .assets
        .into_iter()
        .find(|a| a.name == "latest.json")
        .map(|a| a.url)
        .ok_or_else(|| "The latest release has no latest.json".into())
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle, pending: State<'_, PendingUpdate>) -> CmdResult<UpdateStatus> {
    let token = github_token().await;
    let url = match manifest_url(token.as_deref()).await {
        Ok(url) => url,
        Err(message) => return Ok(UpdateStatus::Error { message }),
    };
    let mut builder = app.updater_builder().endpoints(vec![url.parse().map_err(err)?]).map_err(err)?;
    if let Some(token) = &token {
        builder = builder.header("Authorization", format!("Bearer {token}")).map_err(err)?;
    }
    // Asset API URLs serve the file itself only with this Accept header, for both the
    // manifest and the bundle. Redirects to the storage host drop the Authorization header.
    let updater = builder.header("Accept", "application/octet-stream").map_err(err)?.build().map_err(err)?;
    match updater.check().await {
        Ok(Some(update)) => {
            let status = UpdateStatus::Available { version: update.version.clone(), notes: update.body.clone(), date: update.date.map(|d| d.to_string()) };
            *pending.0.lock().unwrap() = Some(update);
            Ok(status)
        }
        Ok(None) => Ok(UpdateStatus::UpToDate),
        Err(e) => Ok(UpdateStatus::Error { message: e.to_string() }),
    }
}

/// Downloads, verifies and installs the update found by `check_for_update`, then restarts.
#[tauri::command]
pub async fn install_update(app: AppHandle, pending: State<'_, PendingUpdate>) -> CmdResult<()> {
    let update = pending.0.lock().unwrap().take().ok_or("No update to install; check again")?;
    update.download_and_install(|_, _| {}, || {}).await.map_err(err)?;
    app.restart();
}
