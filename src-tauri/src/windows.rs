//! Extra windows. Each window is an independent session (see `state::Sessions`), so two
//! windows can show two clusters side by side.

use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

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

/// Saves text (logs, YAML) to a path the user picked in the save dialog.
#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> CmdResult<()> {
    std::fs::write(&path, contents).map_err(|e| format!("Could not save {path}: {e}"))
}
