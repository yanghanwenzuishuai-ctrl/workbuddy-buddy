//! Two-way approval channel: the pet as a permission UI.
//!
//! A WorkBuddy PreToolUse/PermissionRequest hook POSTs the pending tool call to
//! this local server and *blocks* awaiting a decision. We emit a `pet-approval`
//! event to the pet window (bubble with Allow/Deny); the frontend emits a
//! `pet-decision` event back (or a test can POST /decide). The hook receives
//! "allow" / "deny" / "timeout" and translates it into a hook decision that
//! WorkBuddy honors (verified live: deny reasons are fed back to the agent).
//!
//! Privacy: approval details (tool name + a truncated command summary) exist
//! in memory only for the lifetime of the request — never written to disk.
//! Fail-open by design: if this server is down, the hook exits silently and
//! WorkBuddy behaves exactly as if the pet did not exist.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Listener};
use tiny_http::{Header, Method, Response, Server};

/// How long a pending approval waits for a human before resolving "timeout".
const DECISION_WINDOW: Duration = Duration::from_secs(50);

static PENDING: OnceLock<Mutex<HashMap<u64, SyncSender<String>>>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn pending() -> &'static Mutex<HashMap<u64, SyncSender<String>>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Resolve a pending approval. Returns false if the id is unknown (already
/// resolved / timed out).
pub fn resolve(id: u64, decision: &str) -> bool {
    let tx = pending().lock().ok().and_then(|mut m| m.remove(&id));
    match tx {
        Some(tx) => tx.send(decision.to_string()).is_ok(),
        None => false,
    }
}

pub fn port() -> u16 {
    std::env::var("WB_BUDDY_APPROVAL_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8792)
}

fn cors(resp: Response<std::io::Cursor<Vec<u8>>>) -> Response<std::io::Cursor<Vec<u8>>> {
    resp.with_header(Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap())
        .with_header(Header::from_bytes("Access-Control-Allow-Methods", "POST, GET, OPTIONS").unwrap())
        .with_header(Header::from_bytes("Access-Control-Allow-Headers", "content-type").unwrap())
}

/// Start the approval server and the frontend-decision listener.
pub fn start(app: AppHandle) {
    // Frontend bubble buttons emit `pet-decision` with {id, decision}.
    app.listen_any("pet-decision", |event| {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(event.payload()) {
            let id = v.get("id").and_then(|x| x.as_u64()).unwrap_or(0);
            let decision = v.get("decision").and_then(|x| x.as_str()).unwrap_or("");
            if id != 0 && (decision == "allow" || decision == "deny") {
                resolve(id, decision);
            }
        }
    });

    let addr = format!("127.0.0.1:{}", port());
    std::thread::spawn(move || {
        let server = match Server::http(&addr) {
            Ok(s) => {
                eprintln!("[wb-buddy-app] approval server on http://{addr}");
                s
            }
            Err(e) => {
                eprintln!("[wb-buddy-app] approval server failed to bind {addr}: {e}");
                return;
            }
        };
        for mut req in server.incoming_requests() {
            let app = app.clone();
            std::thread::spawn(move || {
                let path = req.url().split('?').next().unwrap_or("/").to_string();
                let method = req.method().clone();
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);

                let respond = |req: tiny_http::Request, code: u16, text: &str| {
                    let resp = cors(Response::from_string(text).with_status_code(code));
                    let _ = req.respond(resp);
                };

                if method == Method::Get && path.starts_with("/userpet/") {
                    serve_userpet(&path, req);
                    return;
                }
                match (method, path.as_str()) {
                    (Method::Options, _) => respond(req, 204, ""),
                    (Method::Post, "/approve") => {
                        let v: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
                        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
                        let (tx, rx) = sync_channel::<String>(1);
                        if let Ok(mut m) = pending().lock() {
                            m.insert(id, tx);
                        }
                        let _ = app.emit(
                            "pet-approval",
                            serde_json::json!({
                                "id": id,
                                "tool_name": v.get("tool_name").and_then(|x| x.as_str()).unwrap_or("?"),
                                "detail": v.get("detail").and_then(|x| x.as_str()).unwrap_or(""),
                                "seconds": DECISION_WINDOW.as_secs(),
                            }),
                        );
                        let decision = rx.recv_timeout(DECISION_WINDOW).unwrap_or_else(|_| "timeout".into());
                        if let Ok(mut m) = pending().lock() {
                            m.remove(&id); // in case of timeout
                        }
                        // tell the bubble to close if it timed out server-side
                        let _ = app.emit("pet-approval-done", serde_json::json!({"id": id}));
                        respond(req, 200, &decision);
                    }
                    (Method::Post, "/decide") => {
                        // test / alternate channel: body = "<id> <allow|deny>"
                        let mut it = body.split_whitespace();
                        let id: u64 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
                        let d = it.next().unwrap_or("");
                        if (d == "allow" || d == "deny") && resolve(id, d) {
                            respond(req, 200, "ok");
                        } else {
                            respond(req, 404, "gone");
                        }
                    }
                    (Method::Get, "/pending") => {
                        let ids: Vec<u64> = pending().lock().map(|m| m.keys().cloned().collect()).unwrap_or_default();
                        respond(req, 200, &serde_json::to_string(&ids).unwrap_or_else(|_| "[]".into()));
                    }
                    _ => respond(req, 404, "not found"),
                }
            });
        }
    });
}

/// Serve a user-supplied pet pack from ~/.workbuddy-buddy/pet/ (pet.json,
/// spritesheet.png, ...). Lets people drop in their own pet without a rebuild.
fn serve_userpet(path: &str, req: tiny_http::Request) {
    let rel = &path["/userpet/".len()..];
    if rel.is_empty() || rel.split('/').any(|c| c == "..") {
        let _ = req.respond(cors(Response::from_string("bad path").with_status_code(400)));
        return;
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    let file = std::path::Path::new(&home).join(".workbuddy-buddy").join("pet").join(rel);
    match std::fs::read(&file) {
        Ok(bytes) => {
            let ct = if rel.ends_with(".json") { "application/json; charset=utf-8" }
                     else if rel.ends_with(".png") { "image/png" }
                     else if rel.ends_with(".webp") { "image/webp" }
                     else { "application/octet-stream" };
            let resp = cors(Response::from_data(bytes)
                .with_header(Header::from_bytes("Content-Type", ct).unwrap()));
            let _ = req.respond(resp);
        }
        Err(_) => { let _ = req.respond(cors(Response::from_string("not found").with_status_code(404))); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_unknown_id_is_false() {
        assert!(!resolve(999_999, "allow"));
    }

    #[test]
    fn resolve_delivers_decision() {
        let (tx, rx) = sync_channel::<String>(1);
        pending().lock().unwrap().insert(42, tx);
        assert!(resolve(42, "deny"));
        assert_eq!(rx.recv().unwrap(), "deny");
        assert!(!resolve(42, "deny")); // second resolve: already gone
    }
}
