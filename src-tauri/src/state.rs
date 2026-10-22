use std::collections::HashMap;
use std::ops::Deref;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use kube::Client;
use tauri::async_runtime::JoinHandle;
use tauri::ipc::{CommandArg, CommandItem, InvokeError};
use tauri::{Manager, Runtime};
use tokio::sync::RwLock;

use crate::kinds::KindDef;
use crate::portforward::Forward;
use crate::streams::ExecHandle;

/// Commands return plain strings as errors so the UI can show them directly.
pub type CmdResult<T> = Result<T, String>;

pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// The cluster rejected the credentials (expired or revoked token, e.g. expired AWS session).
pub fn is_unauthorized(e: &kube::Error) -> bool {
    matches!(e, kube::Error::Api(s) if s.code == 401)
}

/// Readable text for API errors; the UI matches on the "(401)" of unauthorized ones.
pub fn kube_err(e: &kube::Error) -> String {
    match e {
        kube::Error::Api(s) if s.code == 401 => "Unauthorized (401): the cluster rejected your credentials. They have probably expired.".into(),
        kube::Error::Api(s) if s.code == 403 => format!("Forbidden (403): {}", s.message),
        kube::Error::Api(s) => format!("{} ({}): {}", s.reason, s.code, s.message),
        other => other.to_string(),
    }
}

#[derive(Clone)]
pub struct Connection {
    pub client: Client,
    pub context: String,
    pub default_namespace: String,
    /// Built-in kinds followed by the cluster's custom resources.
    pub kinds: Arc<Vec<KindDef>>,
    /// Where this cluster's Prometheus answers, found on first use (None: not found).
    pub prometheus: Arc<tokio::sync::OnceCell<Option<crate::pod_insights::PromTarget>>>,
}

impl Connection {
    pub fn kind(&self, key: &str) -> CmdResult<KindDef> {
        self.kinds.iter().find(|k| k.key == key).cloned().ok_or_else(|| format!("Unknown kind: {key}"))
    }
}

#[derive(Default)]
pub struct AppState {
    pub conn: RwLock<Option<Connection>>,
    /// Background streams (watches and logs), keyed by the id handed to the UI.
    pub tasks: Mutex<HashMap<u64, JoinHandle<()>>>,
    pub execs: Mutex<HashMap<u64, ExecHandle>>,
    pub forwards: Mutex<HashMap<u64, Forward>>,
    /// Extra environment for helm. Empty in the app; tests point helm's repository config
    /// at a temporary directory so they never touch the user's repositories.
    pub helm_env: Vec<(String, String)>,
    next_id: AtomicU64,
}

impl AppState {
    pub fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub async fn connection(&self) -> CmdResult<Connection> {
        self.conn.read().await.clone().ok_or_else(|| "Not connected to a cluster".to_owned())
    }

    pub fn track(&self, id: u64, task: JoinHandle<()>) {
        self.tasks.lock().unwrap().insert(id, task);
    }

    pub fn stop(&self, id: u64) {
        if let Some(task) = self.tasks.lock().unwrap().remove(&id) {
            task.abort();
        }
        if let Some(exec) = self.execs.lock().unwrap().remove(&id) {
            exec.task.abort();
        }
        if let Some(forward) = self.forwards.lock().unwrap().remove(&id) {
            forward.task.abort();
        }
    }

    /// Stops every stream; used when switching clusters.
    pub fn stop_all(&self) {
        for (_, task) in self.tasks.lock().unwrap().drain() {
            task.abort();
        }
        for (_, exec) in self.execs.lock().unwrap().drain() {
            exec.task.abort();
        }
        for (_, forward) in self.forwards.lock().unwrap().drain() {
            forward.task.abort();
        }
    }
}

/// One `AppState` per window, so every window has its own cluster, watches, terminals and
/// port forwards.
#[derive(Default)]
pub struct Sessions {
    map: Mutex<HashMap<String, Arc<AppState>>>,
    /// Copied into every new session (see `AppState::helm_env`).
    pub helm_env: Vec<(String, String)>,
}

impl Sessions {
    /// Sessions whose helm runs with extra environment (tests isolate helm's config this way).
    #[cfg(test)]
    pub fn with_helm_env(helm_env: Vec<(String, String)>) -> Self {
        Sessions { helm_env, ..Default::default() }
    }

    pub fn get(&self, label: &str) -> Arc<AppState> {
        self.map
            .lock()
            .unwrap()
            .entry(label.to_owned())
            .or_insert_with(|| Arc::new(AppState { helm_env: self.helm_env.clone(), ..Default::default() }))
            .clone()
    }

    /// Stops everything a closed window was running.
    pub fn close(&self, label: &str) {
        if let Some(session) = self.map.lock().unwrap().remove(label) {
            session.stop_all();
        }
    }
}

/// The calling window's state. As a command argument it is filled in by Tauri from the
/// webview that invoked the command, so commands need no extra parameter from the UI.
pub struct Session(Arc<AppState>);

impl Session {
    /// The session of window `label`; for code that is not a command (tests, menus).
    pub fn of<R: Runtime>(manager: &impl Manager<R>, label: &str) -> Self {
        Session(manager.state::<Sessions>().get(label))
    }
}

impl Deref for Session {
    type Target = AppState;
    fn deref(&self) -> &AppState {
        &self.0
    }
}

impl<'de, R: Runtime> CommandArg<'de, R> for Session {
    fn from_command(command: CommandItem<'de, R>) -> Result<Self, InvokeError> {
        let webview = command.message.webview();
        Ok(Session::of(&webview, webview.label()))
    }
}
