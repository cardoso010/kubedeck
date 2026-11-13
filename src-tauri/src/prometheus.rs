//! The cluster's Prometheus, reached through the API server's service proxy with the user's
//! own credentials, so it needs no port forward or extra configuration. It is found by looking
//! for the usual service names, or set with `KUBEDECK_PROMETHEUS=namespace/service:port`, once
//! per connection (`Connection::prometheus`).

use k8s_openapi::api::core::v1::Service;
use kube::api::{Api, ListParams};
use kube::Client;
use serde::Serialize;
use serde_json::Value;

use crate::state::{err, CmdResult, Session};

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PromTarget {
    namespace: String,
    service: String,
    port: String,
}

impl PromTarget {
    fn proxy_path(&self, api: &str) -> String {
        format!("/api/v1/namespaces/{}/services/{}:{}/proxy{api}", self.namespace, self.service, self.port)
    }

    pub fn label(&self) -> String {
        format!("{}/{}:{}", self.namespace, self.service, self.port)
    }
}

/// Service names that usually front Prometheus (community chart, operator, kube-prometheus-stack).
const KNOWN_NAMES: &[&str] = &["prometheus-server", "prometheus-operated", "prometheus-k8s", "kube-prometheus-stack-prometheus", "prometheus"];
const NOT_PROMETHEUS: &[&str] = &["alertmanager", "node-exporter", "pushgateway", "operator", "kube-state", "adapter", "blackbox", "thanos-sidecar"];

/// Candidates in order of likelihood: known names first, then anything that looks like one.
fn candidates(services: &[Service]) -> Vec<PromTarget> {
    let mut found: Vec<(usize, PromTarget)> = services
        .iter()
        .filter_map(|svc| {
            let name = svc.metadata.name.clone()?;
            let rank = KNOWN_NAMES.iter().position(|k| *k == name).or_else(|| {
                (name.contains("prometheus") && !NOT_PROMETHEUS.iter().any(|n| name.contains(n))).then_some(KNOWN_NAMES.len())
            })?;
            let ports = svc.spec.as_ref()?.ports.clone().unwrap_or_default();
            let port = ports
                .iter()
                .find(|p| matches!(p.name.as_deref(), Some("http-web" | "web" | "http")))
                .or_else(|| ports.iter().find(|p| p.port == 9090))
                .or_else(|| ports.first())?;
            Some((rank, PromTarget { namespace: svc.metadata.namespace.clone()?, service: name, port: port.port.to_string() }))
        })
        .collect();
    found.sort_by_key(|(rank, t)| (*rank, t.namespace.clone()));
    found.into_iter().map(|(_, t)| t).collect()
}

/// A query that takes longer is not worth waiting for in a UI.
const PROM_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// How long a candidate service gets to answer `vector(1)` during detection.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

pub(crate) async fn prom_get(client: &Client, target: &PromTarget, api: &str, params: &[(&str, String)]) -> CmdResult<Value> {
    let query = form_urlencoded::Serializer::new(String::new()).extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str()))).finish();
    let request = http::Request::get(format!("{}?{query}", target.proxy_path(api))).body(Vec::new()).map_err(err)?;
    let text = tokio::time::timeout(PROM_TIMEOUT, client.request_text(request))
        .await
        .map_err(|_| format!("Prometheus did not answer within {}s", PROM_TIMEOUT.as_secs()))?
        .map_err(err)?;
    let json: Value = serde_json::from_str(&text).map_err(|_| "Prometheus returned something that is not JSON".to_owned())?;
    if json["status"] != "success" {
        return Err(json["error"].as_str().unwrap_or("Prometheus query failed").into());
    }
    Ok(json["data"].clone())
}

