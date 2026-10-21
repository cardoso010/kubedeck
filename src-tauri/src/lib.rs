mod cluster;
mod kinds;
mod resources;
mod state;
mod streams;

/// Apps started from Finder or the Dock get a minimal PATH, so kubeconfig exec plugins
/// such as `aws eks get-token` or `gke-gcloud-auth-plugin` would not be found.
/// Borrow the PATH of the user's login shell instead.
#[cfg(target_os = "macos")]
fn inherit_login_shell_path() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let output = std::process::Command::new(shell).args(["-ilc", "printf %s \"$PATH\""]).output();
    if let Ok(out) = output {
        let path = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        if out.status.success() && !path.is_empty() {
            // SAFETY: runs before any other thread is started.
            unsafe { std::env::set_var("PATH", path) };
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "macos")]
    inherit_login_shell_path();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            cluster::list_contexts,
            cluster::connect,
            cluster::list_namespaces,
            resources::list_kinds,
            resources::watch_resources,
            resources::stop_stream,
            resources::get_yaml,
            resources::replace_yaml,
            resources::delete_resource,
            streams::stream_logs,
            streams::exec_start,
            streams::exec_input,
            streams::exec_resize,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod e2e_test;
