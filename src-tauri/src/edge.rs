//! WorkBuddy Edge lifecycle.
//!
//! Network reporting is isolated from the pet UI and hook watcher. Failures are
//! logged as coarse diagnostics and never stop the local desktop pet.

use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{App, Listener, Manager, State};
use wb_buddy_core::StatusSnapshot;
use wb_buddy_edge::{
    ConnectionConfig, EdgeEnrollment, EdgeReporter, JsonFileStore, KeyringSecretStore,
};

const DEFAULT_CONTROL_PLANE_URL: &str = "https://control-plane-production-9fa4.up.railway.app";
const CONNECTION_CONFIG_FILE: &str = "edge-connection.json";

#[derive(Clone)]
pub struct EdgeManager {
    data_dir: PathBuf,
    control_plane_url: String,
    sender: Sender<EdgeCommand>,
    connection_guard: Arc<Mutex<()>>,
}

enum EdgeCommand {
    Snapshot(StatusSnapshot),
    PetSelected(String),
    ReloadConnection,
}

#[derive(Debug, Deserialize)]
struct PetSelection {
    source: String,
    id: String,
}

#[derive(Debug, Serialize)]
pub struct EdgeConnectionStatus {
    configured: bool,
    connected: bool,
    credential_available: bool,
    credential_expired: bool,
    control_plane_url: String,
    logical_agent_id: Option<String>,
    credential_valid_until: Option<String>,
}

impl EdgeManager {
    pub fn start(app: &App) -> tauri::Result<Self> {
        let data_dir = app.path().app_data_dir()?;
        let control_plane_url = std::env::var("WB_BUDDY_CONTROL_PLANE_URL")
            .unwrap_or_else(|_| DEFAULT_CONTROL_PLANE_URL.to_owned());
        let (sender, receiver) = mpsc::channel();
        let connection_guard = Arc::new(Mutex::new(()));
        let manager = Self {
            data_dir: data_dir.clone(),
            control_plane_url,
            sender,
            connection_guard: Arc::clone(&connection_guard),
        };
        std::thread::Builder::new()
            .name("wb-buddy-edge".to_owned())
            .spawn(move || reporter_loop(data_dir, receiver, connection_guard))
            .map_err(tauri::Error::Io)?;
        Ok(manager)
    }

    pub fn publish(&self, snapshot: StatusSnapshot) {
        let _ = self.sender.send(EdgeCommand::Snapshot(snapshot));
    }

    fn select_pet(&self, selection: PetSelection) {
        if selection.source == "builtin" {
            let _ = self.sender.send(EdgeCommand::PetSelected(selection.id));
        }
    }

    fn pair(&self, pairing_code: &str) -> Result<ConnectionConfig, String> {
        let _connection_guard = self
            .connection_guard
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let enrollment =
            EdgeEnrollment::new(&self.control_plane_url, &self.data_dir, KeyringSecretStore)
                .map_err(public_error)?;
        let config = enrollment.pair(pairing_code).map_err(public_error)?;
        let _ = self.sender.send(EdgeCommand::ReloadConnection);
        Ok(config)
    }

    fn status(&self) -> EdgeConnectionStatus {
        let config = JsonFileStore::new(&self.data_dir)
            .read::<ConnectionConfig>(CONNECTION_CONFIG_FILE)
            .ok()
            .flatten();
        let credential_available = matches!(
            EdgeReporter::load(&self.data_dir, KeyringSecretStore),
            Ok(Some(_)),
        );
        let credential_expired = config
            .as_ref()
            .is_some_and(ConnectionConfig::credential_is_expired);
        EdgeConnectionStatus {
            configured: config.is_some(),
            connected: config.is_some() && credential_available && !credential_expired,
            credential_available,
            credential_expired,
            control_plane_url: config
                .as_ref()
                .map(|value| value.control_plane_url.clone())
                .unwrap_or_else(|| self.control_plane_url.clone()),
            logical_agent_id: config.as_ref().map(|value| value.logical_agent_id.clone()),
            credential_valid_until: config.map(|value| value.credential_valid_until),
        }
    }
}

pub fn register_events(app: &App, manager: EdgeManager) {
    let pet_manager = manager.clone();
    app.listen_any("pet-selection-changed", move |event| {
        if let Ok(selection) = serde_json::from_str::<PetSelection>(event.payload()) {
            pet_manager.select_pet(selection);
        }
    });
    app.manage(manager);
}

#[tauri::command]
pub async fn pair_office(
    pairing_code: String,
    manager: State<'_, EdgeManager>,
) -> Result<ConnectionConfig, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.pair(&pairing_code))
        .await
        .map_err(|_| "配对任务意外中断，请重试。".to_owned())?
}

#[tauri::command]
pub fn edge_connection_status(manager: State<'_, EdgeManager>) -> EdgeConnectionStatus {
    manager.status()
}

