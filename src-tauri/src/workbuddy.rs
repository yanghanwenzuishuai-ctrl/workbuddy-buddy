//! WorkBuddy host detection and formal plugin registration.
//!
//! The integration uses WorkBuddy's documented marketplace settings instead
//! of injecting raw hook commands. Existing user settings are preserved and
//! the plugin is only registered after the user confirms office pairing.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

const MARKETPLACE_ID: &str = "workbuddy-buddy";
const PLUGIN_ID: &str = "workbuddy-buddy@workbuddy-buddy";
const MARKETPLACE_REPOSITORY: &str = "FlashFamily/workbuddy-buddy";
const DOWNLOAD_URL: &str = "https://www.workbuddy.cn/";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkBuddyIntegrationStatus {
    host_installed: bool,
    plugin_configured: bool,
    marketplace_available: bool,
    restart_required: bool,
    download_url: &'static str,
}

#[tauri::command]
pub fn workbuddy_integration_status(app: AppHandle) -> Result<WorkBuddyIntegrationStatus, String> {
    status_for_home(&app.path().home_dir().map_err(public_error)?, false)
}

#[tauri::command]
pub fn configure_workbuddy_plugin(app: AppHandle) -> Result<WorkBuddyIntegrationStatus, String> {
    let home = app.path().home_dir().map_err(public_error)?;
    if !host_is_installed(&home) {
        return Ok(status_for_home(&home, false)?);
    }

    let settings_path = home.join(".workbuddy").join("settings.json");
    let mut settings = read_settings(&settings_path)?;
    let changed = register_plugin(&mut settings)?;
    if changed {
        write_settings_atomically(&settings_path, &settings)?;
    }
    status_for_home(&home, changed)
}

#[tauri::command]
pub fn open_workbuddy_download() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg(DOWNLOAD_URL);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("cmd");
        command.args(["/C", "start", "", DOWNLOAD_URL]);
        command
    };

    #[cfg(target_os = "linux")]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(DOWNLOAD_URL);
        command
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|_| "暂时无法打开 WorkBuddy 官方下载页，请访问 workbuddy.cn。".to_owned())
}

fn status_for_home(
    home: &Path,
    restart_required: bool,
) -> Result<WorkBuddyIntegrationStatus, String> {
    let settings_path = home.join(".workbuddy").join("settings.json");
    let plugin_configured = read_settings(&settings_path)
        .ok()
        .is_some_and(|settings| plugin_is_registered(&settings));
    let marketplace_available = home
        .join(".workbuddy")
        .join("plugins")
        .join("marketplaces")
        .join(MARKETPLACE_ID)
        .join(".codebuddy-plugin")
        .join("marketplace.json")
        .is_file();

    Ok(WorkBuddyIntegrationStatus {
        host_installed: host_is_installed(home),
        plugin_configured,
        marketplace_available,
        restart_required,
        download_url: DOWNLOAD_URL,
    })
}

fn host_is_installed(home: &Path) -> bool {
    [
        PathBuf::from("/Applications/WorkBuddy.app"),
        home.join("Applications").join("WorkBuddy.app"),
    ]
    .iter()
    .any(|path| path.is_dir())
}

fn read_settings(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let bytes = fs::read(path)
        .map_err(|_| "无法读取 WorkBuddy 设置；请检查 ~/.workbuddy 的文件权限。".to_owned())?;
    serde_json::from_slice(&bytes)
        .map_err(|_| "WorkBuddy settings.json 不是有效 JSON，未做任何修改。".to_owned())
}

fn register_plugin(settings: &mut Value) -> Result<bool, String> {
    let root = settings
        .as_object_mut()
        .ok_or_else(|| "WorkBuddy settings.json 顶层必须是 JSON 对象，未做任何修改。".to_owned())?;
    let mut changed = false;

    let marketplaces = ensure_object(root, "extraKnownMarketplaces")?;
    let marketplace = json!({
        "source": {
            "source": "github",
            "repo": MARKETPLACE_REPOSITORY
        }
    });
    if marketplaces.get(MARKETPLACE_ID) != Some(&marketplace) {
        marketplaces.insert(MARKETPLACE_ID.to_owned(), marketplace);
        changed = true;
    }

    let enabled = ensure_object(root, "enabledPlugins")?;
    if enabled.get(PLUGIN_ID) != Some(&Value::Bool(true)) {
        enabled.insert(PLUGIN_ID.to_owned(), Value::Bool(true));
        changed = true;
    }

    Ok(changed)
}

