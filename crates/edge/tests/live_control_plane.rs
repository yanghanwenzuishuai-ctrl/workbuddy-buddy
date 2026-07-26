use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use reqwest::blocking::Client;
use serde::Deserialize;
use tempfile::TempDir;
use wb_buddy_core::{ActivityState, DisplayState, IdleStage, StatusSnapshot};
use wb_buddy_edge::{EdgeEnrollment, EdgeReporter, Result, SecretStore};

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

#[derive(Deserialize)]
struct OfficeCreated {
    pairing_code: String,
    status_token: String,
    office_url: String,
}

#[test]
#[ignore = "requires WB_BUDDY_LIVE_TEST_URL and a disposable migrated database"]
fn pair_sign_report_and_read_the_public_projection() {
    let origin =
        std::env::var("WB_BUDDY_LIVE_TEST_URL").expect("WB_BUDDY_LIVE_TEST_URL is required");
    let origin = origin.trim_end_matches('/');
    let http = Client::new();
    let created: OfficeCreated = http
        .post(format!("{origin}/api/v1/onboarding/offices"))
        .json(&serde_json::json!({
            "office_name": "Rust Edge E2E",
            "alias": "Bloop E2E",
            "pet_id": "sora-shiba",
            "presence_visible": true,
            "stats_opt_in": true,
            "poster_opt_in": true
        }))
        .send()
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .unwrap();

    let directory = TempDir::new().unwrap();
    let secrets = MemorySecrets::default();
    EdgeEnrollment::new(origin, directory.path(), secrets.clone())
        .unwrap()
        .pair(&created.pairing_code)
        .unwrap();
    let pairing_status: serde_json::Value = http
        .get(format!(
            "{origin}/api/v1/onboarding/pairings/{}",
            created.status_token,
        ))
        .send()
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(pairing_status["status"], "claimed");

    let mut reporter = EdgeReporter::load(directory.path(), secrets)
        .unwrap()
        .expect("enrollment must create a reporter");
    reporter
        .publish_state(
            StatusSnapshot {
                display_state: DisplayState::Working,
                activity_state: ActivityState::Active,
                idle_stage: IdleStage::None,
                display_since: None,
                activity_since: None,
            },
            "bloop",
        )
        .unwrap();

    let token = created
        .office_url
        .strip_prefix("/o/")
        .expect("office URL must be a local capability path");
    let snapshot: serde_json::Value = http
        .get(format!("{origin}/api/v1/offices/{token}/snapshot",))
        .send()
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(snapshot["agents"][0]["alias"], "Bloop E2E");
    assert_eq!(snapshot["agents"][0]["pet_id"], "bloop");
    assert_eq!(snapshot["agents"][0]["presence"], "online");
    assert_eq!(snapshot["agents"][0]["display_state"], "working");
}