fn reporter_loop(
    data_dir: PathBuf,
    receiver: Receiver<EdgeCommand>,
    connection_guard: Arc<Mutex<()>>,
) {
    let mut reporter = {
        let _guard = connection_guard
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        load_reporter(&data_dir)
    };
    let mut latest_snapshot = None;
    let mut selected_pet = "sora-shiba".to_owned();
    let mut state_needs_send = false;
    let mut next_heartbeat = Instant::now() + heartbeat_delay(reporter.as_ref());

    loop {
        let timeout = next_heartbeat.saturating_duration_since(Instant::now());
        match receiver.recv_timeout(timeout) {
            Ok(EdgeCommand::Snapshot(snapshot)) => {
                latest_snapshot = Some(snapshot);
                state_needs_send = true;
                let _guard = connection_guard
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if let Some(active) = reporter.as_mut() {
                    match active.publish_state(snapshot, &selected_pet) {
                        Ok(_) => {
                            state_needs_send = active.requires_state_snapshot();
                        }
                        Err(error) => log_report_error(&error),
                    }
                }
            }
            Ok(EdgeCommand::PetSelected(pet_id)) => {
                selected_pet = pet_id;
                state_needs_send = true;
                let _guard = connection_guard
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if let (Some(active), Some(snapshot)) = (reporter.as_mut(), latest_snapshot) {
                    match active.publish_state(snapshot, &selected_pet) {
                        Ok(_) => {
                            state_needs_send = active.requires_state_snapshot();
                        }
                        Err(error) => log_report_error(&error),
                    }
                }
            }
            Ok(EdgeCommand::ReloadConnection) => {
                let _guard = connection_guard
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                reporter = load_reporter(&data_dir);
                state_needs_send = latest_snapshot.is_some();
                if let (Some(active), Some(snapshot)) = (reporter.as_mut(), latest_snapshot) {
                    match active.publish_state(snapshot, &selected_pet) {
                        Ok(_) => {
                            state_needs_send = active.requires_state_snapshot();
                        }
                        Err(error) => log_report_error(&error),
                    }
                }
                next_heartbeat = Instant::now() + heartbeat_delay(reporter.as_ref());
            }
            Err(RecvTimeoutError::Timeout) => {
                let _guard = connection_guard
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if reporter.is_none() {
                    reporter = load_reporter(&data_dir);
                    state_needs_send = latest_snapshot.is_some();
                }
                if let Some(active) = reporter.as_mut() {
                    let sent_state = if state_needs_send {
                        if let Some(snapshot) = latest_snapshot {
                            match active.publish_state(snapshot, &selected_pet) {
                                Ok(_) => {
                                    state_needs_send = active.requires_state_snapshot();
                                    true
                                }
                                Err(error) => {
                                    log_report_error(&error);
                                    false
                                }
                            }
                        } else {
                            false
                        }
                    } else {
                        false
                    };
                    if !sent_state {
                        match active.heartbeat() {
                            Ok(_) => {
                                state_needs_send = active.requires_state_snapshot();
                            }
                            Err(error) => log_report_error(&error),
                        }
                    }
                }
                next_heartbeat = Instant::now() + heartbeat_delay(reporter.as_ref());
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn load_reporter(data_dir: &PathBuf) -> Option<EdgeReporter<KeyringSecretStore>> {
    match EdgeReporter::load(data_dir, KeyringSecretStore) {
        Ok(reporter) => reporter,
        Err(error) => {
            log_report_error(&error);
            None
        }
    }
}

fn heartbeat_delay(reporter: Option<&EdgeReporter<KeyringSecretStore>>) -> Duration {
    Duration::from_secs(
        reporter
            .map(|value| value.config().heartbeat_interval_seconds)
            .unwrap_or(30)
            .clamp(15, 3_600),
    )
}

fn public_error(error: wb_buddy_edge::EdgeError) -> String {
    match error {
        wb_buddy_edge::EdgeError::InvalidPairingCode => {
            "配对码格式不正确，请复制网页上显示的完整配对码。".to_owned()
        }
        wb_buddy_edge::EdgeError::Http {
            status: 404 | 410, ..
        } => "配对码不存在、已使用或已过期，请在网页上重新生成。".to_owned(),
        wb_buddy_edge::EdgeError::Http { status: 429, .. } => {
            "尝试次数过多，请稍后重新生成配对码。".to_owned()
        }
        wb_buddy_edge::EdgeError::CredentialUnavailable => {
            "系统钥匙串中的设备凭证不可用，请重新配对。".to_owned()
        }
        wb_buddy_edge::EdgeError::ConnectionSuperseded => "已切换到新的办公室挂载。".to_owned(),
        wb_buddy_edge::EdgeError::Network(_) => {
            "暂时无法连接 Control Plane，请检查网络后重试。".to_owned()
        }
        _ => "挂载失败，请稍后重试。".to_owned(),
    }
}

fn log_report_error(error: &wb_buddy_edge::EdgeError) {
    let category = match error {
        wb_buddy_edge::EdgeError::Network(_) => "network",
        wb_buddy_edge::EdgeError::Http { .. } => "server",
        wb_buddy_edge::EdgeError::CredentialUnavailable | wb_buddy_edge::EdgeError::Keyring(_) => {
            "credential"
        }
        wb_buddy_edge::EdgeError::ConnectionSuperseded => "superseded",
        wb_buddy_edge::EdgeError::Storage(_)
        | wb_buddy_edge::EdgeError::Io(_)
        | wb_buddy_edge::EdgeError::Json(_) => "storage",
        _ => "configuration",
    };
    eprintln!("[wb-buddy-edge] report unavailable ({category})");
}
