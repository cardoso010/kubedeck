//! End-to-end test of the backend commands against a real, disposable cluster.
//!
//! Needs a cluster with the `demo` namespace from README.md ("Testing"), then:
//!   KUBECONFIG=../.kind-kubeconfig KUBEDECK_E2E_CONTEXT=kind-kubedeck-test cargo test -- --ignored
//! Never point it at a shared cluster: it edits a ConfigMap and deletes a pod.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::Manager;

use crate::{cluster, resources, state::AppState, streams};

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

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a disposable cluster, see module docs"]
async fn backend_against_real_cluster() {
    let context = std::env::var("KUBEDECK_E2E_CONTEXT").expect("set KUBEDECK_E2E_CONTEXT");
    assert!(!crate_is_production(&context), "refusing to run against {context}");

    let app = tauri::test::mock_builder()
        .manage(AppState::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
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
    assert!(yaml.contains("LOG_LEVEL: debug") && !yaml.contains("managedFields"), "{yaml}");
    let edited = yaml.replace("LOG_LEVEL: debug", "LOG_LEVEL: info");
    let saved = resources::replace_yaml("configmaps".into(), opt("demo"), "app-config".into(), edited.clone(), state()).await.unwrap();
    assert!(saved.contains("LOG_LEVEL: info"));
    let stale = resources::replace_yaml("configmaps".into(), opt("demo"), "app-config".into(), edited, state()).await;
    assert!(stale.unwrap_err().contains("modified"), "stale resourceVersion must be rejected");
    let renamed = resources::replace_yaml("configmaps".into(), opt("demo"), "app-config".into(), saved.replace("name: app-config", "name: other"), state()).await;
    assert!(renamed.is_err());
    // Put it back so the test can run again.
    resources::replace_yaml("configmaps".into(), opt("demo"), "app-config".into(), saved.replace("LOG_LEVEL: info", "LOG_LEVEL: debug"), state()).await.unwrap();

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
    streams::exec_input(exec_id, "echo kubedeck-$((40+2)); stty size\r".into(), state()).unwrap();
    let output = |m: &[Value]| m.iter().filter(|m| m["type"] == "data").map(|m| m["data"].as_str().unwrap().to_owned()).collect::<String>();
    wait_for(&term, "exec output", |m| output(m).contains("kubedeck-42")).await;
    wait_for(&term, "tty resize", |m| output(m).contains("40 120")).await;
    streams::exec_input(exec_id, "exit\r".into(), state()).unwrap();
    wait_for(&term, "exec end", |m| m.iter().any(|m| m["type"] == "end")).await;
    resources::stop_stream(exec_id, state());
}

fn crate_is_production(context: &str) -> bool {
    let lower = context.to_lowercase();
    ["prd", "prod", "production"].iter().any(|p| lower.contains(p))
}
