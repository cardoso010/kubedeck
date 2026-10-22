use tauri::Manager;

mod ai;
mod cluster;
mod diagnostics;
mod helm;
mod helm_charts;
mod kinds;
mod metrics;
mod nodes;
mod pod_insights;
mod portforward;
mod resources;
mod rightsizing;
mod secrets;
mod state;
mod streams;
mod updater;
mod windows;
mod workloads;

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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(state::Sessions::default())
        .manage(updater::PendingUpdate::default())
        .invoke_handler(tauri::generate_handler![
            cluster::list_contexts,
            cluster::connect,
            cluster::context_auth,
            cluster::list_namespaces,
            cluster::set_read_only,
            cluster::run_login,
            secrets::secret_keys,
            secrets::secret_value,
            resources::list_kinds,
            resources::watch_resources,
            resources::stop_stream,
            resources::get_yaml,
            resources::replace_yaml,
            resources::delete_resource,
            resources::create_resources,
            rightsizing::rightsizing,
            streams::stream_logs,
            streams::stream_workload_logs,
            workloads::rollout_restart,
            workloads::scale,
            workloads::set_paused,
            workloads::rollout_status,
            workloads::rollback,
            workloads::object_events,
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
            pod_insights::pod_usage,
            pod_insights::prometheus_target,
            pod_insights::pod_history,
            pod_insights::node_history,
            diagnostics::cluster_problems,
            diagnostics::related,
            nodes::node_summary,
            nodes::cordon,
            nodes::drain,
            updater::check_for_update,
            updater::install_update,
            windows::open_window,
            windows::write_text_file,
            ai::ai_status,
            ai::ai_set_key,
            ai::ai_clear_key,
            ai::ai_explain,
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