fn ensure_object<'a>(
    root: &'a mut Map<String, Value>,
    key: &str,
) -> Result<&'a mut Map<String, Value>, String> {
    if !root.contains_key(key) {
        root.insert(key.to_owned(), Value::Object(Map::new()));
    }
    root.get_mut(key)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| format!("WorkBuddy settings.json 的 {key} 字段类型异常，未做任何修改。"))
}

fn plugin_is_registered(settings: &Value) -> bool {
    let source_ok = settings
        .get("extraKnownMarketplaces")
        .and_then(|value| value.get(MARKETPLACE_ID))
        .and_then(|value| value.get("source"))
        .is_some_and(|source| {
            source.get("source").and_then(Value::as_str) == Some("github")
                && source.get("repo").and_then(Value::as_str) == Some(MARKETPLACE_REPOSITORY)
        });
    let enabled = settings
        .get("enabledPlugins")
        .and_then(|value| value.get(PLUGIN_ID))
        .and_then(Value::as_bool)
        == Some(true);
    source_ok && enabled
}

fn write_settings_atomically(path: &Path, settings: &Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "WorkBuddy 设置路径无效。".to_owned())?;
    fs::create_dir_all(parent).map_err(|_| "无法创建 ~/.workbuddy 设置目录。".to_owned())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
    }

    if path.is_file() {
        let backup = parent.join("settings.json.workbuddy-buddy.bak");
        if !backup.exists() {
            fs::copy(path, &backup)
                .map_err(|_| "无法为 WorkBuddy 设置创建本地备份，未做任何修改。".to_owned())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&backup, fs::Permissions::from_mode(0o600));
            }
        }
    }

    let temporary = parent.join(format!(
        ".settings.json.workbuddy-buddy-{}.tmp",
        std::process::id()
    ));
    let serialized = serde_json::to_vec_pretty(settings)
        .map_err(|_| "无法序列化 WorkBuddy 插件设置。".to_owned())?;

    #[cfg(unix)]
    let mut file = {
        use std::os::unix::fs::OpenOptionsExt;
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
    }
    .map_err(|_| "无法创建 WorkBuddy 临时设置文件。".to_owned())?;

    #[cfg(not(unix))]
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| "无法创建 WorkBuddy 临时设置文件。".to_owned())?;

    let write_result = (|| -> std::io::Result<()> {
        file.write_all(&serialized)?;
        file.write_all(b"\n")?;
        file.sync_all()
    })();
    drop(file);
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
        return Err("写入 WorkBuddy 插件设置失败，原文件未改变。".to_owned());
    }

    if let Err(_error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err("替换 WorkBuddy 插件设置失败，原文件未改变。".to_owned());
    }
    Ok(())
}

fn public_error(_error: impl std::fmt::Display) -> String {
    "无法定位当前用户目录。".to_owned()
}

#[cfg(test)]
mod tests {
    use super::{plugin_is_registered, register_plugin, MARKETPLACE_REPOSITORY};
    use serde_json::json;

    #[test]
    fn registration_preserves_unrelated_settings_and_is_idempotent() {
        let mut settings = json!({
            "hooks": {"SessionStart": [{"matcher": "*"}]},
            "enabledPlugins": {"existing@workbuddy-builtin": true},
            "custom": {"keep": "yes"}
        });

        assert!(register_plugin(&mut settings).unwrap());
        assert!(plugin_is_registered(&settings));
        assert_eq!(settings["custom"]["keep"], "yes");
        assert_eq!(
            settings["enabledPlugins"]["existing@workbuddy-builtin"],
            true
        );
        assert_eq!(
            settings["extraKnownMarketplaces"]["workbuddy-buddy"]["source"]["repo"],
            MARKETPLACE_REPOSITORY
        );
        assert!(!register_plugin(&mut settings).unwrap());
    }

    #[test]
    fn registration_rejects_malformed_owned_fields_without_mutating_them() {
        let mut settings = json!({
            "extraKnownMarketplaces": "unexpected",
            "enabledPlugins": {"existing": true}
        });
        let before = settings.clone();
        assert!(register_plugin(&mut settings).is_err());
        assert_eq!(settings, before);
    }
}