async fn detect(client: &Client) -> Option<PromTarget> {
    let configured = std::env::var("KUBEDECK_PROMETHEUS").ok().and_then(|v| {
        let (namespace, rest) = v.split_once('/')?;
        let (service, port) = rest.split_once(':').unwrap_or((rest, "9090"));
        Some(PromTarget { namespace: namespace.into(), service: service.into(), port: port.into() })
    });
    let list = match configured {
        Some(t) => vec![t],
        // Listing services cluster-wide may be forbidden; then there is no history.
        None => candidates(&Api::<Service>::all(client.clone()).list(&ListParams::default()).await.ok()?.items),
    };
    // Probe every candidate at once, briefly, and keep the best-ranked one that answers: a
    // candidate without endpoints would otherwise hold up detection, and every view that
    // waits for it.
    let answers = futures::future::join_all(list.iter().map(|target| async move {
        tokio::time::timeout(PROBE_TIMEOUT, prom_get(client, target, "/api/v1/query", &[("query", "vector(1)".into())])).await.is_ok_and(|r| r.is_ok())
    }))
    .await;
    list.into_iter().zip(answers).find_map(|(target, ok)| ok.then_some(target))
}

pub(crate) async fn prometheus(state: &Session) -> CmdResult<(Client, Option<PromTarget>)> {
    let conn = state.connection().await?;
    let target = conn.prometheus.get_or_init(|| detect(&conn.client)).await.clone();
    Ok((conn.client, target))
}

/// The Prometheus this cluster's history comes from, as "namespace/service:port".
#[tauri::command]
pub async fn prometheus_target(state: Session) -> CmdResult<Option<String>> {
    Ok(prometheus(&state).await?.1.map(|t| t.label()))
}

#[derive(Serialize)]
pub struct Series {
    /// Container name, or what the series measures ("receive", "transmit").
    pub(crate) name: String,
    /// [unix seconds, value] pairs.
    points: Vec<(f64, f64)>,
}

/// Reads a Prometheus matrix result.
pub(crate) fn series(data: &Value) -> Vec<Series> {
    let mut out: Vec<Series> = data["result"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|r| Series {
            name: r["metric"]["container"].as_str().unwrap_or("pod").to_owned(),
            points: r["values"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|p| Some((p[0].as_f64()?, p[1].as_str()?.parse::<f64>().ok().filter(|v| v.is_finite())?)))
                .collect(),
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn service(namespace: &str, name: &str, ports: Value) -> Service {
        serde_json::from_value(json!({ "metadata": { "name": name, "namespace": namespace }, "spec": { "ports": ports } })).unwrap()
    }

    #[test]
    fn finds_prometheus_services_in_order_of_likelihood() {
        let services = [
            service("monitoring", "kube-prometheus-stack-alertmanager", json!([{ "name": "http-web", "port": 9093 }])),
            service("monitoring", "my-prometheus", json!([{ "port": 9090 }])),
            service("monitoring", "prometheus-operated", json!([{ "name": "web", "port": 9090 }])),
            service("default", "kubernetes", json!([{ "port": 443 }])),
        ];
        let found = candidates(&services);
        assert_eq!(found.len(), 2, "{found:?}");
        assert_eq!(found[0], PromTarget { namespace: "monitoring".into(), service: "prometheus-operated".into(), port: "9090".into() });
        assert_eq!(found[1].service, "my-prometheus");
        assert_eq!(found[0].proxy_path("/api/v1/query"), "/api/v1/namespaces/monitoring/services/prometheus-operated:9090/proxy/api/v1/query");
    }

    #[test]
    fn reads_matrix_results() {
        let data = json!({ "result": [
            { "metric": { "container": "web" }, "values": [[100.0, "0.5"], [115.0, "NaN"], [130.0, "0.25"]] },
            { "metric": {}, "values": [[100.0, "1"]] }
        ]});
        let s = series(&data);
        assert_eq!(s[0].name, "pod");
        assert_eq!(s[1].name, "web");
        assert_eq!(s[1].points, vec![(100.0, 0.5), (130.0, 0.25)], "NaN samples are dropped");
    }
}
