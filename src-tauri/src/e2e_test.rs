//! End-to-end test of the backend commands against a real, disposable cluster.
//!
//! Needs the kind cluster from `e2e/setup.sh`, then (see README.md, "Testing"):
//!   KUBECONFIG=../.kind-kubeconfig KUBEDECK_E2E_CONTEXT=kind-kubedeck-test cargo test -- --include-ignored
//! Never point it at a shared cluster: it edits a ConfigMap, deletes a pod and rolls back
//! and uninstalls Helm releases.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::Manager;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::{cluster, helm, metrics, portforward, resources, state::AppState, streams};

type Inbox = Arc<Mutex<Vec<Value>>>;

fn channel<T: serde::Serialize>() -> (Channel<T>, Inbox) {
    let inbox: Inbox = Arc::default();
    let sink = inbox.clone();
    let ch = Channel::new(move |body| {
        if let InvokeResponseBody::Json(json) = body {
            sink.lock().unwrap().push(serde_json::from_str(&json).unwrap());
        }
        Ok(())
    });
    (ch, inbox)
}

async fn wait_for(inbox: &Inbox, what: &str, pred: impl Fn(&[Value]) -> bool) {
    for _ in 0..300 {
        if pred(&inbox.lock().unwrap()) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("timed out waiting for {what}; got {:#?}", inbox.lock().unwrap());
}

fn opt(s: &str) -> Option<String> {
    Some(s.to_owned())
}

fn test_context() -> String {
    let context = std::env::var("KUBEDECK_E2E_CONTEXT").expect("set KUBEDECK_E2E_CONTEXT");
    assert!(!crate_is_production(&context), "refusing to run against {context}");
    context
}

fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
    crate::install_crypto_provider();
    tauri::test::mock_builder()
        .manage(AppState::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a disposable cluster, see module docs"]
async fn backend_against_real_cluster() {
    let context = test_context();
    let app = mock_app();
    let state = || app.state::<AppState>();

    // Contexts and connection
    let contexts = serde_json::to_value(cluster::list_contexts().unwrap()).unwrap();
    assert!(contexts["contexts"].as_array().unwrap().iter().any(|c| c["name"] == context.as_str()));
    let connected = serde_json::to_value(cluster::connect(context.clone(), state()).await.unwrap()).unwrap();
    assert!(connected["serverVersion"].as_str().unwrap().starts_with('v'), "{connected}");
    let namespaces = cluster::list_namespaces(state()).await.unwrap();
    assert!(namespaces.contains(&"demo".to_owned()), "{namespaces:?}");

    // Watch: initial snapshot with summarized rows
    let (ch, pods) = channel();
    let watch_id = resources::watch_resources("pods".into(), opt("demo"), ch, state()).await.unwrap();
    wait_for(&pods, "pod snapshot", |m| m.iter().any(|m| m["type"] == "snapshot")).await;
    let snapshot = pods.lock().unwrap().iter().find(|m| m["type"] == "snapshot").unwrap()["rows"].clone();
    let row = |name: &str| snapshot.as_array().unwrap().iter().find(|r| r["name"].as_str().unwrap().starts_with(name)).cloned().unwrap();
    let ticker = row("ticker");
    assert_eq!(ticker["cells"][0], "1/1");
    assert_eq!(ticker["cells"][1], "Running");
    assert_eq!(ticker["containers"], serde_json::json!(["ticker"]));
    let broken = row("broken");
    assert!(matches!(broken["cells"][1].as_str(), Some("Error" | "CrashLoopBackOff")), "{broken}");
    assert_ne!(broken["cells"][2], "0", "restarts should be counted");
    let web = row("web-");

    // YAML read / replace / conflict detection
    let yaml = resources::get_yaml("configmaps".into(), opt("demo"), "app-config".into(), state()).await.unwrap();
    assert!(!yaml.contains("managedFields"), "{yaml}");
    // Flip LOG_LEVEL whatever it is now (people edit it by hand while trying the app).
    let (from, to) = if yaml.contains("LOG_LEVEL: debug") { ("LOG_LEVEL: debug", "LOG_LEVEL: info") } else { ("LOG_LEVEL: info", "LOG_LEVEL: debug") };
    assert!(yaml.contains(from), "{yaml}");
    let edited = yaml.replace(from, to);
    let saved = resources::replace_yaml("configmaps".into(), opt("demo"), "app-config".into(), edited.clone(), state()).await.unwrap();
    assert!(saved.contains(to));
    let stale = resources::replace_yaml("configmaps".into(), opt("demo"), "app-config".into(), edited, state()).await;
    assert!(stale.unwrap_err().contains("modified"), "stale resourceVersion must be rejected");
    let renamed = resources::replace_yaml("configmaps".into(), opt("demo"), "app-config".into(), saved.replace("name: app-config", "name: other"), state()).await;
    assert!(renamed.is_err());
    // Put it back as it was.
    resources::replace_yaml("configmaps".into(), opt("demo"), "app-config".into(), saved.replace(to, from), state()).await.unwrap();

    // Delete: watch reports the deletion and the Deployment's replacement pod
    let web_name = web["name"].as_str().unwrap().to_owned();
    let web_uid = web["uid"].clone();
    resources::delete_resource("pods".into(), opt("demo"), web_name.clone(), state()).await.unwrap();
    wait_for(&pods, "delete event", |m| m.iter().any(|m| m["type"] == "delete" && m["uid"] == web_uid)).await;
    wait_for(&pods, "replacement pod", |m| {
        m.iter().any(|m| m["type"] == "upsert" && m["row"]["name"].as_str().unwrap().starts_with("web-") && m["row"]["name"] != web_name.as_str())
    })
    .await;
    resources::stop_stream(watch_id, state());

    // Logs
    let (ch, logs) = channel();
    let logs_id = streams::stream_logs("demo".into(), "ticker".into(), None, Some(5), ch, state()).await.unwrap();
    wait_for(&logs, "log lines", |m| m.iter().filter(|m| m["type"] == "data" && m["data"].as_str().unwrap().starts_with("tick ")).count() >= 3).await;
    resources::stop_stream(logs_id, state());

    // Interactive exec with a tty
    let (ch, term) = channel();
    let exec_id = streams::exec_start("demo".into(), "ticker".into(), opt("ticker"), 100, 30, ch, state()).await.unwrap();
    streams::exec_resize(exec_id, 120, 40, state()).unwrap();
    streams::exec_input(exec_id, "echo kubedeck-$((40+2))\r".into(), state()).unwrap();
    let output = |m: &[Value]| m.iter().filter(|m| m["type"] == "data").map(|m| m["data"].as_str().unwrap().to_owned()).collect::<String>();
    wait_for(&term, "exec output", |m| output(m).contains("kubedeck-42")).await;
    // The resize travels on its own channel, so ask until the shell sees the new size.
    let mut resized = false;
    for _ in 0..20 {
        streams::exec_input(exec_id, "stty size\r".into(), state()).unwrap();
        tokio::time::sleep(Duration::from_millis(250)).await;
        if output(&term.lock().unwrap()).contains("40 120") {
            resized = true;
            break;
        }
    }
    assert!(resized, "tty resize not applied: {}", output(&term.lock().unwrap()));
    streams::exec_input(exec_id, "exit\r".into(), state()).unwrap();
    wait_for(&term, "exec end", |m| m.iter().any(|m| m["type"] == "end")).await;
    resources::stop_stream(exec_id, state());
}

/// Sends a plain HTTP request through 127.0.0.1:port and returns the response.
async fn http_get(port: u16) -> String {
    let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    socket.write_all(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n").await.unwrap();
    let mut response = String::new();
    tokio::time::timeout(Duration::from_secs(20), socket.read_to_string(&mut response)).await.expect("http timeout").unwrap();
    response
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a disposable cluster, see module docs"]
async fn port_forward_against_real_cluster() {
    let context = test_context();
    let app = mock_app();
    let state = || app.state::<AppState>();
    cluster::connect(context, state()).await.unwrap();

    // Service: resolved to a ready pod behind it, auto-assigned local port.
    let svc = serde_json::to_value(portforward::start_port_forward("service".into(), "demo".into(), "web".into(), 80, None, state()).await.unwrap()).unwrap();
    let port = svc["localPort"].as_u64().unwrap() as u16;
    assert_ne!(port, 0);
    // Several connections each get their own stream.
    for _ in 0..3 {
        let response = http_get(port).await;
        assert!(response.starts_with("HTTP/1.1 200") && response.contains("nginx"), "{response}");
    }

    // Pod, on an explicit local port.
    let pods = cluster::list_namespaces(state()).await.unwrap();
    assert!(pods.contains(&"demo".to_owned()));
    let k8s: kube::Api<k8s_openapi::api::core::v1::Pod> = kube::Api::namespaced(state().connection().await.unwrap().client, "demo");
    let web_pod = k8s.list(&kube::api::ListParams::default().labels("app=web")).await.unwrap().items[0].metadata.name.clone().unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let free_port = listener.local_addr().unwrap().port();
    drop(listener);
    let pod = serde_json::to_value(portforward::start_port_forward("pod".into(), "demo".into(), web_pod, 80, Some(free_port), state()).await.unwrap()).unwrap();
    assert_eq!(pod["localPort"], free_port);
    assert!(http_get(free_port).await.contains("nginx"));

    let listed = serde_json::to_value(portforward::list_port_forwards(state())).unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 2);
    assert_eq!(listed[0]["connections"], 3, "{listed}");

    // Errors surface at start instead of on the first connection.
    assert!(portforward::start_port_forward("service".into(), "demo".into(), "missing".into(), 80, None, state()).await.is_err());
    assert!(portforward::start_port_forward("pod".into(), "demo".into(), "x".into(), 80, Some(free_port), state()).await.is_err());

    // Stopping closes the listener.
    resources::stop_stream(svc["id"].as_u64().unwrap(), state());
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_err(), "listener should be closed");
    assert_eq!(portforward::list_port_forwards(state()).len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a disposable cluster, see module docs"]
async fn helm_against_real_cluster() {
    let context = test_context();
    let app = mock_app();
    let state = || app.state::<AppState>();
    cluster::connect(context, state()).await.unwrap();

    let releases = serde_json::to_value(helm::helm_list(Some("demo".into()), state()).await.unwrap()).unwrap();
    let hello = releases.as_array().unwrap().iter().find(|r| r["name"] == "hello").expect("hello release (see README)").clone();
    assert_eq!(hello["status"], "deployed");
    assert!(hello["updated"].as_str().unwrap().contains('T'), "{hello}");
    let all = helm::helm_list(None, state()).await.unwrap();
    assert!(!all.is_empty());

    let details = serde_json::to_value(helm::helm_details("demo".into(), "hello".into(), state()).await.unwrap()).unwrap();
    assert!(details["values"].as_str().unwrap().contains("replicaCount"), "{details}");
    assert!(details["manifest"].as_str().unwrap().contains("kind: Deployment"));
    let history = details["history"].as_array().unwrap();
    assert!(history.len() >= 2);
    assert!(history[0]["revision"].as_u64() > history[1]["revision"].as_u64(), "newest first");

    // Roll back to the previous revision: a new revision appears on top.
    let latest = history[0]["revision"].as_u64().unwrap();
    let previous = history[1]["revision"].as_u64().unwrap() as u32;
    helm::helm_rollback("demo".into(), "hello".into(), previous, state()).await.unwrap();
    let after = serde_json::to_value(helm::helm_details("demo".into(), "hello".into(), state()).await.unwrap()).unwrap();
    assert_eq!(after["history"][0]["revision"].as_u64().unwrap(), latest + 1);
    assert!(after["history"][0]["description"].as_str().unwrap().contains(&format!("Rollback to {previous}")));

    // Uninstall a throwaway release.
    let dir = std::env::temp_dir().join(format!("kubedeck-chart-{}", std::process::id()));
    let helm_bin = std::env::var("KUBEDECK_HELM").unwrap_or_else(|_| "helm".into());
    let run = |args: &[&str]| std::process::Command::new(&helm_bin).args(args).output().unwrap();
    assert!(run(&["create", dir.to_str().unwrap()]).status.success());
    assert!(run(&["install", "throwaway", dir.to_str().unwrap(), "-n", "demo", "--set", "replicaCount=0"]).status.success());
    helm::helm_uninstall("demo".into(), "throwaway".into(), state()).await.unwrap();
    let names: Vec<Value> = serde_json::to_value(helm::helm_list(Some("demo".into()), state()).await.unwrap()).unwrap().as_array().unwrap().iter().map(|r| r["name"].clone()).collect();
    assert!(!names.contains(&Value::from("throwaway")));
    let _ = std::fs::remove_dir_all(dir);

    // CLI errors come back readable.
    let missing = helm::helm_details("demo".into(), "nope".into(), state()).await.err().unwrap();
    assert!(missing.contains("not found"), "{missing}");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a disposable cluster, see module docs"]
async fn custom_resources_and_metrics_against_real_cluster() {
    let context = test_context();
    let app = mock_app();
    let state = || app.state::<AppState>();

    // Before connecting only built-ins are offered; after, the cluster's CRDs too.
    let before = serde_json::to_value(resources::list_kinds(state()).await.unwrap()).unwrap();
    assert!(before.as_array().unwrap().iter().all(|k| k["group"].is_null()));
    cluster::connect(context, state()).await.unwrap();
    let kinds = serde_json::to_value(resources::list_kinds(state()).await.unwrap()).unwrap();
    let widget = kinds.as_array().unwrap().iter().find(|k| k["key"] == "widgets.kubedeck.dev").expect("Widget CRD (e2e/setup.sh)").clone();
    assert_eq!(widget["group"], "kubedeck.dev");
    assert_eq!(widget["columns"], serde_json::json!(["Size"]), "priority>0 and Age columns are hidden");

    // Custom resources are watched like any kind, with printer columns as cells.
    let (ch, inbox) = channel();
    let id = resources::watch_resources("widgets.kubedeck.dev".into(), opt("demo"), ch, state()).await.unwrap();
    wait_for(&inbox, "widget snapshot", |m| m.iter().any(|m| m["type"] == "snapshot")).await;
    let rows = inbox.lock().unwrap().iter().find(|m| m["type"] == "snapshot").unwrap()["rows"].clone();
    let sprocket = rows.as_array().unwrap().iter().find(|r| r["name"] == "sprocket").expect("sprocket widget").clone();
    assert_eq!(sprocket["cells"], serde_json::json!(["large"]));
    resources::stop_stream(id, state());
    let yaml = resources::get_yaml("widgets.kubedeck.dev".into(), opt("demo"), "sprocket".into(), state()).await.unwrap();
    assert!(yaml.contains("kind: Widget") && yaml.contains("color: blue"), "{yaml}");

    // Metrics from metrics-server.
    let pods = serde_json::to_value(metrics::pod_metrics(opt("demo"), state()).await.unwrap()).unwrap();
    let ticker = pods.as_array().unwrap().iter().find(|p| p["name"] == "ticker").expect("ticker metrics").clone();
    assert_eq!(ticker["namespace"], "demo");
    assert!(ticker["memoryBytes"].as_f64().unwrap() > 0.0, "{ticker}");
    let nodes = serde_json::to_value(metrics::node_metrics(state()).await.unwrap()).unwrap();
    let node = &nodes[0];
    assert!(node["cpuMillis"].as_f64().unwrap() > 0.0, "{node}");
    assert!(node["cpuAllocatableMillis"].as_f64().unwrap() >= 1000.0, "{node}");
    assert!(node["memoryAllocatableBytes"].as_f64().unwrap() > node["memoryBytes"].as_f64().unwrap());
}

fn crate_is_production(context: &str) -> bool {
    let lower = context.to_lowercase();
    ["prd", "prod", "production"].iter().any(|p| lower.contains(p))
}
