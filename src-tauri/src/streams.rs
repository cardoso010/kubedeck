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

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LogMsg {
    /// Lines gathered over [`LOG_BATCH_EVERY`] (a chatty pod writes thousands a second).
    Lines { lines: Vec<LogLine> },
    End { message: Option<String> },
}

#[derive(Serialize, Clone)]
pub struct LogLine {
    text: String,
    /// The pod a line came from, for logs merged from several pods.
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

const LOG_BATCH_EVERY: std::time::Duration = std::time::Duration::from_millis(50);
const LOG_BATCH_MAX: usize = 1000;

/// Sends `lines` in batches until the stream ends or fails. Returns false once the window went away.
async fn send_batched<E>(mut lines: impl futures::Stream<Item = Result<LogLine, E>> + Unpin, on_event: &Channel<LogMsg>) -> Result<bool, E> {
    let mut batch = Vec::new();
    let mut flush_at: Option<tokio::time::Instant> = None;
    let send = |batch: &mut Vec<LogLine>| batch.is_empty() || on_event.send(LogMsg::Lines { lines: std::mem::take(batch) }).is_ok();
    loop {
        tokio::select! {
            next = lines.next() => match next {
                Some(Ok(line)) => {
                    batch.push(line);
                    flush_at.get_or_insert_with(|| tokio::time::Instant::now() + LOG_BATCH_EVERY);
                    if batch.len() >= LOG_BATCH_MAX {
                        flush_at = None;
                        if !send(&mut batch) {
                            return Ok(false);
                        }
                    }
                }
                Some(Err(e)) => {
                    send(&mut batch);
                    return Err(e);
                }
                None => return Ok(send(&mut batch)),
            },
            _ = tokio::time::sleep_until(flush_at.unwrap_or_else(tokio::time::Instant::now)), if flush_at.is_some() => {
                flush_at = None;
                if !send(&mut batch) {
                    return Ok(false);
                }
            }
        }
    }
}

#[tauri::command]
pub async fn stream_logs(
    namespace: String,
    pod: String,
    container: Option<String>,
    tail_lines: Option<i64>,
    previous: Option<bool>,
    on_event: Channel<LogMsg>,
    state: Session,
) -> CmdResult<u64> {
    let api: Api<Pod> = Api::namespaced(state.connection().await?.client, &namespace);
    // The previous run's logs are finished, so there is nothing to follow.
    let previous = previous.unwrap_or(false);
    let params = LogParams { follow: !previous, previous, container, tail_lines: Some(tail_lines.unwrap_or(500)), ..Default::default() };
    let id = state.next_id();

    let task = tauri::async_runtime::spawn(async move {
        let result: Result<bool, kube::Error> = async {
            let lines = api.log_stream(&pod, &params).await?.lines().map_ok(|text| LogLine { text, source: None });
            send_batched(lines, &on_event).await.map_err(kube::Error::ReadEvents)
        }
        .await;
        if !matches!(result, Ok(false)) {
            let _ = on_event.send(LogMsg::End { message: result.err().map(|e| e.to_string()) });
        }
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
    on_event: Channel<LogMsg>,
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
        // Open every pod's stream at once: one at a time, 20 pods cost 20 round trips.
        let params = LogParams { follow: true, tail_lines: Some(tail), ..Default::default() };
        let opened = futures::future::join_all(pods.iter().map(|pod| pods_api.log_stream(pod, &params))).await;
        let mut streams = Vec::new();
        let mut failures = Vec::new();
        for (pod, reader) in pods.into_iter().zip(opened) {
            match reader {
                Ok(reader) => {
                    let source = Some(pod);
                    // A broken line ends nothing: the other pods keep going.
                    streams.push(reader.lines().filter_map(move |line| futures::future::ready(line.ok().map(|text| Ok::<_, std::convert::Infallible>(LogLine { text, source: source.clone() })))).boxed());
                }
                Err(e) => failures.push(LogLine { text: format!("[kubedeck] cannot read logs: {e}"), source: Some(pod) }),
            }
        }
        if !failures.is_empty() && on_event.send(LogMsg::Lines { lines: failures }).is_err() {
            return;
        }
        if let Ok(true) = send_batched(futures::stream::select_all(streams), &on_event).await {
            let _ = on_event.send(LogMsg::End { message: None });
        }
    });
    state.track(id, task);
    Ok(id)
}

pub struct ExecHandle {
    pub task: JoinHandle<()>,
    input: mpsc::UnboundedSender<Vec<u8>>,
    resize: futures::channel::mpsc::Sender<TerminalSize>,
    /// Set when the window is locked: the shell ends, since it could change anything.
    pub close: tokio::sync::watch::Sender<bool>,
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
    let (close, mut closed) = tokio::sync::watch::channel(false);
    let id = state.next_id();

    let task = tauri::async_runtime::spawn(async move {
        let mut buf = vec![0u8; 16 * 1024];
        // Bytes of a UTF-8 character split across reads wait here for the next chunk.
        let mut pending: Vec<u8> = Vec::new();
        let mut locked = false;
        loop {
            tokio::select! {
                _ = closed.changed() => {
                    locked = true;
                    break;
                }
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
            _ if locked => Some("Closed: this window was locked (read-only mode).".to_owned()),
            Some(status) => status.await.and_then(|s| s.message),
            None => None,
        };
        let _ = on_event.send(StreamMsg::End { message });
    });

    state.execs.lock().unwrap().insert(id, ExecHandle { task, input, resize, close });
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
