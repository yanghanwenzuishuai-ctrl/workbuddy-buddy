//! wb-buddy-watch — tails the privacy-safe event spool, drives the core state
//! machine, and invokes a callback whenever the arbitrated display state changes.
//! Shared by the headless daemon (wb-buddy-hookd) and the web bridge.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use wb_buddy_core::{Event, HookKind, Machine, State, StatusSnapshot};

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

#[cfg(unix)]
type FileIdentity = (u64, u64);
#[cfg(windows)]
type FileIdentity = u64;
#[cfg(not(any(unix, windows)))]
type FileIdentity = Option<SystemTime>;

#[cfg(unix)]
fn file_identity(metadata: &std::fs::Metadata) -> FileIdentity {
    use std::os::unix::fs::MetadataExt;
    (metadata.dev(), metadata.ino())
}

#[cfg(windows)]
fn file_identity(metadata: &std::fs::Metadata) -> FileIdentity {
    use std::os::windows::fs::MetadataExt;
    metadata.creation_time()
}

#[cfg(not(any(unix, windows)))]
fn file_identity(metadata: &std::fs::Metadata) -> FileIdentity {
    metadata.created().ok()
}

fn to_event(w: Wire, now: u64) -> Option<Event> {
    let kind = match w.event.as_str() {
        "SessionStart" => HookKind::SessionStart,
        "UserPromptSubmit" => HookKind::UserPromptSubmit,
        "PreToolUse" => HookKind::PreToolUse {
            tool_name: w.tool_name.unwrap_or_default(),
        },
        "PostToolUse" => HookKind::PostToolUse {
            tool_name: w.tool_name.unwrap_or_default(),
        },
        "PermissionRequest" => HookKind::PermissionRequest,
        "Notification" => HookKind::Notification {
            kind: w.notification_type,
        },
        "Stop" => HookKind::Stop {
            ends_with_question: w.ends_with_question.unwrap_or(false),
        },
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
    PathBuf::from(home)
        .join(".workbuddy-buddy")
        .join("events.spool")
}

/// Apply every complete (newline-terminated) line in `bytes` to `machine`, using
/// `now` for events that omit a ts. Returns the number of bytes consumed — a
/// trailing partial line (the hook is mid-append) is left unconsumed so it is
/// re-read intact on the next tick. Blank / malformed / non-UTF-8 lines are skipped.
fn consume(machine: &mut Machine, bytes: &[u8], now: u64) -> usize {
    let Some(idx) = bytes.iter().rposition(|&b| b == b'\n') else {
        return 0; // no complete line yet
    };
    let complete = &bytes[..=idx];
    for line in complete.split(|&b| b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(text) = std::str::from_utf8(line) else {
            continue;
        };
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        if let Ok(w) = serde_json::from_str::<Wire>(text) {
            if let Some(ev) = to_event(w, now) {
                machine.apply_at(&ev, now);
            }
        }
    }
    complete.len()
}

/// Read all currently available complete lines. Keeping this separate from the
/// forever loop lets semantic consumers catch up the existing spool before their
/// first callback, avoiding a fabricated restart-time Idle transition.
fn read_available(
    spool: &Path,
    machine: &mut Machine,
    pos: &mut u64,
    identity: &mut Option<FileIdentity>,
    now: u64,
) {
    if let Ok(mut f) = File::open(spool) {
        let metadata = f.metadata().ok();
        let len = metadata.as_ref().map(|value| value.len()).unwrap_or(0);
        if let Some(current_identity) = metadata.as_ref().map(file_identity) {
            if identity.is_some_and(|previous| previous != current_identity) {
                *pos = 0; // path now points at a replacement file
            }
            *identity = Some(current_identity);
        }
        if len < *pos {
            *pos = 0; // truncated / recreated smaller
        }
        if f.seek(SeekFrom::Start(*pos)).is_ok() {
            let mut buf = Vec::new();
            if f.read_to_end(&mut buf).is_ok() && !buf.is_empty() {
                *pos += consume(machine, &buf, now) as u64;
            }
        }
    }
}

/// Tail `spool` forever and emit semantic snapshots. The existing spool is read
/// before the first callback, so a watcher restart cannot manufacture a fake
/// `Idle` transition ahead of catch-up.
pub fn run_snapshots(spool: &Path, mut on_change: impl FnMut(StatusSnapshot)) -> ! {
    let mut machine = Machine::new();
    let mut last: Option<StatusSnapshot> = None;
    let mut pos: u64 = 0;
    let mut identity = None;

    loop {
        let now = now_ms();
        read_available(spool, &mut machine, &mut pos, &mut identity, now);
        let current = machine.snapshot(now);
        if last != Some(current) {
            on_change(current);
            last = Some(current);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// Tail `spool` forever, calling `on_change` with the initial state and on every
/// subsequent change (including TTL-decay transitions). Never returns.
///
/// Robust against concurrent appends (only complete newline-terminated lines are
/// consumed) and against truncation/rotation (offset resets when the file shrinks).
pub fn run(spool: &Path, mut on_change: impl FnMut(State)) -> ! {
    let mut last: Option<State> = None;

    run_snapshots(spool, |snapshot| {
        let current = snapshot.legacy_state();
        if last != Some(current) {
            on_change(current);
            last = Some(current);
        }
    })
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
        assert_eq!(
            to_event(wire(r#"{"event":"SessionStart"}"#), 5)
                .unwrap()
                .session_id,
            "default"
        );
    }

    #[test]
    fn missing_ts_uses_now() {
        assert_eq!(
            to_event(wire(r#"{"event":"UserPromptSubmit"}"#), 4242)
                .unwrap()
                .ts,
            4242
        );
    }

    #[test]
    fn present_ts_is_kept() {
        assert_eq!(
            to_event(wire(r#"{"event":"UserPromptSubmit","ts":99}"#), 4242)
                .unwrap()
                .ts,
            99
        );
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
        assert!(matches!(
            e.kind,
            HookKind::Stop {
                ends_with_question: false
            }
        ));
    }

    #[test]
    fn initial_read_catches_up_spool_before_first_semantic_snapshot() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "wb-buddy-watch-{}-{nonce}.spool",
            std::process::id()
        ));
        std::fs::write(
            &path,
            b"{\"event\":\"SessionStart\",\"session_id\":\"s\",\"ts\":1}\n\
              {\"event\":\"UserPromptSubmit\",\"session_id\":\"s\",\"ts\":2}\n",
        )
        .unwrap();

        let mut machine = Machine::new();
        let mut pos = 0;
        let mut identity = None;
        read_available(&path, &mut machine, &mut pos, &mut identity, 3);
        let snapshot = machine.snapshot(3);

        assert_eq!(snapshot.display_state, wb_buddy_core::DisplayState::Thinking);
        assert_eq!(
            snapshot.activity_state,
            wb_buddy_core::ActivityState::Active
        );
        assert_eq!(snapshot.legacy_state(), State::Thinking);
        assert!(pos > 0);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn replacement_spool_resets_offset_even_when_new_file_is_larger() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "wb-buddy-watch-rotation-{}-{nonce}.spool",
            std::process::id()
        ));
        let replacement = path.with_extension("replacement");
        std::fs::write(
            &path,
            b"{\"event\":\"PermissionRequest\",\"session_id\":\"old\",\"ts\":1}\n",
        )
        .unwrap();

        let mut machine = Machine::new();
        let mut pos = 0;
        let mut identity = None;
        read_available(&path, &mut machine, &mut pos, &mut identity, 10);
        assert_eq!(machine.display_state(10), State::Waiting);
        let old_pos = pos;

        let mut replacement_bytes =
            b"{\"event\":\"Notification\",\"session_id\":\"new\",\"ts\":2,\"notification_type\":\"error\"}\n"
                .to_vec();
        replacement_bytes.resize((old_pos as usize) + 32, b' ');
        replacement_bytes.push(b'\n');
        std::fs::write(&replacement, replacement_bytes).unwrap();
        std::fs::remove_file(&path).unwrap();
        std::fs::rename(&replacement, &path).unwrap();

        read_available(&path, &mut machine, &mut pos, &mut identity, 20);
        assert_eq!(machine.display_state(20), State::Failed);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn consume_exposes_idle_prompt_as_waiting_but_eligible() {
        let mut machine = Machine::new();
        consume(
            &mut machine,
            b"{\"event\":\"Notification\",\"session_id\":\"s\",\"ts\":1,\"notification_type\":\"idle_prompt\"}\n",
            2,
        );
        let snapshot = machine.snapshot(2);
        assert_eq!(snapshot.display_state, wb_buddy_core::DisplayState::Waiting);
        assert_eq!(
            snapshot.activity_state,
            wb_buddy_core::ActivityState::EligibleIdle
        );
    }

    // ---- consume() : the spool-tail robustness fixes -----------------------
    #[test]
    fn consume_applies_complete_lines_and_leaves_partial() {
        let mut m = Machine::new();
        let bytes = b"{\"event\":\"UserPromptSubmit\",\"session_id\":\"s\",\"ts\":1}\n\
                      {\"event\":\"Stop\",\"session_id\":\"s\",\"ts\":2}\n\
                      {\"event\":\"parti";
        let consumed = consume(&mut m, bytes, 1000);
        assert!(
            consumed < bytes.len(),
            "trailing partial line must not be consumed"
        );
        assert_eq!(m.display_state(2), State::Done); // both complete lines applied
    }

    #[test]
    fn consume_returns_zero_without_a_newline() {
        let mut m = Machine::new();
        assert_eq!(
            consume(&mut m, b"{\"event\":\"UserPromptSubmit\"}", 1000),
            0
        );
        assert_eq!(m.display_state(1000), State::Idle); // nothing applied yet
    }

    #[test]
    fn partial_line_completes_on_the_next_tick() {
        // The exact defect the fix targets: one JSONL line split across two reads
        // must not be lost or corrupted.
        let mut m = Machine::new();
        let t1 = b"{\"event\":\"UserPromptSubmit\",\"session_id\":\"s\",\"ts\":1}\n{\"event\":\"St";
        let c1 = consume(&mut m, t1, 10);
        assert_eq!(m.display_state(10), State::Thinking);
        // run() advances pos by c1, so the next read re-includes the un-consumed bytes:
        let mut t2 = t1[c1..].to_vec();
        t2.extend_from_slice(b"op\",\"session_id\":\"s\",\"ts\":2}\n");
        consume(&mut m, &t2, 20);
        assert_eq!(m.display_state(20), State::Done); // event survived the split
    }

    #[test]
    fn consume_skips_blank_and_malformed_lines() {
        let mut m = Machine::new();
        let bytes = b"\n  \nnot json at all\n{\"event\":\"PermissionRequest\",\"session_id\":\"s\",\"ts\":1}\n";
        consume(&mut m, bytes, 1000);
        assert_eq!(m.display_state(1), State::Waiting); // only the one valid line applied
    }
}
