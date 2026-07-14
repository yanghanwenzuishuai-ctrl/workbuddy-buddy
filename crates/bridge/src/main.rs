//! wb-buddy-bridge — a local web host for the pet.
//!
//! A background thread tails the event spool (via wb-buddy-watch) and keeps the
//! current display state in shared memory; the HTTP server serves the static
//! frontend and a `/state` endpoint that the page polls. This makes the whole
//! pipeline (WorkBuddy hook → spool → core → pet) runnable and demoable in any
//! browser, with no native app.
//!
//! Loopback-only by default. Env: WB_BUDDY_ADDR (default 127.0.0.1:8787),
//! WB_BUDDY_FRONTEND (default: the repo's frontend/ dir), WB_BUDDY_SPOOL.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::thread;

use tiny_http::{Header, Response, Server};
use wb_buddy_core::State;

fn state_code(s: State) -> u8 {
    match s {
        State::Idle => 0,
        State::Working => 1,
        State::Waiting => 2,
        State::Done => 3,
        State::Failed => 4,
    }
}

fn state_str(code: u8) -> &'static str {
    match code {
        1 => "working",
        2 => "waiting",
        3 => "done",
        4 => "failed",
        _ => "idle",
    }
}

fn frontend_dir() -> PathBuf {
    if let Ok(p) = std::env::var("WB_BUDDY_FRONTEND") {
        return PathBuf::from(p);
    }
    // repo layout: crates/bridge -> ../../frontend
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../frontend")
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("png") => "image/png",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

fn hdr(k: &str, v: &str) -> Header {
    Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap()
}

fn main() {
    let cur = Arc::new(AtomicU8::new(0));
    {
        let cur = cur.clone();
        let spool = wb_buddy_watch::default_spool();
        thread::spawn(move || {
            wb_buddy_watch::run(&spool, move |s| cur.store(state_code(s), Ordering::Relaxed));
        });
    }

    let addr = std::env::var("WB_BUDDY_ADDR").unwrap_or_else(|_| "127.0.0.1:8787".into());
    let root = frontend_dir();
    let server = Server::http(&addr).expect("bind failed");
    eprintln!("[wb-buddy-bridge] http://{addr}  frontend={}", root.display());

    for req in server.incoming_requests() {
        let url = req.url().split('?').next().unwrap_or("/").to_string();

        if url == "/state" {
            let s = state_str(cur.load(Ordering::Relaxed));
            let resp = Response::from_string(s)
                .with_header(hdr("Content-Type", "text/plain; charset=utf-8"))
                .with_header(hdr("Cache-Control", "no-store"));
            let _ = req.respond(resp);
            continue;
        }

        let rel = if url == "/" { "index.html" } else { url.trim_start_matches('/') };
        serve_static(&root, rel, req);
    }
}

fn serve_static(root: &Path, rel: &str, req: tiny_http::Request) {
    // Path-traversal guard: reject any parent-dir components.
    if rel.split('/').any(|c| c == "..") {
        let _ = req.respond(Response::from_string("bad path").with_status_code(400));
        return;
    }
    let path = root.join(rel);
    match std::fs::read(&path) {
        Ok(bytes) => {
            let resp = Response::from_data(bytes).with_header(hdr("Content-Type", content_type(rel)));
            let _ = req.respond(resp);
        }
        Err(_) => {
            let _ = req.respond(Response::from_string("not found").with_status_code(404));
        }
    }
}
