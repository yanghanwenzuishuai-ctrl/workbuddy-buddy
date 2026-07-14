//! wb-buddy-watch — tails the privacy-safe event spool, drives the core state
//! machine, and invokes a callback whenever the arbitrated display state changes.
//! Shared by the headless daemon (wb-buddy-hookd) and the web bridge.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use wb_buddy_core::{Event, HookKind, Machine, State};

/// The wire shape written by hooks/project.py — structural fields only.
#[derive(Deserialize)]
struct Wire {
    event: String,
    #[serde(default)]
    ts: Option<u64>,
    session_id: Option<String>,
    tool_name: Option<String>,
    notification_type: Option<String>,
    ends_with_question: Option<bool>,
}

fn to_event(w: Wire, now: u64) -> Option<Event> {
    let kind = match w.event.as_str() {
        "SessionStart" => HookKind::SessionStart,
        "UserPromptSubmit" => HookKind::UserPromptSubmit,
        "PreToolUse" => HookKind::PreToolUse { tool_name: w.tool_name.unwrap_or_default() },
        "PostToolUse" => HookKind::PostToolUse { tool_name: w.tool_name.unwrap_or_default() },
        "PermissionRequest" => HookKind::PermissionRequest,
        "Notification" => HookKind::Notification { kind: w.notification_type },
        "Stop" => HookKind::Stop { ends_with_question: w.ends_with_question.unwrap_or(false) },
        _ => return None,
    };
    Some(Event {
        session_id: w.session_id.unwrap_or_else(|| "default".into()),
        ts: w.ts.unwrap_or(now),
        kind,
    })
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Default spool path (honours `WB_BUDDY_SPOOL`).
pub fn default_spool() -> PathBuf {
    if let Ok(p) = std::env::var("WB_BUDDY_SPOOL") {
        return PathBuf::from(p);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".workbuddy-buddy").join("events.spool")
}

/// Tail `spool` forever, calling `on_change` with the initial state and on every
/// subsequent change (including TTL-decay transitions). Never returns.
///
/// Robust against concurrent appends (only complete newline-terminated lines are
/// consumed) and against truncation/rotation (offset resets when the file shrinks).
pub fn run(spool: &Path, mut on_change: impl FnMut(State)) -> ! {
    let mut machine = Machine::new();
    let mut last = State::Idle;
    let mut pos: u64 = 0;
    on_change(last);

    loop {
        if let Ok(mut f) = File::open(spool) {
            let len = f.metadata().map(|m| m.len()).unwrap_or(0);
            if len < pos {
                pos = 0; // truncated / rotated / recreated smaller
            }
            if f.seek(SeekFrom::Start(pos)).is_ok() {
                let mut buf = Vec::new();
                if f.read_to_end(&mut buf).is_ok() && !buf.is_empty() {
                    if let Some(idx) = buf.iter().rposition(|&b| b == b'\n') {
                        let complete = &buf[..=idx];
                        pos += complete.len() as u64;
                        let now = now_ms();
                        for line in complete.split(|&b| b == b'\n') {
                            if line.is_empty() {
                                continue;
                            }
                            let Ok(text) = std::str::from_utf8(line) else { continue };
                            let text = text.trim();
                            if text.is_empty() {
                                continue;
                            }
                            if let Ok(w) = serde_json::from_str::<Wire>(text) {
                                if let Some(ev) = to_event(w, now) {
                                    machine.apply(&ev);
                                }
                            }
                        }
                    }
                }
            }
        }
        let cur = machine.display_state(now_ms());
        if cur != last {
            on_change(cur);
            last = cur;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wire(json: &str) -> Wire {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn unknown_event_is_ignored() {
        assert!(to_event(wire(r#"{"event":"Nope"}"#), 5).is_none());
    }

    #[test]
    fn missing_session_id_defaults() {
        assert_eq!(to_event(wire(r#"{"event":"SessionStart"}"#), 5).unwrap().session_id, "default");
    }

    #[test]
    fn missing_ts_uses_now() {
        assert_eq!(to_event(wire(r#"{"event":"UserPromptSubmit"}"#), 4242).unwrap().ts, 4242);
    }

    #[test]
    fn present_ts_is_kept() {
        assert_eq!(to_event(wire(r#"{"event":"UserPromptSubmit","ts":99}"#), 4242).unwrap().ts, 99);
    }

    #[test]
    fn pretooluse_carries_tool_name_or_empty() {
        let e = to_event(wire(r#"{"event":"PreToolUse","tool_name":"Read"}"#), 0).unwrap();
        assert!(matches!(e.kind, HookKind::PreToolUse { tool_name } if tool_name == "Read"));
        let e2 = to_event(wire(r#"{"event":"PreToolUse"}"#), 0).unwrap();
        assert!(matches!(e2.kind, HookKind::PreToolUse { tool_name } if tool_name.is_empty()));
    }

    #[test]
    fn stop_defaults_question_false() {
        let e = to_event(wire(r#"{"event":"Stop"}"#), 0).unwrap();
        assert!(matches!(e.kind, HookKind::Stop { ends_with_question: false }));
    }
}
