//! Secret values stay hidden until asked for: the YAML comes masked unless revealed, and the
//! Data tab fetches one decoded value at a time.

use k8s_openapi::api::core::v1::Secret;
use kube::api::{Api, DynamicObject};
use serde::Serialize;
use serde_json::Value;

use crate::state::{kube_err, CmdResult, Session};

/// Stands in for each value of a masked Secret. Not valid base64, so a masked Secret that
/// is saved by mistake is rejected by the API server instead of wiping the values.
pub const MASK: &str = "<hidden: reveal to see or edit>";

/// Replaces every value under `data` and `stringData` with [`MASK`].
pub fn mask(obj: &mut DynamicObject) {
    for field in ["data", "stringData"] {
        if let Some(Value::Object(map)) = obj.data.get_mut(field) {
            for v in map.values_mut() {
                *v = Value::String(MASK.into());
            }
        }
    }
    // kubectl apply keeps a full copy of the object, values included, in this annotation.
    if let Some(applied) = obj.metadata.annotations.as_mut().and_then(|a| a.get_mut("kubectl.kubernetes.io/last-applied-configuration")) {
        *applied = MASK.into();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretKey {
    key: String,
    bytes: usize,
}

/// The keys of a Secret and the size of each value, without the values.
#[tauri::command]
pub async fn secret_keys(namespace: String, name: String, state: Session) -> CmdResult<Vec<SecretKey>> {
    let api: Api<Secret> = Api::namespaced(state.connection().await?.client, &namespace);
    let secret = api.get(&name).await.map_err(|e| kube_err(&e))?;
    Ok(secret.data.unwrap_or_default().into_iter().map(|(key, v)| SecretKey { key, bytes: v.0.len() }).collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretValue {
    /// The value as text, when it is UTF-8.
    text: Option<String>,
    base64: String,
}

/// One decoded value, fetched only when the user reveals it.
#[tauri::command]
pub async fn secret_value(namespace: String, name: String, key: String, state: Session) -> CmdResult<SecretValue> {
    let api: Api<Secret> = Api::namespaced(state.connection().await?.client, &namespace);
    let secret = api.get(&name).await.map_err(|e| kube_err(&e))?;
    let bytes = secret.data.unwrap_or_default().remove(&key).ok_or_else(|| format!("{name} has no key {key}"))?.0;
    // ByteString serializes as base64.
    let base64 = serde_json::to_value(k8s_openapi::ByteString(bytes.clone())).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default();
    Ok(SecretValue { text: String::from_utf8(bytes).ok(), base64 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_every_value_and_the_applied_copy() {
        let mut obj: DynamicObject = serde_json::from_value(serde_json::json!({
            "apiVersion": "v1", "kind": "Secret",
            "metadata": { "name": "s", "annotations": { "kubectl.kubernetes.io/last-applied-configuration": "{\"data\":{\"a\":\"c2VjcmV0\"}}", "keep": "me" } },
            "data": { "a": "c2VjcmV0", "b": "eA==" },
            "type": "Opaque"
        }))
        .unwrap();
        mask(&mut obj);
        let text = serde_json::to_string(&obj).unwrap();
        assert!(!text.contains("c2VjcmV0") && !text.contains("eA=="), "{text}");
        assert_eq!(obj.data["data"]["b"], MASK);
        assert_eq!(obj.metadata.annotations.unwrap()["keep"], "me");
        assert_eq!(obj.data["type"], "Opaque");
    }
}
