//! Extra windows. Each window is an independent session (see `state::Sessions`), so two
//! windows can show two clusters side by side.

use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

use crate::state::{err, CmdResult};

static NEXT_WINDOW: AtomicU64 = AtomicU64::new(1);

/// Opens a new window, connecting it to `context` right away when given.
#[tauri::command]
pub fn open_window(app: AppHandle, context: Option<String>) -> CmdResult<()> {
    let label = format!("window-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
    // Handed to the UI before it loads; JSON keeps any context name safe to embed.
    let init = format!("window.__KUBEDECK_INITIAL_CONTEXT__ = {};", serde_json::to_string(&context).map_err(err)?);
    WebviewWindowBuilder::new(&app, label, WebviewUrl::App("index.html".into()))
        .title(context.as_deref().unwrap_or("kubedeck"))
        .inner_size(1400.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .initialization_script(init)
        .build()
        .map_err(err)?;
    Ok(())
}

/// Asks where to save text (logs, YAML) and writes it there. The path comes from the native
/// save dialog, never from the webview, so a script running in the page cannot choose where
/// to write. Returns false when the user cancels.
#[tauri::command]
pub async fn save_text_file(app: AppHandle, default_name: String, contents: String) -> CmdResult<bool> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_file_name(default_name).save_file(move |path| {
        let _ = tx.send(path);
    });
    let Some(path) = rx.await.map_err(err)? else { return Ok(false) };
    let path = path.into_path().map_err(err)?;
    tokio::fs::write(&path, contents).await.map_err(|e| format!("Could not save {}: {e}", path.display()))?;
    Ok(true)
}
