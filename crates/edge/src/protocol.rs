use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chrono::{DateTime, SecondsFormat, Utc};
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use wb_buddy_core::{ActivityState, DisplayState, StatusSnapshot};

pub const SIGNING_DOMAIN_V1: &[u8] = b"workbuddy-buddy/edge-report/v1\0";
pub const PROTOCOL_VERSION: u8 = 1;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind")]
pub enum EdgeEvent {
    #[serde(rename = "state_transition")]
    StateTransition {
        sequence: u64,
        observed_at: String,
        display_state: String,
        activity_state: String,
        pet_id: String,
    },
    #[serde(rename = "heartbeat")]
    Heartbeat { sequence: u64, observed_at: String },
}

impl EdgeEvent {
    pub fn sequence(&self) -> u64 {
        match self {
            Self::StateTransition { sequence, .. } | Self::Heartbeat { sequence, .. } => *sequence,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct EdgeReportEnvelope {
    pub protocol_version: u8,
    pub instance_id: String,
    pub key_id: String,
    pub boot_id: String,
    pub previous_boot_id: Option<String>,
    pub first_sequence: u64,
    pub events: Vec<EdgeEvent>,
    pub sent_at: String,
    pub client_version: String,
    pub signature: String,
}

#[derive(Clone, Copy, Debug)]
pub struct EdgeEnvelopeContext<'a> {
    pub instance_id: &'a str,
    pub key_id: &'a str,
    pub boot_id: &'a str,
    pub previous_boot_id: Option<&'a str>,
    pub client_version: &'a str,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct EdgeReportAck {
    pub current_protocol: u64,
    pub min_supported_protocol: u64,
    pub instance_id: String,
    pub boot_id: String,
    pub accepted_through_sequence: u64,
    pub server_received_at: String,
    pub lease_expires_at: String,
}

pub fn state_event(
    sequence: u64,
    snapshot: StatusSnapshot,
    pet_id: &str,
    now: DateTime<Utc>,
) -> EdgeEvent {
    EdgeEvent::StateTransition {
        sequence,
        observed_at: timestamp(now),
        display_state: display_state(snapshot.display_state).to_owned(),
        activity_state: activity_state(snapshot.activity_state).to_owned(),
        pet_id: pet_id.to_owned(),
    }
}

pub fn heartbeat_event(sequence: u64, now: DateTime<Utc>) -> EdgeEvent {
    EdgeEvent::Heartbeat {
        sequence,
        observed_at: timestamp(now),
    }
}

pub fn sign_envelope(
    context: EdgeEnvelopeContext<'_>,
    events: Vec<EdgeEvent>,
    signing_key: &SigningKey,
    now: DateTime<Utc>,
) -> EdgeReportEnvelope {
    let first_sequence = events
        .first()
        .map(EdgeEvent::sequence)
        .expect("an Edge envelope requires at least one event");
    let unsigned = serde_json::json!({
        "protocol_version": PROTOCOL_VERSION,
        "instance_id": context.instance_id,
        "key_id": context.key_id,
        "boot_id": context.boot_id,
        "previous_boot_id": context.previous_boot_id,
        "first_sequence": first_sequence,
        "events": events,
        "sent_at": timestamp(now),
        "client_version": context.client_version,
    });
    let signing_payload = signing_payload(&unsigned);
    let signature = BASE64_STANDARD.encode(signing_key.sign(&signing_payload).to_bytes());
    let mut envelope = unsigned;
    envelope
        .as_object_mut()
        .expect("Edge envelope is an object")
        .insert("signature".to_owned(), Value::String(signature));
    serde_json::from_value(envelope).expect("internally built Edge envelope is valid")
}

pub fn signing_payload(unsigned_envelope: &Value) -> Vec<u8> {
    let mut payload = Vec::with_capacity(SIGNING_DOMAIN_V1.len() + 512);
    payload.extend_from_slice(SIGNING_DOMAIN_V1);
    payload.extend_from_slice(canonical_json(unsigned_envelope).as_bytes());
    payload
}

pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => {
            serde_json::to_string(value).expect("JSON string encoding cannot fail")
        }
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("JSON key encoding cannot fail"),
                        canonical_json(&values[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn display_state(state: DisplayState) -> &'static str {
    match state {
        DisplayState::Idle => "idle",
        DisplayState::Working => "working",
        DisplayState::Waiting => "waiting",
        DisplayState::Done => "done",
        DisplayState::Failed => "failed",
    }
}

fn activity_state(state: ActivityState) -> &'static str {
    match state {
        ActivityState::Unknown => "unknown",
        ActivityState::Active => "active",
        ActivityState::EligibleIdle => "eligible_idle",
        ActivityState::Waiting => "waiting",
        ActivityState::Failed => "failed",
    }
}

fn timestamp(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::VerifyingKey;
    use sha2::{Digest, Sha256};

    #[test]
    fn rust_matches_the_frozen_typescript_signing_vector() {
        let vector: Value = serde_json::from_str(include_str!(
            "../../../contracts/fixtures/edge-report-signature.v1.golden.json"
        ))
        .unwrap();
        let unsigned = {
            let mut envelope = vector["envelope"].clone();
            envelope.as_object_mut().unwrap().remove("signature");
            envelope
        };
        assert_eq!(
            canonical_json(&unsigned),
            vector["canonical_unsigned_json"].as_str().unwrap()
        );
        let payload = signing_payload(&unsigned);
        assert_eq!(
            hex::encode(Sha256::digest(&payload)),
            vector["signing_payload_sha256_hex"].as_str().unwrap()
        );

        let seed = hex_to_array::<32>(vector["private_key_seed_hex"].as_str().unwrap());
        let signing_key = SigningKey::from_bytes(&seed);
        let signature = BASE64_STANDARD.encode(signing_key.sign(&payload).to_bytes());
        assert_eq!(signature, vector["envelope"]["signature"].as_str().unwrap());
        assert_eq!(
            signing_key.verifying_key().to_bytes(),
            hex_to_array::<32>(vector["public_key_raw_hex"].as_str().unwrap())
        );
        let _strict_key: VerifyingKey = signing_key.verifying_key();
    }

    #[test]
    fn canonical_json_sorts_objects_but_preserves_arrays() {
        let value = serde_json::json!({"z": 1, "a": [{"b": true, "a": null}, "fish"]});
        assert_eq!(
            canonical_json(&value),
            r#"{"a":[{"a":null,"b":true},"fish"],"z":1}"#
        );
    }

    fn hex_to_array<const N: usize>(value: &str) -> [u8; N] {
        assert_eq!(value.len(), N * 2);
        let mut output = [0_u8; N];
        for (index, byte) in output.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).unwrap();
        }
        output
    }
}
