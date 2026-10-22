use tauri::Manager;

mod cluster;
mod helm;
mod helm_charts;
mod kinds;
mod metrics;
mod portforward;
mod resources;
mod state;
mod streams;
mod updater;
mod windows;

/// Apps started from Finder, the Dock or a desktop launcher get a minimal PATH, so kubeconfig
/// exec plugins such as `aws eks get-token` or `gke-gcloud-auth-plugin` would not be found.
/// Borrow the PATH of the user's login shell instead. (Windows apps get the user's PATH.)
#[cfg(unix)]
fn inherit_login_shell_path() {
    let default_shell = if cfg!(target_os = "macos") { "/bin/zsh" } else { "/bin/sh" };
    let shell = std::env::var("SHELL").unwrap_or_else(|_| default_shell.into());
    let output = std::process::Command::new(shell).args(["-ilc", "printf %s \"$PATH\""]).output();
    if let Ok(out) = output {
        let path = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        if out.status.success() && !path.is_empty() {
            // SAFETY: runs before any other thread is started.
            unsafe { std::env::set_var("PATH", path) };
        }
    }
}

/// Both rustls crypto backends end up enabled (kube and reqwest use aws-lc-rs, the updater
/// plugin pulls in ring), and then rustls cannot pick a default and panics on the first TLS
/// connection that relies on it. Choose one explicitly.
pub fn install_crypto_provider() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_crypto_provider();
    #[cfg(unix)]
    inherit_login_shell_path();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state::Sessions::default())
        .manage(updater::PendingUpdate::default())
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
            portforward::start_port_forward,
            portforward::list_port_forwards,
            helm::helm_list,
            helm::helm_details,
            helm::helm_rollback,
            helm::helm_uninstall,
            helm_charts::helm_repo_list,
            helm_charts::helm_repo_add,
            helm_charts::helm_repo_remove,
            helm_charts::helm_repo_update,
            helm_charts::helm_search,
            helm_charts::helm_chart_versions,
            helm_charts::helm_show_values,
            helm_charts::helm_install,
            helm_charts::helm_upgrade,
            metrics::pod_metrics,
            metrics::node_metrics,
            updater::check_for_update,
            updater::install_update,
            windows::open_window,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                window.state::<state::Sessions>().close(window.label());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod e2e_test;
