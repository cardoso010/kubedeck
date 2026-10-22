use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use kube::Client;
use tauri::async_runtime::JoinHandle;
use tokio::sync::RwLock;

use crate::kinds::KindDef;
use crate::portforward::Forward;
use crate::streams::ExecHandle;

/// Commands return plain strings as errors so the UI can show them directly.
pub type CmdResult<T> = Result<T, String>;

pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[derive(Clone)]
pub struct Connection {
    pub client: Client,
    pub context: String,
    pub default_namespace: String,
    /// Built-in kinds followed by the cluster's custom resources.
    pub kinds: Arc<Vec<KindDef>>,
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
