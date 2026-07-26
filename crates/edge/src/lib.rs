//! Signed, privacy-safe WorkBuddy Edge enrollment and reporting.
//!
//! This crate intentionally accepts only the semantic [`StatusSnapshot`] from
//! `wb-buddy-core`; raw WorkBuddy hooks, prompts, tools, paths, sessions and mail
//! data have no representation here.

mod protocol;
mod storage;

use std::path::PathBuf;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chrono::Utc;
use ed25519_dalek::SigningKey;
use getrandom::fill as random_fill;
pub use protocol::{
    canonical_json, heartbeat_event, sign_envelope, signing_payload, state_event,
    EdgeEnvelopeContext, EdgeEvent, EdgeReportAck, EdgeReportEnvelope, PROTOCOL_VERSION,
    SIGNING_DOMAIN_V1,
};
use reqwest::blocking::{Client, Response};
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
pub use storage::{JsonFileStore, KeyringSecretStore, SecretStore};
use thiserror::Error;
use url::Url;
use uuid::Uuid;
use wb_buddy_core::StatusSnapshot;

const CONFIG_FILE: &str = "edge-connection.json";
const OUTBOX_PREFIX: &str = "edge-outbox-";
const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const PAIRING_CODE_MAX_BYTES: usize = 128;
const MAX_EVENTS_PER_BOOT: u64 = 256;

pub type Result<T> = std::result::Result<T, EdgeError>;

