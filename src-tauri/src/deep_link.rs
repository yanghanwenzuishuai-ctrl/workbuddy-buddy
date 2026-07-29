//! Strict handling for the public `workbuddy-buddy://` custom scheme.
//!
//! A deep link may open the connect panel and optionally prefill its one-time
//! pairing code. It never claims the pairing code: the user must still press
//! the confirmation button in the webview.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

const CONNECT_PREFIX: &str = "workbuddy-buddy://connect";
const PAIRING_CODE_LEN: usize = 43;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectRequest {
    pairing_code: Option<String>,
}

#[derive(Default)]
pub(crate) struct PendingConnect(Mutex<Option<ConnectRequest>>);

pub(crate) fn setup(app: &mut tauri::App) -> tauri::Result<()> {
    app.manage(PendingConnect::default());

    let handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        open_first_valid(&handle, event.urls().iter().map(|url| url.as_str()));
    });

    let current = app
        .deep_link()
        .get_current()
        .map_err(|_| std::io::Error::other("failed to inspect launch deep link"))?;
    if let Some(urls) = current {
        open_first_valid(app.handle(), urls.iter().map(|url| url.as_str()));
    }

    Ok(())
}

/// Called by the single-instance plugin even for an ordinary second launch.
/// Deep-link parsing itself remains owned by the deep-link plugin.
pub(crate) fn focus_pet(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("pet") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub(crate) fn take_pending_connect(
    state: tauri::State<'_, PendingConnect>,
) -> Option<ConnectRequest> {
    state.0.lock().ok()?.take()
}

fn open_first_valid<'a>(app: &AppHandle, urls: impl IntoIterator<Item = &'a str>) {
    if let Some(request) = urls.into_iter().find_map(parse_connect_url) {
        if let Some(pending) = app.try_state::<PendingConnect>() {
            if let Ok(mut slot) = pending.0.lock() {
                *slot = Some(request);
            }
        }

        focus_pet(app);
        // Do not include the pairing code in the event payload. The frontend
        // retrieves the pending request once through the command above.
        let _ = app.emit_to("pet", "open-connect", ());
    }
}

fn parse_connect_url(raw: &str) -> Option<ConnectRequest> {
    let suffix = raw.strip_prefix(CONNECT_PREFIX)?;
    match suffix {
        "" | "/" => Some(ConnectRequest::default()),
        fragment if fragment.starts_with("#code=") => {
            parse_code_fragment(fragment.strip_prefix("#code=")?)
        }
        fragment if fragment.starts_with("/#code=") => {
            parse_code_fragment(fragment.strip_prefix("/#code=")?)
        }
        _ => None,
    }
}

fn parse_code_fragment(code: &str) -> Option<ConnectRequest> {
    is_pairing_code(code).then(|| ConnectRequest {
        pairing_code: Some(code.to_owned()),
    })
}

fn is_pairing_code(value: &str) -> bool {
    value.len() == PAIRING_CODE_LEN
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::{parse_connect_url, ConnectRequest};

    #[test]
    fn accepts_connect_with_or_without_a_canonical_code() {
        let code = "A".repeat(43);
        assert_eq!(
            parse_connect_url("workbuddy-buddy://connect"),
            Some(ConnectRequest::default())
        );
        assert_eq!(
            parse_connect_url(&format!("workbuddy-buddy://connect#code={code}")),
            Some(ConnectRequest {
                pairing_code: Some(code)
            })
        );
    }

    #[test]
    fn rejects_other_actions_and_noncanonical_codes() {
        for raw in [
            "workbuddy://connect",
            "workbuddy-buddy://pair",
            "workbuddy-buddy://connect?code=secret",
            "workbuddy-buddy://connect#code=short",
            "workbuddy-buddy://connect#code=abcdefghijklmnopqrstuvwxyz0123456789_-ABC+",
            "workbuddy-buddy://connect#code=abcdefghijklmnopqrstuvwxyz0123456789_-ABC%44",
        ] {
            assert_eq!(parse_connect_url(raw), None, "{raw}");
        }
    }
}
