//! Pod log streaming and interactive exec sessions.

use futures::{AsyncBufReadExt, SinkExt, StreamExt, TryStreamExt};
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, AttachParams, LogParams, TerminalSize};
use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::state::{err, CmdResult, Session};

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamMsg {
    /// `source`: the pod a line came from, for logs merged from several pods.
    Data {
        data: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        source: Option<String>,
    },
    End { message: Option<String> },
}

#[tauri::command]
pub async fn stream_logs(
    namespace: String,
    pod: String,
    container: Option<String>,
    tail_lines: Option<i64>,
    previous: Option<bool>,
    on_event: Channel<StreamMsg>,
    state: Session,
) -> CmdResult<u64> {
    let api: Api<Pod> = Api::namespaced(state.connection().await?.client, &namespace);
    // The previous run's logs are finished, so there is nothing to follow.
    let previous = previous.unwrap_or(false);
    let params = LogParams { follow: !previous, previous, container, tail_lines: Some(tail_lines.unwrap_or(500)), ..Default::default() };
    let id = state.next_id();

    let task = tauri::async_runtime::spawn(async move {
        let result: Result<(), kube::Error> = async {
            let mut lines = api.log_stream(&pod, &params).await?.lines();
            while let Some(line) = lines.try_next().await.map_err(kube::Error::ReadEvents)? {
                if on_event.send(StreamMsg::Data { data: line, source: None }).is_err() {
                    break;
                }
            }
            Ok(())
        }
        .await;
        let _ = on_event.send(StreamMsg::End { message: result.err().map(|e| e.to_string()) });
    });
    state.track(id, task);
    Ok(id)
}

/// Most pods merged into one workload log stream.
const MAX_WORKLOAD_PODS: usize = 20;

/// Follows the logs of every pod of a workload (deployment, statefulset, daemonset, job or
/// replicaset), each line tagged with its pod. Pods are the ones running when it starts.
#[tauri::command]
pub async fn stream_workload_logs(
    kind_key: String,
    namespace: String,
    name: String,
    tail_lines: Option<i64>,
    on_event: Channel<StreamMsg>,
    state: Session,
) -> CmdResult<u64> {
    let conn = state.connection().await?;
    let def = conn.kind(&kind_key)?;
    let owner = Api::<kube::api::DynamicObject>::namespaced_with(conn.client.clone(), &namespace, &def.api_resource())
        .get(&name)
        .await
        .map_err(|e| crate::state::kube_err(&e))?;
    let labels = owner.data.pointer("/spec/selector/matchLabels").and_then(|m| m.as_object()).ok_or_else(|| format!("{name} has no label selector"))?;
    let selector = labels.iter().map(|(k, v)| format!("{k}={}", v.as_str().unwrap_or_default())).collect::<Vec<_>>().join(",");
    let pods_api: Api<Pod> = Api::namespaced(conn.client, &namespace);
    let mut pods: Vec<String> = pods_api
        .list(&kube::api::ListParams::default().labels(&selector))
        .await
        .map_err(|e| crate::state::kube_err(&e))?
        .items
        .into_iter()
        .filter_map(|p| p.metadata.name)
        .collect();
    if pods.is_empty() {
        return Err(format!("{name} has no pods right now"));
    }
    pods.sort();
    pods.truncate(MAX_WORKLOAD_PODS);
    // Share the history between pods so the first screen is not one pod's backlog.
    let tail = (tail_lines.unwrap_or(500) / pods.len() as i64).max(20);
    let id = state.next_id();

    let task = tauri::async_runtime::spawn(async move {
        let mut streams = Vec::new();
        for pod in &pods {
            let params = LogParams { follow: true, tail_lines: Some(tail), ..Default::default() };
            match pods_api.log_stream(pod, &params).await {
                Ok(reader) => {
                    let pod = pod.clone();
                    streams.push(reader.lines().map(move |line| (pod.clone(), line)).boxed());
                }
                Err(e) => {
                    let _ = on_event.send(StreamMsg::Data { data: format!("[kubedeck] cannot read logs: {e}"), source: Some(pod.clone()) });
                }
            }
        }
        let mut merged = futures::stream::select_all(streams);
        while let Some((pod, line)) = merged.next().await {
            let Ok(data) = line else { continue };
            if on_event.send(StreamMsg::Data { data, source: Some(pod) }).is_err() {
                return;
            }
        }
        let _ = on_event.send(StreamMsg::End { message: None });
    });
    state.track(id, task);
    Ok(id)
}

