//! Port forwarding from 127.0.0.1 to a pod, or to a ready pod behind a service.

use std::sync::{Arc, Mutex};

use k8s_openapi::api::core::v1::{Pod, Service};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::api::{Api, ListParams};
use kube::Client;
use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tokio::net::{TcpListener, TcpStream};

use crate::state::{err, CmdResult, Session};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ForwardInfo {
    id: u64,
    /// "pod" or "service"
    kind: String,
    namespace: String,
    name: String,
    remote_port: u16,
    local_port: u16,
    connections: u64,
    last_error: Option<String>,
}

pub struct Forward {
    pub task: JoinHandle<()>,
    info: Arc<Mutex<ForwardInfo>>,
}

#[tauri::command]
pub async fn start_port_forward(
    kind: String,
    namespace: String,
    name: String,
    remote_port: u16,
    local_port: Option<u16>,
    state: Session,
) -> CmdResult<ForwardInfo> {
    if kind != "pod" && kind != "service" {
        return Err(format!("Cannot port-forward a {kind}"));
    }
    let client = state.connection().await?.client;
    // Resolve once up front so a typo or a service without ready pods fails here,
    // not silently on the first connection.
    resolve(&client, &kind, &namespace, &name, remote_port).await?;

    // Port 0 lets the OS pick a free port.
    let listener = TcpListener::bind(("127.0.0.1", local_port.unwrap_or(0)))
        .await
        .map_err(|e| format!("Cannot listen on 127.0.0.1:{}: {e}", local_port.unwrap_or(0)))?;
    let id = state.next_id();
    let info = Arc::new(Mutex::new(ForwardInfo {
        id,
        kind: kind.clone(),
        namespace: namespace.clone(),
        name: name.clone(),
        remote_port,
        local_port: listener.local_addr().map_err(err)?.port(),
        connections: 0,
        last_error: None,
    }));

    let shared = info.clone();
    let task = tauri::async_runtime::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            shared.lock().unwrap().connections += 1;
            let (client, kind, namespace, name, shared) = (client.clone(), kind.clone(), namespace.clone(), name.clone(), shared.clone());
            tauri::async_runtime::spawn(async move {
                let result = forward_connection(socket, &client, &kind, &namespace, &name, remote_port).await;
                shared.lock().unwrap().last_error = result.err();
            });
        }
    });

    let snapshot = info.lock().unwrap().clone();
    state.forwards.lock().unwrap().insert(id, Forward { task, info });
    Ok(snapshot)
}

#[tauri::command]
pub fn list_port_forwards(state: Session) -> Vec<ForwardInfo> {
    let mut list: Vec<ForwardInfo> = state.forwards.lock().unwrap().values().map(|f| f.info.lock().unwrap().clone()).collect();
    list.sort_by_key(|f| f.id);
    list
}

/// One TCP connection = one port-forward stream. A service is re-resolved per connection,
/// so the forward keeps working when its pods are replaced.
async fn forward_connection(mut socket: TcpStream, client: &Client, kind: &str, namespace: &str, name: &str, remote_port: u16) -> Result<(), String> {
    let (pod, port) = resolve(client, kind, namespace, name, remote_port).await?;
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let mut forwarder = pods.portforward(&pod, &[port]).await.map_err(err)?;
    let mut upstream = forwarder.take_stream(port).ok_or("port-forward stream unavailable")?;
    // A reset from either side is the normal way for many clients to end a connection.
    let _ = tokio::io::copy_bidirectional(&mut socket, &mut upstream).await;
    drop(upstream);
    forwarder.join().await.map_err(err)
}

/// Returns the pod and container port that traffic for `name:remote_port` should reach.
async fn resolve(client: &Client, kind: &str, namespace: &str, name: &str, remote_port: u16) -> Result<(String, u16), String> {
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    if kind == "pod" {
        pods.get(name).await.map_err(err)?;
        return Ok((name.to_owned(), remote_port));
    }

    let services: Api<Service> = Api::namespaced(client.clone(), namespace);
    let spec = services.get(name).await.map_err(err)?.spec.unwrap_or_default();
    let selector = spec.selector.filter(|s| !s.is_empty()).ok_or_else(|| format!("Service {name} has no selector, so it has no pods to forward to"))?;
    let target = spec.ports.unwrap_or_default().into_iter().find(|p| p.port == i32::from(remote_port)).and_then(|p| p.target_port);

    let labels = selector.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(",");
    let candidates = pods.list(&ListParams::default().labels(&labels)).await.map_err(err)?;
    let pod = candidates
        .items
        .into_iter()
        .find(|p| {
            p.metadata.deletion_timestamp.is_none()
                && p.status.as_ref().and_then(|s| s.conditions.as_ref()).is_some_and(|c| c.iter().any(|c| c.type_ == "Ready" && c.status == "True"))
        })
        .ok_or_else(|| format!("Service {name} has no ready pods"))?;

    let port = match target {
        Some(IntOrString::Int(n)) => u16::try_from(n).map_err(err)?,
        // Named target port: look it up in the chosen pod's containers.
        Some(IntOrString::String(port_name)) => pod
            .spec
            .iter()
            .flat_map(|s| &s.containers)
            .flat_map(|c| c.ports.iter().flatten())
            .find(|p| p.name.as_deref() == Some(port_name.as_str()))
            .and_then(|p| u16::try_from(p.container_port).ok())
            .ok_or_else(|| format!("Pod has no port named {port_name}"))?,
        None => remote_port,
    };
    Ok((pod.metadata.name.unwrap_or_default(), port))
}