#[derive(Debug, Error)]
pub enum EdgeError {
    #[error("Control Plane URL is invalid or not allowed")]
    InvalidControlPlaneUrl,
    #[error("pairing code is invalid")]
    InvalidPairingCode,
    #[error("the selected pet cannot be reported")]
    InvalidPet,
    #[error("device credential is unavailable")]
    CredentialUnavailable,
    #[error("this reporter was replaced by a newer pairing")]
    ConnectionSuperseded,
    #[error("Control Plane rejected the request ({status})")]
    Http { status: u16, detail: String },
    #[error("Control Plane response is invalid: {0}")]
    InvalidResponse(String),
    #[error("storage error: {0}")]
    Storage(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Network(#[from] reqwest::Error),
    #[error(transparent)]
    Keyring(#[from] keyring::v1::Error),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ConnectionConfig {
    pub control_plane_url: String,
    pub server_id: String,
    pub instance_id: String,
    pub key_id: String,
    pub logical_agent_id: String,
    pub heartbeat_interval_seconds: u64,
    pub credential_valid_until: String,
    pub last_accepted_boot_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct EnrollmentResponse {
    server_id: String,
    instance_id: String,
    key_id: String,
    logical_agent_id: String,
    heartbeat_interval_seconds: u64,
    credential_valid_until: String,
}

#[derive(Serialize)]
struct EnrollmentRequest<'a> {
    pairing_code: &'a str,
    public_key: String,
    client_version: &'a str,
}

#[derive(Clone)]
pub struct EdgeEnrollment<S: SecretStore> {
    control_plane_url: Url,
    files: JsonFileStore,
    secrets: S,
    http: Client,
}

impl<S: SecretStore> EdgeEnrollment<S> {
    pub fn new(
        control_plane_url: &str,
        data_directory: impl Into<PathBuf>,
        secrets: S,
    ) -> Result<Self> {
        Ok(Self {
            control_plane_url: validate_control_plane_url(control_plane_url)?,
            files: JsonFileStore::new(data_directory),
            secrets,
            http: Client::builder()
                .redirect(Policy::none())
                .connect_timeout(Duration::from_secs(8))
                .timeout(Duration::from_secs(20))
                .user_agent(format!("workbuddy-buddy-edge/{CLIENT_VERSION}"))
                .build()?,
        })
    }

    pub fn pair(&self, raw_pairing_code: &str) -> Result<ConnectionConfig> {
        let pairing_code = normalize_pairing_code(raw_pairing_code)?;
        let pending_secret_name =
            pending_secret_name(self.control_plane_url.as_str(), &pairing_code);
        let seed = match self.secrets.get(&pending_secret_name)? {
            Some(bytes) => bytes_to_seed(bytes)?,
            None => {
                let mut seed = [0_u8; 32];
                random_fill(&mut seed).map_err(|error| {
                    EdgeError::Storage(format!("OS randomness failed: {error}"))
                })?;
                self.secrets.set(&pending_secret_name, &seed)?;
                seed
            }
        };
        let signing_key = SigningKey::from_bytes(&seed);
        let response = self
            .http
            .post(self.endpoint("/api/v1/edge/enrollment/claim")?)
            .json(&EnrollmentRequest {
                pairing_code: &pairing_code,
                public_key: BASE64_STANDARD.encode(signing_key.verifying_key().to_bytes()),
                client_version: CLIENT_VERSION,
            })
            .send()?;
        let enrollment: EnrollmentResponse = decode_response(response)?;
        validate_enrollment_response(&enrollment)?;

        let config = ConnectionConfig {
            control_plane_url: canonical_origin(&self.control_plane_url),
            server_id: enrollment.server_id,
            instance_id: enrollment.instance_id,
            key_id: enrollment.key_id,
            logical_agent_id: enrollment.logical_agent_id,
            heartbeat_interval_seconds: enrollment.heartbeat_interval_seconds,
            credential_valid_until: enrollment.credential_valid_until,
            last_accepted_boot_id: None,
        };
        self.secrets.set(
            &device_secret_name(&config.server_id, &config.key_id),
            &seed,
        )?;
        self.files.write(CONFIG_FILE, &config)?;
        self.secrets.delete(&pending_secret_name)?;
        Ok(config)
    }

    fn endpoint(&self, path: &str) -> Result<Url> {
        self.control_plane_url
            .join(path)
            .map_err(|_| EdgeError::InvalidControlPlaneUrl)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct DurableOutbox {
    pending: EdgeReportEnvelope,
}

pub struct EdgeReporter<S: SecretStore> {
    config: ConnectionConfig,
    files: JsonFileStore,
    signing_key: SigningKey,
    http: Client,
    boot_id: String,
    previous_boot_id: Option<String>,
    next_sequence: u64,
    established: bool,
    pending: Option<EdgeReportEnvelope>,
    outbox_name: String,
    _secrets: S,
}

impl<S: SecretStore> EdgeReporter<S> {
    pub fn load(data_directory: impl Into<PathBuf>, secrets: S) -> Result<Option<Self>> {
        let files = JsonFileStore::new(data_directory);
        let Some(config) = files.read::<ConnectionConfig>(CONFIG_FILE)? else {
            return Ok(None);
        };
        validate_connection_config(&config)?;
        let seed = secrets
            .get(&device_secret_name(&config.server_id, &config.key_id))?
            .ok_or(EdgeError::CredentialUnavailable)
            .and_then(bytes_to_seed)?;
        let outbox_name = outbox_name(&config);
        let durable = files.read::<DurableOutbox>(&outbox_name)?;
        let (boot_id, previous_boot_id, next_sequence, pending, established) =
            if let Some(durable) = durable {
                let next = durable.pending.first_sequence
                    + u64::try_from(durable.pending.events.len()).map_err(|_| {
                        EdgeError::InvalidResponse("outbox is too large".to_owned())
                    })?;
                (
                    durable.pending.boot_id.clone(),
                    durable.pending.previous_boot_id.clone(),
                    next,
                    Some(durable.pending),
                    false,
                )
            } else {
                (
                    Uuid::new_v4().to_string(),
                    config.last_accepted_boot_id.clone(),
                    1,
                    None,
                    false,
                )
            };
        Ok(Some(Self {
            config,
            files,
            signing_key: SigningKey::from_bytes(&seed),
            http: Client::builder()
                .redirect(Policy::none())
                .connect_timeout(Duration::from_secs(8))
                .timeout(Duration::from_secs(20))
                .user_agent(format!("workbuddy-buddy-edge/{CLIENT_VERSION}"))
                .build()?,
            boot_id,
            previous_boot_id,
            next_sequence,
            established,
            pending,
            outbox_name,
            _secrets: secrets,
        }))
    }

    pub fn config(&self) -> &ConnectionConfig {
        &self.config
    }

    pub fn requires_state_snapshot(&self) -> bool {
        !self.established && self.pending.is_none()
    }

    pub fn flush_pending(&mut self) -> Result<Option<EdgeReportAck>> {
        let Some(envelope) = self.pending.clone() else {
            return Ok(None);
        };
        let endpoint = if envelope.events.len() == 1
            && matches!(envelope.events.first(), Some(EdgeEvent::Heartbeat { .. }))
        {
            "/api/v1/edge/heartbeat"
        } else {
            "/api/v1/edge/events:batch"
        };
        let response = self
            .http
            .post(endpoint_url(&self.config.control_plane_url, endpoint)?)
            .json(&envelope)
            .send()?;
        let ack: EdgeReportAck = decode_response(response)?;
        self.accept_ack(&envelope, &ack)?;
        Ok(Some(ack))
    }

    pub fn publish_state(
        &mut self,
        snapshot: StatusSnapshot,
        pet_id: &str,
    ) -> Result<EdgeReportAck> {
        validate_pet_id(pet_id)?;
        let pending_matches = self.pending_matches_state(snapshot, pet_id);
        if let Some(ack) = self.flush_pending()? {
            if pending_matches {
                return Ok(ack);
            }
        }
        let event = state_event(self.next_sequence, snapshot, pet_id, Utc::now());
        self.create_pending(vec![event])?;
        self.flush_pending()?
            .ok_or_else(|| EdgeError::InvalidResponse("state ACK is missing".to_owned()))
    }

    pub fn heartbeat(&mut self) -> Result<Option<EdgeReportAck>> {
        if !self.established && self.pending.is_none() {
            return Ok(None);
        }
        if let Some(ack) = self.flush_pending()? {
            return Ok(Some(ack));
        }
        if !self.established {
            return Ok(None);
        }
        let event = heartbeat_event(self.next_sequence, Utc::now());
        self.create_pending(vec![event])?;
        self.flush_pending()
    }

    fn pending_matches_state(&self, snapshot: StatusSnapshot, pet_id: &str) -> bool {
        let target = state_event(0, snapshot, pet_id, Utc::now());
        matches!(
            (self.pending.as_ref().and_then(|value| value.events.last()), target),
            (
                Some(EdgeEvent::StateTransition {
                    display_state,
                    activity_state,
                    pet_id: pending_pet,
                    ..
                }),
                EdgeEvent::StateTransition {
                    display_state: target_display,
                    activity_state: target_activity,
                    pet_id: target_pet,
                    ..
                },
            ) if display_state == &target_display
                && activity_state == &target_activity
                && pending_pet == &target_pet
        )
    }

    fn create_pending(&mut self, events: Vec<EdgeEvent>) -> Result<()> {
        if self.pending.is_some() {
            return Err(EdgeError::Storage(
                "an exact-retry envelope is already pending".to_owned(),
            ));
        }
        let envelope = sign_envelope(
            EdgeEnvelopeContext {
                instance_id: &self.config.instance_id,
                key_id: &self.config.key_id,
                boot_id: &self.boot_id,
                previous_boot_id: self.previous_boot_id.as_deref(),
                client_version: CLIENT_VERSION,
            },
            events,
            &self.signing_key,
            Utc::now(),
        );
        self.files.write(
            &self.outbox_name,
            &DurableOutbox {
                pending: envelope.clone(),
            },
        )?;
        self.pending = Some(envelope);
        Ok(())
    }

    fn accept_ack(&mut self, envelope: &EdgeReportEnvelope, ack: &EdgeReportAck) -> Result<()> {
        let accepted_through = envelope.first_sequence
            + u64::try_from(envelope.events.len())
                .map_err(|_| EdgeError::InvalidResponse("event count overflow".to_owned()))?
            - 1;
        if ack.instance_id != self.config.instance_id
            || ack.boot_id != self.boot_id
            || ack.accepted_through_sequence != accepted_through
            || ack.current_protocol < PROTOCOL_VERSION as u64
            || ack.min_supported_protocol > PROTOCOL_VERSION as u64
        {
            return Err(EdgeError::InvalidResponse(
                "Edge ACK does not match the pending envelope".to_owned(),
            ));
        }
        self.next_sequence = accepted_through + 1;
        self.established = true;
        self.config.last_accepted_boot_id = Some(self.boot_id.clone());
        let current = self.files.read::<ConnectionConfig>(CONFIG_FILE)?;
        if current.as_ref().is_none_or(|value| {
            value.server_id != self.config.server_id
                || value.instance_id != self.config.instance_id
                || value.key_id != self.config.key_id
        }) {
            self.files.delete(&self.outbox_name)?;
            self.pending = None;
            return Err(EdgeError::ConnectionSuperseded);
        }
        self.files.write(CONFIG_FILE, &self.config)?;
        self.files.delete(&self.outbox_name)?;
        self.pending = None;
        if self.next_sequence > MAX_EVENTS_PER_BOOT {
            self.previous_boot_id = Some(self.boot_id.clone());
            self.boot_id = Uuid::new_v4().to_string();
            self.next_sequence = 1;
            self.established = false;
        }
        Ok(())
    }
}

fn decode_response<T: for<'de> Deserialize<'de>>(response: Response) -> Result<T> {
    let status = response.status();
    if !status.is_success() {
        let detail = response
            .text()
            .unwrap_or_default()
            .chars()
            .take(240)
            .collect::<String>();
        return Err(EdgeError::Http {
            status: status.as_u16(),
            detail,
        });
    }
    Ok(response.json()?)
}

fn validate_control_plane_url(raw: &str) -> Result<Url> {
    let mut url = Url::parse(raw).map_err(|_| EdgeError::InvalidControlPlaneUrl)?;
    if url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(EdgeError::InvalidControlPlaneUrl);
    }
    let host = url.host_str().ok_or(EdgeError::InvalidControlPlaneUrl)?;
    let loopback = host == "localhost" || host == "127.0.0.1" || host == "::1";
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err(EdgeError::InvalidControlPlaneUrl);
    }
    url.set_path("/");
    Ok(url)
}

fn canonical_origin(url: &Url) -> String {
    let mut value = url.clone();
    value.set_path("");
    value.to_string().trim_end_matches('/').to_owned()
}

fn endpoint_url(origin: &str, path: &str) -> Result<Url> {
    validate_control_plane_url(origin)?
        .join(path)
        .map_err(|_| EdgeError::InvalidControlPlaneUrl)
}

fn normalize_pairing_code(raw: &str) -> Result<String> {
    if raw.len() > PAIRING_CODE_MAX_BYTES {
        return Err(EdgeError::InvalidPairingCode);
    }
    let normalized = raw.trim().to_owned();
    if normalized.len() != 43
        || !normalized
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(EdgeError::InvalidPairingCode);
    }
    Ok(normalized)
}

fn validate_pet_id(pet_id: &str) -> Result<()> {
    const PETS: &[&str] = &[
        "bloop",
        "buzz-bit",
        "comet-lop",
        "gizmo-kernel",
        "kiki-koala",
        "momo-mug",
        "moss-shell",
        "nimbus-noodle",
        "nori-nibble",
        "olli-orbit",
        "pico-patch",
        "pogo-ping",
        "rumi-relay",
        "sora-shiba",
        "taro-tinker",
    ];
    if PETS.contains(&pet_id) {
        Ok(())
    } else {
        Err(EdgeError::InvalidPet)
    }
}

fn validate_enrollment_response(response: &EnrollmentResponse) -> Result<()> {
    for (label, value) in [
        ("server_id", &response.server_id),
        ("instance_id", &response.instance_id),
        ("key_id", &response.key_id),
        ("logical_agent_id", &response.logical_agent_id),
    ] {
        Uuid::parse_str(value)
            .map_err(|_| EdgeError::InvalidResponse(format!("{label} is not a UUID")))?;
    }
    if !(15..=3_600).contains(&response.heartbeat_interval_seconds) {
        return Err(EdgeError::InvalidResponse(
            "heartbeat interval is out of range".to_owned(),
        ));
    }
    chrono::DateTime::parse_from_rfc3339(&response.credential_valid_until)
        .map_err(|_| EdgeError::InvalidResponse("credential expiry is invalid".to_owned()))?;
    Ok(())
}

fn validate_connection_config(config: &ConnectionConfig) -> Result<()> {
    validate_control_plane_url(&config.control_plane_url)?;
    validate_enrollment_response(&EnrollmentResponse {
        server_id: config.server_id.clone(),
        instance_id: config.instance_id.clone(),
        key_id: config.key_id.clone(),
        logical_agent_id: config.logical_agent_id.clone(),
        heartbeat_interval_seconds: config.heartbeat_interval_seconds,
        credential_valid_until: config.credential_valid_until.clone(),
    })
}

impl ConnectionConfig {
    pub fn credential_is_expired(&self) -> bool {
        chrono::DateTime::parse_from_rfc3339(&self.credential_valid_until)
            .map(|value| value <= Utc::now())
            .unwrap_or(true)
    }
}

fn pending_secret_name(origin: &str, pairing_code: &str) -> String {
    format!(
        "pending:{}",
        hex::encode(Sha256::digest(
            format!("{origin}\0{pairing_code}").as_bytes()
        ))
    )
}

fn device_secret_name(server_id: &str, key_id: &str) -> String {
    format!("device:{server_id}:{key_id}")
}

fn outbox_name(config: &ConnectionConfig) -> String {
    format!(
        "{OUTBOX_PREFIX}{}-{}.json",
        config.server_id, config.instance_id,
    )
}

fn bytes_to_seed(bytes: Vec<u8>) -> Result<[u8; 32]> {
    bytes
        .try_into()
        .map_err(|_| EdgeError::CredentialUnavailable)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use tempfile::TempDir;

    #[derive(Clone, Default)]
    struct MemorySecrets(Arc<Mutex<HashMap<String, Vec<u8>>>>);

    impl SecretStore for MemorySecrets {
        fn get(&self, name: &str) -> Result<Option<Vec<u8>>> {
            Ok(self.0.lock().unwrap().get(name).cloned())
        }

        fn set(&self, name: &str, secret: &[u8]) -> Result<()> {
            self.0
                .lock()
                .unwrap()
                .insert(name.to_owned(), secret.to_vec());
            Ok(())
        }

        fn delete(&self, name: &str) -> Result<()> {
            self.0.lock().unwrap().remove(name);
            Ok(())
        }
    }

    #[test]
    fn control_plane_requires_https_except_loopback_development() {
        assert!(validate_control_plane_url("https://example.com").is_ok());
        assert!(validate_control_plane_url("http://127.0.0.1:3000").is_ok());
        assert!(validate_control_plane_url("http://localhost:3000").is_ok());
        assert!(validate_control_plane_url("http://example.com").is_err());
        assert!(validate_control_plane_url("https://user@example.com").is_err());
        assert!(validate_control_plane_url("https://example.com?q=secret").is_err());
    }

    #[test]
    fn pairing_codes_are_normalized_without_becoming_low_entropy() {
        assert_eq!(
            normalize_pairing_code(&format!(
                "  {}  ",
                "Abc_def-23456789Z".repeat(2) + "123456789"
            ))
            .unwrap(),
            "Abc_def-23456789Z".repeat(2) + "123456789"
        );
        assert!(normalize_pairing_code("short").is_err());
        assert!(normalize_pairing_code(&format!("{}+", "a".repeat(42))).is_err());
    }

    #[test]
    fn config_files_are_private_and_never_contain_device_seed() {
        let directory = TempDir::new().unwrap();
        let files = JsonFileStore::new(directory.path());
        let config = ConnectionConfig {
            control_plane_url: "https://example.com".to_owned(),
            server_id: Uuid::new_v4().to_string(),
            instance_id: Uuid::new_v4().to_string(),
            key_id: Uuid::new_v4().to_string(),
            logical_agent_id: Uuid::new_v4().to_string(),
            heartbeat_interval_seconds: 30,
            credential_valid_until: "2027-01-01T00:00:00Z".to_owned(),
            last_accepted_boot_id: None,
        };
        files.write(CONFIG_FILE, &config).unwrap();
        let bytes = std::fs::read(directory.path().join(CONFIG_FILE)).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        for forbidden in [
            "private_key",
            "seed",
            "prompt",
            "message",
            "tool_args",
            "session_id",
            "oauth",
        ] {
            assert!(!text.contains(forbidden));
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(directory.path().join(CONFIG_FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn secret_store_namespace_separates_pending_and_device_keys() {
        let store = MemorySecrets::default();
        store.set("pending:a", &[1; 32]).unwrap();
        store.set("device:s:k", &[2; 32]).unwrap();
        assert_eq!(store.get("pending:a").unwrap(), Some(vec![1; 32]));
        assert_eq!(store.get("device:s:k").unwrap(), Some(vec![2; 32]));
        store.delete("pending:a").unwrap();
        assert!(store.get("pending:a").unwrap().is_none());
        assert!(store.get("device:s:k").unwrap().is_some());
    }

    #[test]
    fn replacing_a_pairing_cannot_restore_the_old_connection() {
        let directory = TempDir::new().unwrap();
        let files = JsonFileStore::new(directory.path());
        let old_config = ConnectionConfig {
            control_plane_url: "https://example.com".to_owned(),
            server_id: Uuid::new_v4().to_string(),
            instance_id: Uuid::new_v4().to_string(),
            key_id: Uuid::new_v4().to_string(),
            logical_agent_id: Uuid::new_v4().to_string(),
            heartbeat_interval_seconds: 30,
            credential_valid_until: "2027-01-01T00:00:00Z".to_owned(),
            last_accepted_boot_id: None,
        };
        let new_config = ConnectionConfig {
            instance_id: Uuid::new_v4().to_string(),
            key_id: Uuid::new_v4().to_string(),
            logical_agent_id: Uuid::new_v4().to_string(),
            ..old_config.clone()
        };
        files.write(CONFIG_FILE, &new_config).unwrap();

        let signing_key = SigningKey::from_bytes(&[7; 32]);
        let boot_id = Uuid::new_v4().to_string();
        let envelope = sign_envelope(
            EdgeEnvelopeContext {
                instance_id: &old_config.instance_id,
                key_id: &old_config.key_id,
                boot_id: &boot_id,
                previous_boot_id: None,
                client_version: CLIENT_VERSION,
            },
            vec![heartbeat_event(1, Utc::now())],
            &signing_key,
            Utc::now(),
        );
        let old_outbox = outbox_name(&old_config);
        files
            .write(
                &old_outbox,
                &DurableOutbox {
                    pending: envelope.clone(),
                },
            )
            .unwrap();
        let mut reporter = EdgeReporter {
            config: old_config,
            files: files.clone(),
            signing_key,
            http: Client::new(),
            boot_id: boot_id.clone(),
            previous_boot_id: None,
            next_sequence: 2,
            established: false,
            pending: Some(envelope.clone()),
            outbox_name: old_outbox.clone(),
            _secrets: MemorySecrets::default(),
        };
        let ack = EdgeReportAck {
            current_protocol: 1,
            min_supported_protocol: 1,
            instance_id: envelope.instance_id.clone(),
            boot_id,
            accepted_through_sequence: 1,
            server_received_at: "2026-07-26T00:00:00Z".to_owned(),
            lease_expires_at: "2026-07-26T00:01:30Z".to_owned(),
        };

        assert!(matches!(
            reporter.accept_ack(&envelope, &ack),
            Err(EdgeError::ConnectionSuperseded)
        ));
        let stored = files
            .read::<ConnectionConfig>(CONFIG_FILE)
            .unwrap()
            .unwrap();
        assert_eq!(stored.instance_id, new_config.instance_id);
        assert_eq!(stored.key_id, new_config.key_id);
        assert!(files.read::<DurableOutbox>(&old_outbox).unwrap().is_none());
    }

    #[test]
    fn a_long_lived_reporter_rotates_to_a_bounded_boot() {
        let directory = TempDir::new().unwrap();
        let files = JsonFileStore::new(directory.path());
        let config = ConnectionConfig {
            control_plane_url: "https://example.com".to_owned(),
            server_id: Uuid::new_v4().to_string(),
            instance_id: Uuid::new_v4().to_string(),
            key_id: Uuid::new_v4().to_string(),
            logical_agent_id: Uuid::new_v4().to_string(),
            heartbeat_interval_seconds: 30,
            credential_valid_until: "2027-01-01T00:00:00Z".to_owned(),
            last_accepted_boot_id: None,
        };
        files.write(CONFIG_FILE, &config).unwrap();
        let signing_key = SigningKey::from_bytes(&[8; 32]);
        let boot_id = Uuid::new_v4().to_string();
        let envelope = sign_envelope(
            EdgeEnvelopeContext {
                instance_id: &config.instance_id,
                key_id: &config.key_id,
                boot_id: &boot_id,
                previous_boot_id: None,
                client_version: CLIENT_VERSION,
            },
            vec![heartbeat_event(MAX_EVENTS_PER_BOOT, Utc::now())],
            &signing_key,
            Utc::now(),
        );
        let durable_name = outbox_name(&config);
        files
            .write(
                &durable_name,
                &DurableOutbox {
                    pending: envelope.clone(),
                },
            )
            .unwrap();
        let mut reporter = EdgeReporter {
            config,
            files: files.clone(),
            signing_key,
            http: Client::new(),
            boot_id: boot_id.clone(),
            previous_boot_id: None,
            next_sequence: MAX_EVENTS_PER_BOOT + 1,
            established: true,
            pending: Some(envelope.clone()),
            outbox_name: durable_name,
            _secrets: MemorySecrets::default(),
        };
        let ack = EdgeReportAck {
            current_protocol: 1,
            min_supported_protocol: 1,
            instance_id: envelope.instance_id.clone(),
            boot_id: boot_id.clone(),
            accepted_through_sequence: MAX_EVENTS_PER_BOOT,
            server_received_at: "2026-07-26T00:00:00Z".to_owned(),
            lease_expires_at: "2026-07-26T00:01:30Z".to_owned(),
        };

        reporter.accept_ack(&envelope, &ack).unwrap();
        assert!(reporter.requires_state_snapshot());
        assert_eq!(reporter.previous_boot_id.as_deref(), Some(boot_id.as_str()));
        assert_ne!(reporter.boot_id, boot_id);
        assert_eq!(reporter.next_sequence, 1);
        let stored = files
            .read::<ConnectionConfig>(CONFIG_FILE)
            .unwrap()
            .unwrap();
        assert_eq!(
            stored.last_accepted_boot_id.as_deref(),
            Some(boot_id.as_str())
        );
    }
}
