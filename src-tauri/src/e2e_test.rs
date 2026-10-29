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

use crate::state::{Session, Sessions};
use crate::{ai, cluster, diagnostics, helm, helm_charts, metrics, nodes, pod_insights, portforward, resources, streams, workloads};

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
    mock_app_with(Sessions::default())
}

fn mock_app_with(state: Sessions) -> tauri::App<tauri::test::MockRuntime> {
    crate::install_crypto_provider();
    tauri::test::mock_builder()
        .manage(state)
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a disposable cluster, see module docs"]
async fn backend_against_real_cluster() {
    let context = test_context();
    let app = mock_app();
    let state = || Session::of(&app, "main");

    // Contexts and connection
    let contexts = serde_json::to_value(cluster::list_contexts().unwrap()).unwrap();
    assert!(contexts["contexts"].as_array().unwrap().iter().any(|c| c["name"] == context.as_str()));
    let connected = serde_json::to_value(cluster::connect(context.clone(), state()).await.unwrap()).unwrap();
    assert!(connected["serverVersion"].as_str().unwrap().starts_with('v'), "{connected}");
    let namespaces = cluster::list_namespaces(state()).await.unwrap();
    assert!(namespaces.contains(&"demo".to_owned()), "{namespaces:?}");

    // Watch: initial snapshot with summarized rows
    let (ch, pods) = channel();
    let watch_id = resources::watch_resources("pods".into(), vec!["demo".into()], ch, state()).await.unwrap();
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
    let yaml = resources::get_yaml("configmaps".into(), opt("demo"), "app-config".into(), None, state()).await.unwrap();
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
    let logs_id = streams::stream_logs("demo".into(), "ticker".into(), None, Some(5), None, ch, state()).await.unwrap();
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
    let state = || Session::of(&app, "main");
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
    let state = || Session::of(&app, "main");
    cluster::connect(context, state()).await.unwrap();

    let releases = serde_json::to_value(helm::helm_list(vec!["demo".into()], state()).await.unwrap()).unwrap();
    let hello = releases.as_array().unwrap().iter().find(|r| r["name"] == "hello").expect("hello release (see README)").clone();
    assert_eq!(hello["status"], "deployed");
    assert!(hello["updated"].as_str().unwrap().contains('T'), "{hello}");
    let all = helm::helm_list(vec![], state()).await.unwrap();
    assert!(!all.is_empty());

    let details = serde_json::to_value(helm::helm_details("demo".into(), "hello".into(), state()).await.unwrap()).unwrap();
    // Earlier runs may have rolled back to the install revision, which has no custom values.
    assert!(details["values"].is_string(), "{details}");
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
    let names: Vec<Value> = serde_json::to_value(helm::helm_list(vec!["demo".into()], state()).await.unwrap()).unwrap().as_array().unwrap().iter().map(|r| r["name"].clone()).collect();
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
    let state = || Session::of(&app, "main");

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
    let id = resources::watch_resources("widgets.kubedeck.dev".into(), vec!["demo".into()], ch, state()).await.unwrap();
    wait_for(&inbox, "widget snapshot", |m| m.iter().any(|m| m["type"] == "snapshot")).await;
    let rows = inbox.lock().unwrap().iter().find(|m| m["type"] == "snapshot").unwrap()["rows"].clone();
    let sprocket = rows.as_array().unwrap().iter().find(|r| r["name"] == "sprocket").expect("sprocket widget").clone();
    assert_eq!(sprocket["cells"], serde_json::json!(["large"]));
    resources::stop_stream(id, state());
    let yaml = resources::get_yaml("widgets.kubedeck.dev".into(), opt("demo"), "sprocket".into(), None, state()).await.unwrap();
    assert!(yaml.contains("kind: Widget") && yaml.contains("color: blue"), "{yaml}");

    // Metrics from metrics-server.
    let pods = serde_json::to_value(metrics::pod_metrics(vec!["demo".into()], state()).await.unwrap()).unwrap();
    let ticker = pods.as_array().unwrap().iter().find(|p| p["name"] == "ticker").expect("ticker metrics").clone();
    assert_eq!(ticker["namespace"], "demo");
    assert!(ticker["memoryBytes"].as_f64().unwrap() > 0.0, "{ticker}");
    let nodes = serde_json::to_value(metrics::node_metrics(state()).await.unwrap()).unwrap();
    let node = &nodes[0];
    assert!(node["cpuMillis"].as_f64().unwrap() > 0.0, "{node}");
    assert!(node["cpuAllocatableMillis"].as_f64().unwrap() >= 1000.0, "{node}");
    assert!(node["memoryAllocatableBytes"].as_f64().unwrap() > node["memoryBytes"].as_f64().unwrap());
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a disposable cluster, see module docs"]
async fn several_namespaces_against_real_cluster() {
    let context = test_context();
    let app = mock_app();
    let state = || Session::of(&app, "main");
    cluster::connect(context, state()).await.unwrap();
    let namespaces = |rows: &Value| -> std::collections::BTreeSet<String> {
        rows.as_array().unwrap().iter().map(|r| r["namespace"].as_str().unwrap().to_owned()).collect()
    };

    // Pods from exactly the selected namespaces, in one snapshot.
    let (ch, inbox) = channel();
    let id = resources::watch_resources("pods".into(), vec!["demo".into(), "demo2".into()], ch, state()).await.unwrap();
    wait_for(&inbox, "snapshot", |m| m.iter().any(|m| m["type"] == "snapshot")).await;
    let snapshots: Vec<Value> = inbox.lock().unwrap().iter().filter(|m| m["type"] == "snapshot").cloned().collect();
    assert_eq!(snapshots.len(), 1, "one combined snapshot, not one per namespace");
    let rows = &snapshots[0]["rows"];
    assert_eq!(namespaces(rows), ["demo".to_owned(), "demo2".to_owned()].into());
    assert!(rows.as_array().unwrap().iter().any(|r| r["name"].as_str().unwrap().starts_with("worker-")));

    // Live events from either namespace keep flowing through the merged stream.
    let k8s: kube::Api<k8s_openapi::api::core::v1::Pod> = kube::Api::namespaced(state().connection().await.unwrap().client, "demo2");
    let victim = k8s.list(&kube::api::ListParams::default().labels("app=worker")).await.unwrap().items[0].metadata.clone();
    // The worker ignores SIGTERM; skip the 30s grace period.
    k8s.delete(victim.name.as_deref().unwrap(), &kube::api::DeleteParams { grace_period_seconds: Some(0), ..Default::default() }).await.unwrap();
    let uid = Value::from(victim.uid.unwrap());
    wait_for(&inbox, "delete from demo2", |m| m.iter().any(|m| m["type"] == "delete" && m["uid"] == uid)).await;
    resources::stop_stream(id, state());

    // A namespace that does not exist just contributes nothing.
    let (ch, inbox) = channel();
    let id = resources::watch_resources("pods".into(), vec!["demo2".into(), "no-such-namespace".into()], ch, state()).await.unwrap();
    wait_for(&inbox, "snapshot", |m| m.iter().any(|m| m["type"] == "snapshot")).await;
    let rows = inbox.lock().unwrap().iter().find(|m| m["type"] == "snapshot").unwrap()["rows"].clone();
    assert_eq!(namespaces(&rows), ["demo2".to_owned()].into());
    resources::stop_stream(id, state());

    // Cluster-scoped kinds ignore the selection.
    let (ch, inbox) = channel();
    let id = resources::watch_resources("nodes".into(), vec!["demo".into()], ch, state()).await.unwrap();
    wait_for(&inbox, "nodes", |m| m.iter().any(|m| m["type"] == "snapshot" && !m["rows"].as_array().unwrap().is_empty())).await;
    resources::stop_stream(id, state());

    // Metrics and Helm follow the same selection.
    let usage = serde_json::to_value(metrics::pod_metrics(vec!["demo".into(), "demo2".into()], state()).await.unwrap()).unwrap();
    let usage_ns = namespaces(&usage);
    assert!(usage_ns.contains("demo") && !usage_ns.contains("kube-system"), "{usage_ns:?}");
    let releases = serde_json::to_value(helm::helm_list(vec!["demo".into(), "demo2".into()], state()).await.unwrap()).unwrap();
    assert!(releases.as_array().unwrap().iter().any(|r| r["name"] == "hello"));
    assert_eq!(namespaces(&releases), ["demo".to_owned()].into());
}

/// Serves the files of `dir` over HTTP on 127.0.0.1; enough for a Helm chart repository.
async fn serve_dir(dir: std::path::PathBuf) -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let dir = dir.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = socket.read(&mut buf).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]);
                let path = request.split_whitespace().nth(1).unwrap_or("/").trim_start_matches('/').to_owned();
                let response = match std::fs::read(dir.join(&path)) {
                    Ok(body) => [format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes(), body].concat(),
                    Err(_) => b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
                };
                let _ = socket.write_all(&response).await;
            });
        }
    });
    port
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a disposable cluster, see module docs"]
async fn helm_charts_against_real_cluster() {
    let context = test_context();
    let work = std::env::temp_dir().join(format!("kubedeck-charts-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&work);
    let repo_dir = work.join("repo");
    std::fs::create_dir_all(&repo_dir).unwrap();

    // Isolated helm config: the user's repositories are never touched.
    let helm_env = vec![
        ("HELM_REPOSITORY_CONFIG".to_owned(), work.join("repositories.yaml").to_string_lossy().into_owned()),
        ("HELM_REPOSITORY_CACHE".to_owned(), work.join("cache").to_string_lossy().into_owned()),
    ];
    let helm_bin = std::env::var("KUBEDECK_HELM").unwrap_or_else(|_| "helm".into());
    let run = |args: &[&str]| {
        let out = std::process::Command::new(&helm_bin).args(args).envs(helm_env.iter().cloned()).output().unwrap();
        assert!(out.status.success(), "helm {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    };

    // A chart repository with greeter 0.1.0 and 0.2.0, served locally.
    let chart = work.join("greeter");
    run(&["create", chart.to_str().unwrap()]);
    run(&["package", chart.to_str().unwrap(), "--version", "0.1.0", "-d", repo_dir.to_str().unwrap()]);
    run(&["package", chart.to_str().unwrap(), "--version", "0.2.0", "-d", repo_dir.to_str().unwrap()]);
    let port = serve_dir(repo_dir.clone()).await;
    let url = format!("http://127.0.0.1:{port}");
    run(&["repo", "index", repo_dir.to_str().unwrap(), "--url", &url]);

    let app = mock_app_with(Sessions::with_helm_env(helm_env.clone()));
    let state = || Session::of(&app, "main");
    cluster::connect(context, state()).await.unwrap();

    // Repositories
    assert!(serde_json::to_value(helm_charts::helm_repo_list(state()).await.unwrap()).unwrap().as_array().unwrap().is_empty());
    helm_charts::helm_repo_add("e2e".into(), url.clone(), state()).await.unwrap();
    helm_charts::helm_repo_update(state()).await.unwrap();
    let repos = serde_json::to_value(helm_charts::helm_repo_list(state()).await.unwrap()).unwrap();
    assert_eq!(repos[0]["name"], "e2e");
    assert!(helm_charts::helm_repo_add("bad".into(), "http://127.0.0.1:1".into(), state()).await.is_err());

    // Search, versions, default values
    let found = serde_json::to_value(helm_charts::helm_search("greeter".into(), state()).await.unwrap()).unwrap();
    assert_eq!(found[0]["name"], "e2e/greeter");
    assert_eq!(found[0]["version"], "0.2.0");
    let versions = serde_json::to_value(helm_charts::helm_chart_versions("e2e/greeter".into(), state()).await.unwrap()).unwrap();
    let versions: Vec<&str> = versions.as_array().unwrap().iter().map(|c| c["version"].as_str().unwrap()).collect();
    assert_eq!(versions, ["0.2.0", "0.1.0"]);
    assert!(helm_charts::helm_chart_versions("oci://example.com/x".into(), state()).await.unwrap().is_empty());
    let defaults = helm_charts::helm_show_values("e2e/greeter".into(), Some("0.1.0".into()), state()).await.unwrap();
    assert!(defaults.contains("replicaCount: 1"), "{defaults}");

    let action = |dry_run: bool, version: &str, values: &str| -> helm_charts::ChartAction {
        serde_json::from_value(serde_json::json!({
            "namespace": "demo2", "name": "greeter", "chart": "e2e/greeter",
            "version": version, "values": values, "dryRun": dry_run
        }))
        .unwrap()
    };
    async fn release(state: Session) -> Option<Value> {
        let list = serde_json::to_value(helm::helm_list(vec!["demo2".into()], state).await.unwrap()).unwrap();
        list.as_array().unwrap().iter().find(|r| r["name"] == "greeter").cloned()
    }

    // Dry run renders without installing.
    let rendered = helm_charts::helm_install(action(true, "0.1.0", "replicaCount: 0\n"), state()).await.unwrap();
    assert!(rendered.contains("kind: Deployment") && rendered.contains("replicas: 0"), "{rendered}");
    assert!(release(state()).await.is_none());

    // Install, then upgrade to the next chart version with different values.
    helm_charts::helm_install(action(false, "0.1.0", "replicaCount: 0\n"), state()).await.unwrap();
    let installed = release(state()).await.expect("greeter installed");
    assert_eq!(installed["chart"], "greeter-0.1.0");
    let err = helm_charts::helm_install(action(false, "0.1.0", ""), state()).await.unwrap_err();
    assert!(err.contains("cannot re-use a name"), "{err}");

    let upgrade_dry = helm_charts::helm_upgrade(action(true, "0.2.0", "replicaCount: 0\nservice:\n  port: 8080\n"), state()).await.unwrap();
    assert!(upgrade_dry.contains("port: 8080"));
    assert_eq!(release(state()).await.unwrap()["revision"], "1", "dry run must not upgrade");
    helm_charts::helm_upgrade(action(false, "0.2.0", "replicaCount: 0\nservice:\n  port: 8080\n"), state()).await.unwrap();
    let upgraded = release(state()).await.unwrap();
    assert_eq!(upgraded["chart"], "greeter-0.2.0");
    assert_eq!(upgraded["revision"], "2");
    let details = serde_json::to_value(helm::helm_details("demo2".into(), "greeter".into(), state()).await.unwrap()).unwrap();
    assert!(details["values"].as_str().unwrap().contains("port: 8080"));

    // Install into a namespace that does not exist yet.
    let ns = format!("kubedeck-e2e-{}", std::process::id());
    let create: helm_charts::ChartAction = serde_json::from_value(serde_json::json!({
        "namespace": ns, "name": "greeter", "chart": "e2e/greeter", "values": "replicaCount: 0\n", "createNamespace": true
    }))
    .unwrap();
    helm_charts::helm_install(create, state()).await.unwrap();
    helm::helm_uninstall(ns.clone(), "greeter".into(), state()).await.unwrap();
    let namespaces: kube::Api<k8s_openapi::api::core::v1::Namespace> = kube::Api::all(state().connection().await.unwrap().client);
    namespaces.delete(&ns, &Default::default()).await.unwrap();

    // Clean up.
    helm::helm_uninstall("demo2".into(), "greeter".into(), state()).await.unwrap();
    helm_charts::helm_repo_remove("e2e".into(), state()).await.unwrap();
    let _ = std::fs::remove_dir_all(&work);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a disposable cluster, see module docs"]
async fn windows_are_independent_sessions() {
    let context = test_context();
    let app = mock_app();
    let (a, b) = (|| Session::of(&app, "main"), || Session::of(&app, "window-1"));

    // Only the first window connects; the second one has no cluster yet.
    cluster::connect(context.clone(), a()).await.unwrap();
    assert!(b().connection().await.is_err());
    cluster::connect(context.clone(), b()).await.unwrap();

    // Each window runs its own watch.
    let (ch, inbox_a) = channel();
    resources::watch_resources("pods".into(), vec!["demo".into()], ch, a()).await.unwrap();
    let (ch, inbox_b) = channel();
    resources::watch_resources("pods".into(), vec!["demo2".into()], ch, b()).await.unwrap();
    wait_for(&inbox_a, "snapshot a", |m| m.iter().any(|m| m["type"] == "snapshot")).await;
    wait_for(&inbox_b, "snapshot b", |m| m.iter().any(|m| m["type"] == "snapshot")).await;
    let forward = serde_json::to_value(portforward::start_port_forward("service".into(), "demo".into(), "web".into(), 80, None, b()).await.unwrap()).unwrap();
    let port = forward["localPort"].as_u64().unwrap() as u16;

    // Reconnecting window A stops A's streams only.
    cluster::connect(context, a()).await.unwrap();
    assert_eq!(portforward::list_port_forwards(b()).len(), 1, "B's port forward must survive");
    assert!(portforward::list_port_forwards(a()).is_empty());
    assert!(http_get(port).await.contains("nginx"));

    // Closing window B stops everything it ran.
    app.state::<Sessions>().close("window-1");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_err(), "B's listener should be closed");
    assert!(Session::of(&app, "window-1").connection().await.is_err(), "a reopened label starts fresh");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a disposable cluster, see module docs"]
async fn pod_metrics_against_real_cluster() {
    let context = test_context();
    let app = mock_app();
    let state = || Session::of(&app, "main");
    cluster::connect(context, state()).await.unwrap();
    let usage = |ns: &str, pod: &str| {
        let (ns, pod) = (ns.to_owned(), pod.to_owned());
        let s = state();
        async move { serde_json::to_value(pod_insights::pod_usage(ns, pod, s).await.unwrap()).unwrap() }
    };

    // Current usage with requests and limits from the spec.
    let limited = usage("demo", "limited").await;
    assert_eq!(limited["metricsServer"], true, "{limited}");
    let app_container = &limited["containers"][0];
    assert_eq!(app_container["name"], "app");
    assert_eq!(app_container["cpuRequestMillis"], 10.0);
    assert_eq!(app_container["cpuLimitMillis"], 50.0);
    assert_eq!(app_container["memoryRequestBytes"], 16.0 * 1024.0 * 1024.0);
    assert_eq!(app_container["memoryLimitBytes"], 64.0 * 1024.0 * 1024.0);
    assert!(app_container["cpuMillis"].as_f64().is_some(), "{app_container}");
    assert_eq!(app_container["state"], "running");

    // Restarts and why the last run ended.
    let broken = usage("demo", "broken").await;
    let c = &broken["containers"][0];
    assert!(c["restarts"].as_i64().unwrap() > 0, "{c}");
    assert!(c["lastTermination"].as_str().unwrap().starts_with("Error (exit 1)"), "{c}");

    // History from Prometheus, found through the API server proxy.
    let target = pod_insights::prometheus_target(state()).await.unwrap();
    assert_eq!(target.as_deref(), Some("monitoring/prometheus-server:80"));
    let history = serde_json::to_value(pod_insights::pod_history("demo".into(), "limited".into(), 15, state()).await.unwrap()).unwrap();
    assert_eq!(history["source"], "monitoring/prometheus-server:80");
    let named = |key: &str, name: &str| history[key].as_array().unwrap().iter().find(|s| s["name"] == name).map(|s| s["points"].as_array().unwrap().len()).unwrap_or(0);
    assert!(named("cpu", "app") > 0, "cpu: {}", history["cpu"]);
    assert!(named("memory", "app") > 0, "memory: {}", history["memory"]);
    assert!(named("network", "receive") > 0 && named("network", "transmit") > 0, "network: {}", history["network"]);
    // A busy loop under a 50m limit gets throttled.
    let throttled = history["throttling"][0]["points"].as_array().map(|p| p.iter().any(|v| v[1].as_f64().unwrap() > 0.1)).unwrap_or(false);
    assert!(throttled, "throttling: {}", history["throttling"]);

    // A pod without samples gives empty charts, not an error.
    let empty = serde_json::to_value(pod_insights::pod_history("demo".into(), "no-such-pod".into(), 15, state()).await.unwrap()).unwrap();
    assert!(empty["cpu"].as_array().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a disposable cluster, see module docs"]
async fn expired_credentials_are_reported_and_recover() {
    use k8s_openapi::api::authentication::v1::{TokenRequest, TokenRequestSpec};
    use k8s_openapi::api::core::v1::ServiceAccount;
    use k8s_openapi::api::rbac::v1::ClusterRoleBinding;
    use kube::api::{DeleteParams, PostParams};

    let context = test_context();
    let app = mock_app();
    let admin = || Session::of(&app, "main");
    let user = || Session::of(&app, "window-1");
    cluster::connect(context, admin()).await.unwrap();
    let client = admin().connection().await.unwrap().client;
    let token_file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../e2e/.auth-token");
    let sas: kube::Api<ServiceAccount> = kube::Api::namespaced(client.clone(), "demo");
    let bindings: kube::Api<ClusterRoleBinding> = kube::Api::all(client.clone());
    let _ = sas.delete("kubedeck-auth", &DeleteParams::default()).await;
    let _ = bindings.delete("kubedeck-auth-view", &DeleteParams::default()).await;
    let binding: ClusterRoleBinding = serde_json::from_value(serde_json::json!({
        "metadata": { "name": "kubedeck-auth-view" },
        "roleRef": { "apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": "view" },
        "subjects": [{ "kind": "ServiceAccount", "name": "kubedeck-auth", "namespace": "demo" }]
    }))
    .unwrap();
    bindings.create(&PostParams::default(), &binding).await.unwrap();

    // Hands the exec plugin a fresh token for a new service account (a "login").
    let login = || async {
        let sa: ServiceAccount = serde_json::from_value(serde_json::json!({ "metadata": { "name": "kubedeck-auth" } })).unwrap();
        sas.create(&PostParams::default(), &sa).await.unwrap();
        let request = TokenRequest { spec: Some(TokenRequestSpec { expiration_seconds: Some(3600), ..Default::default() }), ..Default::default() };
        let token = sas.create_token_request("kubedeck-auth", &PostParams::default(), &request).await.unwrap().status.and_then(|s| s.token).expect("token");
        std::fs::write(&token_file, token).unwrap();
    };
    let watch_pods = || async {
        let (ch, inbox) = channel();
        resources::watch_resources("pods".into(), vec!["demo".into()], ch, user()).await.unwrap();
        wait_for(&inbox, "snapshot or error", |m| m.iter().any(|m| m["type"] == "snapshot" || m["type"] == "error")).await;
        inbox.lock().unwrap().iter().find(|m| m["type"] == "snapshot" || m["type"] == "error").cloned().unwrap()
    };

    login().await;
    let connected = serde_json::to_value(cluster::connect("kind-kubedeck-auth".into(), user()).await.unwrap()).unwrap();
    assert!(connected["auth"]["command"].as_str().unwrap().ends_with("e2e/auth-plugin.sh"), "{connected}");
    assert_eq!(watch_pods().await["type"], "snapshot");

    // The credentials stop working (like an expired AWS session): reported as such.
    sas.delete("kubedeck-auth", &DeleteParams::default()).await.unwrap();
    let mut failed = Value::Null;
    for _ in 0..20 {
        failed = watch_pods().await;
        if failed["type"] == "error" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert_eq!(failed["unauthorized"], true, "{failed}");
    assert!(failed["message"].as_str().unwrap().contains("(401)"), "{failed}");
    let reconnect = cluster::connect("kind-kubedeck-auth".into(), user()).await.err().expect("connect must fail");
    assert!(reconnect.contains("(401)"), "{reconnect}");

    // After a new login, reconnecting runs the plugin again and works.
    login().await;
    cluster::connect("kind-kubedeck-auth".into(), user()).await.unwrap();
    assert_eq!(watch_pods().await["type"], "snapshot");

    let _ = sas.delete("kubedeck-auth", &DeleteParams::default()).await;
    let _ = bindings.delete("kubedeck-auth-view", &DeleteParams::default()).await;
    std::fs::write(&token_file, "").unwrap();
}

/// Polls `check` every 500ms for up to 60s.
async fn eventually<F, Fut>(what: &str, mut check: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    for _ in 0..120 {
        if check().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a disposable cluster, see module docs"]
async fn workload_actions_against_real_cluster() {
    let context = test_context();
    let app = mock_app();
    let state = || Session::of(&app, "main");
    cluster::connect(context, state()).await.unwrap();
    let status = || async { serde_json::to_value(workloads::rollout_status("demo".into(), "rollme".into(), state()).await.unwrap()).unwrap() };
    let deployments: kube::Api<k8s_openapi::api::apps::v1::Deployment> = kube::Api::namespaced(state().connection().await.unwrap().client, "demo");

    // Restart creates a new revision.
    let before = status().await;
    let top = before["revisions"][0]["revision"].as_i64().unwrap();
    assert_eq!(before["revisions"][0]["current"], true, "{before}");
    workloads::rollout_restart("deployments".into(), "demo".into(), "rollme".into(), state()).await.unwrap();
    eventually("restart revision", || async { status().await["revisions"][0]["revision"].as_i64().unwrap() == top + 1 }).await;
    let after = status().await;
    assert!(after["revisions"][0]["templateYaml"].as_str().unwrap().contains("kubectl.kubernetes.io/restartedAt"));
    assert!(workloads::rollout_restart("configmaps".into(), "demo".into(), "app-config".into(), state()).await.is_err());

    // Roll back to the revision before the restart: the controller reuses that ReplicaSet and
    // makes it the newest revision, with exactly the old template.
    let old_template = before["revisions"][0]["templateYaml"].clone();
    workloads::rollback("demo".into(), "rollme".into(), top, state()).await.unwrap();
    eventually("rollback", || {
        let old_template = old_template.clone();
        async move {
            let s = status().await;
            let current = s["revisions"].as_array().unwrap().iter().find(|r| r["current"] == true).cloned().unwrap_or_default();
            current["revision"].as_i64() == Some(top + 2) && current["templateYaml"] == old_template
        }
    })
    .await;
    assert!(workloads::rollback("demo".into(), "rollme".into(), 999, state()).await.unwrap_err().contains("not found"));

    // Scale and pause.
    workloads::scale("deployments".into(), "demo".into(), "rollme".into(), 1, state()).await.unwrap();
    assert_eq!(deployments.get("rollme").await.unwrap().spec.unwrap().replicas, Some(1));
    workloads::scale("deployments".into(), "demo".into(), "rollme".into(), 2, state()).await.unwrap();
    assert!(workloads::scale("deployments".into(), "demo".into(), "rollme".into(), -1, state()).await.is_err());
    workloads::set_paused("demo".into(), "rollme".into(), true, state()).await.unwrap();
    assert_eq!(status().await["paused"], true);
    workloads::set_paused("demo".into(), "rollme".into(), false, state()).await.unwrap();
    assert_eq!(status().await["paused"], false);

    // Logs of the previous (crashed) run.
    // The kubelet can briefly lack the previous run's logs while the container restarts.
    eventually("previous logs", || async {
        let (ch, logs) = channel();
        streams::stream_logs("demo".into(), "broken".into(), None, None, Some(true), ch, state()).await.unwrap();
        wait_for(&logs, "previous logs end", |m| m.iter().any(|m| m["type"] == "end")).await;
        logs.lock().unwrap().iter().any(|m| m["data"] == "boom")
    })
    .await;

    // Logs of every replica, tagged with their pod.
    let (ch, merged) = channel();
    let id = streams::stream_workload_logs("deployments".into(), "demo".into(), "chatty".into(), Some(10), ch, state()).await.unwrap();
    wait_for(&merged, "lines from both replicas", |m| {
        m.iter().filter_map(|m| m["source"].as_str()).collect::<std::collections::BTreeSet<_>>().len() == 2
    })
    .await;
    for m in merged.lock().unwrap().iter().filter(|m| m["type"] == "data") {
        assert_eq!(m["data"].as_str().unwrap(), format!("hello from {}", m["source"].as_str().unwrap()));
    }
    resources::stop_stream(id, state());

    // Events of one object.
    let pods: kube::Api<k8s_openapi::api::core::v1::Pod> = kube::Api::namespaced(state().connection().await.unwrap().client, "demo");
    let uid = pods.get("broken").await.unwrap().metadata.uid.unwrap();
    let events = serde_json::to_value(workloads::object_events(Some("demo".into()), uid, state()).await.unwrap()).unwrap();
    assert!(events.as_array().unwrap().iter().any(|e| e["type"] == "Warning" && e["reason"] == "BackOff"), "{events}");
}

/// A fake Anthropic Messages API: records the request and streams a canned answer in
/// which a fallback model takes over after the first words.
async fn fake_anthropic() -> (String, Arc<Mutex<String>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let seen: Arc<Mutex<String>> = Arc::default();
    let record = seen.clone();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buf = vec![0u8; 65536];
        // Read headers, then as many body bytes as Content-Length says.
        loop {
            let n = socket.read(&mut buf).await.unwrap();
            request.extend_from_slice(&buf[..n]);
            let text = String::from_utf8_lossy(&request).to_string();
            if let Some(head_end) = text.find("\r\n\r\n") {
                let length = text[..head_end].lines().find_map(|l| l.to_lowercase().strip_prefix("content-length: ").map(|v| v.trim().parse::<usize>().unwrap())).unwrap_or(0);
                if request.len() >= head_end + 4 + length {
                    break;
                }
            }
        }
        *record.lock().unwrap() = String::from_utf8_lossy(&request).to_string();
        let events = [
            r#"{"type":"message_start","message":{"model":"claude-opus-5-5"}}"#,
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial from the first model"}}"#,
            r#"{"type":"content_block_start","index":1,"content_block":{"type":"fallback","from":{"model":"claude-opus-5-5"},"to":{"model":"claude-opus-4-8"}}}"#,
            r#"{"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"**Root cause:** the container "}}"#,
            r#"{"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"exits with code 1."}}"#,
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"}}"#,
            r#"{"type":"message_stop"}"#,
        ];
        let body: String = events.iter().map(|e| format!("event: x\ndata: {e}\n\n")).collect();
        let response = format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
        socket.write_all(response.as_bytes()).await.unwrap();
    });
    (url, seen)
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a disposable cluster, see module docs"]
async fn explain_with_claude_against_real_cluster() {
    let context = test_context();
    let (url, seen) = fake_anthropic().await;
    let app = mock_app_with(Sessions::with_ai_endpoint(url, "sk-ant-test-key".into()));
    let state = || Session::of(&app, "main");
    cluster::connect(context, state()).await.unwrap();

    let (ch, inbox) = channel();
    ai::ai_explain("pods".into(), Some("demo".into()), "limited".into(), ch, state()).await.unwrap();
    wait_for(&inbox, "done", |m| m.iter().any(|m| m["type"] == "done" || m["type"] == "error")).await;
    let messages = inbox.lock().unwrap().clone();
    let done = messages.iter().find(|m| m["type"] == "done").unwrap_or_else(|| panic!("{messages:?}"));
    assert_eq!(done["model"], "claude-opus-4-8");
    assert_eq!(done["refused"], false);
    // Text after the fallback restart is what the UI keeps.
    let restart = messages.iter().position(|m| m["type"] == "restart").expect("restart on fallback");
    let kept: String = messages[restart..].iter().filter(|m| m["type"] == "text").map(|m| m["text"].as_str().unwrap()).collect();
    assert_eq!(kept, "**Root cause:** the container exits with code 1.");

    let request = seen.lock().unwrap().clone();
    let lower = request.to_lowercase();
    assert!(lower.contains("x-api-key: sk-ant-test-key"), "{request}");
    assert!(lower.contains("anthropic-version: 2026-10-21"));
    assert!(lower.contains("anthropic-beta: server-side-fallback-2026-07-01"));
    let body: Value = serde_json::from_str(&request[request.find("\r\n\r\n").unwrap() + 4..]).unwrap();
    assert_eq!(body["model"], "claude-opus-5-5");
    assert_eq!(body["fallbacks"], "default");
    assert_eq!(body["stream"], true);
    let prompt = body["messages"][0]["content"].as_str().unwrap();
    assert!(prompt.contains("API_TOKEN") && prompt.contains("<redacted>"), "env names stay, values go");
    assert!(!request.contains("do-not-send-this"), "secret env value leaked");
    assert!(prompt.contains("## Events"));

    // Secrets are never sent.
    let (ch, _) = channel();
    let refused = ai::ai_explain("secrets".into(), Some("demo".into()), "anything".into(), ch, state()).await.unwrap_err();
    assert!(refused.contains("never sends Secrets"));
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a disposable cluster, see module docs"]
async fn diagnostics_against_real_cluster() {
    let context = test_context();
    let app = mock_app();
    let state = || Session::of(&app, "main");
    cluster::connect(context, state()).await.unwrap();

    // Problems: crash loops, OOM kills and bad images, worst first, only from the selection.
    let problems = || async { serde_json::to_value(diagnostics::cluster_problems(vec!["demo".into()], state()).await.unwrap()).unwrap() };
    eventually("problems", || async {
        let p = problems().await;
        let has = |name: &str, reason: &str| p.as_array().unwrap().iter().any(|x| x["name"].as_str().unwrap().starts_with(name) && x["reason"] == reason);
        // A crash loop shows as CrashLoopBackOff while waiting and as the exit reason between restarts.
        (has("broken", "CrashLoopBackOff") || has("broken", "Error")) && has("bad-image-", "ImagePullBackOff")
            && p.as_array().unwrap().iter().any(|x| x["name"] == "oom" && (x["reason"] == "OOMKilled" || x["message"].as_str().unwrap().contains("OOMKilled")))
    })
    .await;
    let p = problems().await;
    assert!(p.as_array().unwrap().iter().all(|x| x["namespace"] == "demo" || x["kindKey"] == "nodes"));
    assert_eq!(p[0]["severity"], "critical", "critical first: {p}");
    assert!(!p.as_array().unwrap().iter().any(|x| x["name"].as_str().unwrap().starts_with("web-")), "healthy pods are not problems");

    // Relations.
    let related = |kind: &str, ns: Option<&str>, name: &str| {
        let (kind, ns, name) = (kind.to_owned(), ns.map(str::to_owned), name.to_owned());
        let s = state();
        async move { serde_json::to_value(diagnostics::related(kind, ns, name, s).await.unwrap()).unwrap() }
    };
    let group = |groups: &Value, relation: &str| groups.as_array().unwrap().iter().find(|g| g["relation"] == relation).map(|g| g["items"].clone()).unwrap_or(Value::Null);
    let pods: kube::Api<k8s_openapi::api::core::v1::Pod> = kube::Api::namespaced(state().connection().await.unwrap().client, "demo");
    let web_pod = pods.list(&kube::api::ListParams::default().labels("app=web")).await.unwrap().items[0].clone();
    let g = related("pods", Some("demo"), web_pod.metadata.name.as_deref().unwrap()).await;
    assert_eq!(group(&g, "Owned by")[0]["name"], "web", "{g}");
    assert_eq!(group(&g, "Exposed by")[0]["name"], "web");
    assert_eq!(group(&g, "Runs on")[0]["kindKey"], "nodes");
    // chatty is only read by other tests; web's pods get deleted and replaced by them.
    let g = related("deployments", Some("demo"), "chatty").await;
    assert_eq!(group(&g, "Pods").as_array().unwrap().len(), 2, "{g}");
    let g = related("services", Some("demo"), "web").await;
    assert!(group(&g, "Routes to").as_array().unwrap().len() >= 3, "{g}");

    // Node summary, cordon, drain. An earlier failed run may have left the worker cordoned.
    let worker = "kubedeck-test-worker".to_owned();
    nodes::cordon(worker.clone(), false, state()).await.unwrap();
    eventually("drain-me running on the worker", || async {
        pods.list(&kube::api::ListParams::default().labels("app=drain-me")).await.unwrap().items.iter().any(|p| {
            p.metadata.deletion_timestamp.is_none() && p.status.as_ref().and_then(|s| s.phase.as_deref()) == Some("Running")
        })
    })
    .await;
    let summary = serde_json::to_value(nodes::node_summary(worker.clone(), state()).await.unwrap()).unwrap();
    assert!(summary["cpuAllocatableMillis"].as_f64().unwrap() > 0.0 && summary["pods"].as_u64().unwrap() > 0, "{summary}");
    assert!(summary["conditions"].as_array().unwrap().iter().all(|c| c["bad"] == false), "{summary}");
    let g = related("nodes", None, &worker).await;
    assert!(group(&g, "Pods").as_array().unwrap().iter().any(|p| p["name"].as_str().unwrap().starts_with("drain-me-")));

    let dry = serde_json::to_value(nodes::drain(worker.clone(), None, true, state()).await.unwrap()).unwrap();
    assert!(dry["evicted"].as_array().unwrap().iter().any(|p| p.as_str().unwrap().starts_with("demo/drain-me-")), "{dry}");
    assert!(dry["skipped"].as_array().unwrap().iter().any(|s| s[1].as_str().unwrap().contains("DaemonSet")), "{dry}");
    assert_eq!(serde_json::to_value(nodes::node_summary(worker.clone(), state()).await.unwrap()).unwrap()["unschedulable"], false, "dry run must not cordon");

    let before = pods.list(&kube::api::ListParams::default().labels("app=drain-me")).await.unwrap().items.into_iter().find(|p| p.metadata.deletion_timestamp.is_none()).unwrap().metadata.uid;
    let real = serde_json::to_value(nodes::drain(worker.clone(), Some("app=drain-me".into()), false, state()).await.unwrap()).unwrap();
    assert_eq!(real["evicted"].as_array().unwrap().len(), 1, "{real}");
    assert_eq!(serde_json::to_value(nodes::node_summary(worker.clone(), state()).await.unwrap()).unwrap()["unschedulable"], true);
    eventually("evicted pod replaced", || async {
        pods.list(&kube::api::ListParams::default().labels("app=drain-me")).await.unwrap().items.iter().any(|p| p.metadata.uid != before)
    })
    .await;
    nodes::cordon(worker.clone(), false, state()).await.unwrap();
    assert_eq!(serde_json::to_value(nodes::node_summary(worker, state()).await.unwrap()).unwrap()["unschedulable"], false);

    // Node history from Prometheus.
    let history = serde_json::to_value(pod_insights::node_history("kubedeck-test-control-plane".into(), 15, state()).await.unwrap()).unwrap();
    assert!(!history["cpu"][0]["points"].as_array().unwrap().is_empty(), "{history}");
    assert!(!history["memory"][0]["points"].as_array().unwrap().is_empty());
}

fn crate_is_production(context: &str) -> bool {
    let lower = context.to_lowercase();
    ["prd", "prod", "production"].iter().any(|p| lower.contains(p))
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a disposable cluster, see module docs"]
async fn read_only_secrets_and_login_against_real_cluster() {
    let context = test_context();
    let app = mock_app();
    let state = || Session::of(&app, "readonly");
    cluster::connect(context, state()).await.unwrap();

    // Read-only: every write is refused before it reaches the cluster; reads still work.
    cluster::set_read_only(true, state());
    let refused = |r: Result<(), String>| assert_eq!(r.unwrap_err(), crate::state::READ_ONLY);
    refused(resources::delete_resource("pods".into(), opt("demo"), "ticker".into(), state()).await);
    refused(workloads::scale("deployments".into(), "demo".into(), "web".into(), 0, state()).await);
    refused(workloads::rollout_restart("deployments".into(), "demo".into(), "web".into(), state()).await);
    refused(nodes::cordon("kubedeck-test-worker".into(), true, state()).await);
    refused(nodes::drain("kubedeck-test-worker".into(), None, false, state()).await.map(|_| ()));
    refused(helm::helm_uninstall("demo".into(), "hello".into(), state()).await.map(|_| ()));
    let yaml = resources::get_yaml("configmaps".into(), opt("demo"), "app-config".into(), None, state()).await.unwrap();
    refused(resources::replace_yaml("configmaps".into(), opt("demo"), "app-config".into(), yaml, state()).await.map(|_| ()));
    let (ch, _) = channel();
    refused(streams::exec_start("demo".into(), "ticker".into(), None, 80, 24, ch, state()).await.map(|_| ()));
    assert!(nodes::drain("kubedeck-test-worker".into(), None, true, state()).await.is_ok(), "a dry run only reads");
    let pods = resources::get_yaml("pods".into(), opt("demo"), "ticker".into(), None, state()).await;
    assert!(pods.is_ok(), "reads work in read-only mode");
    // The lock belongs to this window only.
    assert!(!Session::of(&app, "other").read_only.load(std::sync::atomic::Ordering::Relaxed));
    cluster::set_read_only(false, state());

    // Secrets: masked unless revealed, values one by one.
    let masked = resources::get_yaml("secrets".into(), opt("demo"), "app-secret".into(), None, state()).await.unwrap();
    assert!(masked.contains(crate::secrets::MASK) && !masked.contains("aHVudGVyMg=="), "{masked}");
    let shown = resources::get_yaml("secrets".into(), opt("demo"), "app-secret".into(), Some(true), state()).await.unwrap();
    assert!(shown.contains("aHVudGVyMg=="), "{shown}");
    // Saving the masked YAML by mistake fails instead of wiping the values.
    assert!(resources::replace_yaml("secrets".into(), opt("demo"), "app-secret".into(), masked, state()).await.is_err());
    let keys = serde_json::to_value(crate::secrets::secret_keys("demo".into(), "app-secret".into(), state()).await.unwrap()).unwrap();
    assert_eq!(keys, serde_json::json!([{ "key": "password", "bytes": 7 }, { "key": "user", "bytes": 5 }]));
    let value = serde_json::to_value(crate::secrets::secret_value("demo".into(), "app-secret".into(), "password".into(), state()).await.unwrap()).unwrap();
    assert_eq!(value, serde_json::json!({ "text": "hunter2", "base64": "aHVudGVyMg==" }));

    // Login command: output on success, the error and output on failure.
    assert_eq!(cluster::run_login("echo renewed".into()).await.unwrap(), "renewed");
    let failed = cluster::run_login("echo nope >&2; exit 3".into()).await.unwrap_err();
    assert!(failed.contains("nope") && failed.contains('3'), "{failed}");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a disposable cluster, see module docs"]
async fn create_and_rightsizing_against_real_cluster() {
    let context = test_context();
    let app = mock_app();
    let state = || Session::of(&app, "create");
    cluster::connect(context, state()).await.unwrap();

    // Several documents; the ConfigMap without a namespace lands in the default one given.
    let name = format!("created-{}", std::process::id());
    let yaml = format!("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {name}\ndata:\n  a: \"1\"\n---\n---\napiVersion: v1\nkind: Namespace\nmetadata:\n  name: {name}\n");
    let dry = resources::create_resources(yaml.clone(), opt("demo"), true, state()).await.unwrap();
    assert_eq!(dry, vec![format!("ConfigMap demo/{name}"), format!("Namespace {name}")]);
    assert!(resources::get_yaml("configmaps".into(), opt("demo"), name.clone(), None, state()).await.is_err(), "a dry run saves nothing");
    let created = resources::create_resources(yaml.clone(), opt("demo"), false, state()).await.unwrap();
    assert_eq!(created, dry);
    // Creating again fails on the first document, saying which one.
    let again = resources::create_resources(yaml, opt("demo"), false, state()).await.unwrap_err();
    assert!(again.starts_with("Document 1 (ConfigMap"), "{again}");
    let bad = resources::create_resources("apiVersion: v1\nkind: Nope\nmetadata:\n  name: x\n".into(), opt("demo"), true, state()).await.unwrap_err();
    assert!(bad.contains("Document 1 (Nope)"), "{bad}");
    resources::delete_resource("configmaps".into(), opt("demo"), name.clone(), state()).await.unwrap();
    resources::delete_resource("namespaces".into(), None, name, state()).await.unwrap();
    // Read-only refuses real creation, not dry runs.
    cluster::set_read_only(true, state());
    assert!(resources::create_resources("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ro\n".into(), opt("demo"), true, state()).await.is_ok());
    assert_eq!(resources::create_resources("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ro\n".into(), opt("demo"), false, state()).await.unwrap_err(), crate::state::READ_ONLY);
    cluster::set_read_only(false, state());

    // Rightsizing: requests from the pod spec, usage from Prometheus (set up by e2e/setup.sh).
    let report = serde_json::to_value(crate::rightsizing::rightsizing(vec!["demo".into()], state()).await.unwrap()).unwrap();
    assert!(report["source"].as_str().unwrap().starts_with("Prometheus"), "{}", report["source"]);
    let rows = report["rows"].as_array().unwrap();
    let limited = rows.iter().find(|r| r["workload"] == "limited").expect("limited pod");
    assert_eq!(limited["kindKey"], "pods");
    assert_eq!(limited["cpuRequestMillis"], 10.0);
    assert_eq!(limited["cpuLimitMillis"], 50.0);
    assert!(limited["memoryUsageBytes"].as_f64().unwrap() > 0.0, "{limited}");
    let web = rows.iter().find(|r| r["workload"] == "web" && r["kindKey"] == "deployments").expect("web deployment");
    assert!(web["pods"].as_u64().unwrap() >= 1);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a disposable cluster, see module docs"]
async fn storage_against_real_cluster() {
    let context = test_context();
    let app = mock_app();
    let state = || Session::of(&app, "storage");
    cluster::connect(context, state()).await.unwrap();

    // The new kinds resolve to the right API resources.
    let sc = resources::get_yaml("storageclasses".into(), None, "standard".into(), None, state()).await.unwrap();
    assert!(sc.contains("rancher.io/local-path"), "{sc}");
    let pvc = resources::get_yaml("persistentvolumeclaims".into(), opt("demo"), "data".into(), None, state()).await.unwrap();
    let pv_name = pvc.lines().find_map(|l| l.trim().strip_prefix("volumeName: ")).expect("bound claim").to_owned();
    assert!(resources::get_yaml("persistentvolumes".into(), None, pv_name.clone(), None, state()).await.is_ok());

    // Usage from Prometheus, and from the kubelets directly when there is no Prometheus.
    let usage = serde_json::to_value(crate::storage::volume_usage(vec!["demo".into()], state()).await.unwrap()).unwrap();
    assert!(usage["source"].as_str().unwrap().starts_with("Prometheus"), "{usage}");
    let data = usage["volumes"].as_array().unwrap().iter().find(|v| v["claim"] == "data").unwrap_or_else(|| panic!("{usage}")).clone();
    assert!(data["capacityBytes"].as_f64().unwrap() > 0.0 && data["usedBytes"].as_f64().unwrap() > 0.0, "{data}");
    let client = state().connection().await.unwrap().client;
    let direct = crate::storage::from_kubelets(&client, &["demo".into()]).await;
    assert!(direct.iter().any(|v| v.claim == "data" && v.used_bytes > 0.0), "{direct:?}");
    let history = serde_json::to_value(crate::storage::volume_history("demo".into(), "data".into(), 60, state()).await.unwrap()).unwrap();
    assert!(!history["used"][0]["points"].as_array().unwrap().is_empty(), "{history}");

    // Expansion: kind's StorageClass does not allow it, and volumes never shrink.
    let info = serde_json::to_value(crate::storage::volume_expand_info("demo".into(), "data".into(), state()).await.unwrap()).unwrap();
    assert_eq!(info, serde_json::json!({ "requested": "1Gi", "storageClass": "standard", "expandable": false }));
    let refused = crate::storage::expand_volume("demo".into(), "data".into(), "2Gi".into(), state()).await.unwrap_err();
    assert!(refused.contains("does not allow volume expansion"), "{refused}");
    let shrink = crate::storage::expand_volume("demo".into(), "data".into(), "512Mi".into(), state()).await.unwrap_err();
    assert!(shrink.contains("can only grow"), "{shrink}");
    let nonsense = crate::storage::expand_volume("demo".into(), "data".into(), "big".into(), state()).await.unwrap_err();
    assert!(nonsense.contains("is not a size"), "{nonsense}");
    cluster::set_read_only(true, state());
    assert_eq!(crate::storage::expand_volume("demo".into(), "data".into(), "2Gi".into(), state()).await.unwrap_err(), crate::state::READ_ONLY);
    cluster::set_read_only(false, state());

    // Related: claim ↔ pod, volume and class.
    let rel = serde_json::to_value(diagnostics::related("persistentvolumeclaims".into(), opt("demo"), "data".into(), state()).await.unwrap()).unwrap();
    let group = |rel: &Value, name: &str| rel.as_array().unwrap().iter().find(|g| g["relation"] == name).map(|g| g["items"].clone());
    assert_eq!(group(&rel, "Used by").unwrap()[0]["name"], "writer");
    assert_eq!(group(&rel, "Bound to").unwrap()[0]["name"], pv_name.as_str());
    assert_eq!(group(&rel, "Storage class").unwrap()[0]["name"], "standard");
    let rel = serde_json::to_value(diagnostics::related("persistentvolumes".into(), None, pv_name, state()).await.unwrap()).unwrap();
    assert_eq!(group(&rel, "Claimed by").unwrap()[0]["name"], "data");
    let rel = serde_json::to_value(diagnostics::related("storageclasses".into(), None, "standard".into(), state()).await.unwrap()).unwrap();
    assert!(group(&rel, "Claims").unwrap().as_array().unwrap().iter().any(|i| i["name"] == "data"));
}