pub struct ExecHandle {
    pub task: JoinHandle<()>,
    input: mpsc::UnboundedSender<Vec<u8>>,
    resize: futures::channel::mpsc::Sender<TerminalSize>,
}

/// Prefers bash, falls back to sh — same as most Kubernetes UIs and `kubectl exec -it ... sh`.
const SHELL: &[&str] = &["sh", "-c", "command -v bash >/dev/null 2>&1 && exec bash || exec sh"];

#[tauri::command]
pub async fn exec_start(
    namespace: String,
    pod: String,
    container: Option<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<StreamMsg>,
    state: Session,
) -> CmdResult<u64> {
    // A shell can change anything inside the container.
    state.writable()?;
    let api: Api<Pod> = Api::namespaced(state.connection().await?.client, &namespace);
    let mut params = AttachParams::interactive_tty();
    if let Some(c) = container {
        params = params.container(c);
    }
    let mut proc = api.exec(&pod, SHELL.to_vec(), &params).await.map_err(err)?;
    let mut stdin = proc.stdin().ok_or("exec session has no stdin")?;
    let mut stdout = proc.stdout().ok_or("exec session has no stdout")?;
    let mut resize = proc.terminal_size().ok_or("exec session has no tty")?;
    let _ = resize.send(TerminalSize { width: cols, height: rows }).await;

    let (input, mut input_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let id = state.next_id();

    let task = tauri::async_runtime::spawn(async move {
        let mut buf = vec![0u8; 16 * 1024];
        // Bytes of a UTF-8 character split across reads wait here for the next chunk.
        let mut pending: Vec<u8> = Vec::new();
        loop {
            tokio::select! {
                read = stdout.read(&mut buf) => match read {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        let valid = match std::str::from_utf8(&pending) {
                            Ok(_) => pending.len(),
                            Err(e) if e.error_len().is_none() => e.valid_up_to(),
                            Err(_) => pending.len(), // genuinely invalid bytes: emit lossily
                        };
                        let data = String::from_utf8_lossy(&pending[..valid]).into_owned();
                        pending.drain(..valid);
                        if on_event.send(StreamMsg::Data { data, source: None }).is_err() {
                            break;
                        }
                    }
                },
                Some(bytes) = input_rx.recv() => {
                    if stdin.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
            }
        }
        drop(stdin);
        let status = proc.take_status();
        let message = match status {
            Some(status) => status.await.and_then(|s| s.message),
            None => None,
        };
        let _ = on_event.send(StreamMsg::End { message });
    });

    state.execs.lock().unwrap().insert(id, ExecHandle { task, input, resize });
    Ok(id)
}

#[tauri::command]
pub fn exec_input(id: u64, data: String, state: Session) -> CmdResult<()> {
    let execs = state.execs.lock().unwrap();
    let exec = execs.get(&id).ok_or("exec session ended")?;
    exec.input.send(data.into_bytes()).map_err(|_| "exec session ended".to_owned())
}

#[tauri::command]
pub fn exec_resize(id: u64, cols: u16, rows: u16, state: Session) -> CmdResult<()> {
    let mut execs = state.execs.lock().unwrap();
    let exec = execs.get_mut(&id).ok_or("exec session ended")?;
    // try_send: a dropped resize is harmless, the next one will catch up.
    let _ = exec.resize.try_send(TerminalSize { width: cols, height: rows });
    Ok(())
}
