//! UX polish: transparent-area click-through + window-position persistence.
//!
//! **Click-through.** A background thread polls the *global* cursor position and,
//! when it falls outside the pet's opaque silhouette (reported by the frontend as
//! a `pet-hit` event), tells the window to ignore cursor events so clicks fall
//! through the transparent margins to whatever is behind. Polling the *global*
//! cursor is what makes this robust: once a window ignores cursor events it stops
//! receiving them, so the webview alone can never tell when to switch back on.
//! Everything fails safe to "whole window interactive" — an unknown silhouette, a
//! panel being up, or a failed cursor query all keep the pet fully clickable.
//!
//! **Position.** The window's last position is saved to
//! `~/.workbuddy-buddy/window.json` and restored on launch (when still on a
//! connected monitor).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{Listener, Manager, PhysicalPosition, Position, WebviewWindow, WindowEvent};

const POLL_MS: u64 = 50;

#[derive(Clone, Copy)]
struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}
impl Rect {
    fn contains(&self, px: f64, py: f64) -> bool {
        px >= self.x && px <= self.x + self.w && py >= self.y && py <= self.y + self.h
    }
}

/// Shared click-through state: written by the `pet-hit` listener + tray toggle,
/// read by the poll loop.
pub struct ClickThrough {
    enabled: AtomicBool,       // feature toggle (tray); default on
    full: AtomicBool,          // whole window interactive (panel up, or not yet known)
    rect: Mutex<Option<Rect>>, // sprite silhouette, logical px relative to window top-left
    applied: AtomicBool,       // last ignore state pushed to the OS (avoids redundant calls)
}

impl ClickThrough {
    fn new() -> Self {
        Self {
            enabled: AtomicBool::new(true),
            full: AtomicBool::new(true),
            rect: Mutex::new(None),
            applied: AtomicBool::new(false),
        }
    }
}

/// Flip the click-through feature from the tray. Returns the new enabled state.
/// Disabling leaves the window fully interactive (the poll loop restores it).
pub fn toggle(app: &tauri::AppHandle) -> bool {
    match app.try_state::<Arc<ClickThrough>>() {
        Some(ct) => {
            let now = !ct.enabled.load(Ordering::Relaxed);
            ct.enabled.store(now, Ordering::Relaxed);
            now
        }
        None => true,
    }
}

pub fn start(app: &tauri::App) {
    let win = match app.get_webview_window("pet") {
        Some(w) => w,
        None => return,
    };

    // ---- restore saved window position ----
    if let Some((x, y)) = load_pos() {
        if pos_visible(&win, x, y) {
            let _ = win.set_position(Position::Physical(PhysicalPosition::new(x, y)));
        }
    }

    // ---- remember position: record moves, coalesced-flushed by the poll loop ----
    let pending: Arc<Mutex<Option<(i32, i32)>>> = Arc::new(Mutex::new(None));
    {
        let pending = pending.clone();
        win.on_window_event(move |e| {
            if let WindowEvent::Moved(p) = e {
                *pending.lock().unwrap() = Some((p.x, p.y));
            }
        });
    }

    // ---- click-through state, updated by the frontend's `pet-hit` events ----
    let ct = Arc::new(ClickThrough::new());
    {
        let ct = ct.clone();
        app.listen_any("pet-hit", move |ev| {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(ev.payload()) {
                let full = v.get("full").and_then(|b| b.as_bool()).unwrap_or(true);
                ct.full.store(full, Ordering::Relaxed);
                if !full {
                    if let (Some(x), Some(y), Some(w), Some(h)) = (
                        v.get("x").and_then(|n| n.as_f64()),
                        v.get("y").and_then(|n| n.as_f64()),
                        v.get("w").and_then(|n| n.as_f64()),
                        v.get("h").and_then(|n| n.as_f64()),
                    ) {
                        *ct.rect.lock().unwrap() = Some(Rect { x, y, w, h });
                    }
                }
            }
        });
    }
    app.manage(ct.clone());

    // ---- poll loop: flush position + drive click-through ----
    let win = win.clone();
    std::thread::spawn(move || {
        let mut last_saved = load_pos();
        loop {
            std::thread::sleep(Duration::from_millis(POLL_MS));

            let p = *pending.lock().unwrap();
            if let Some(p) = p {
                if Some(p) != last_saved {
                    save_pos(p.0, p.1);
                    last_saved = Some(p);
                }
            }

            let ignore = ct.enabled.load(Ordering::Relaxed)
                && !ct.full.load(Ordering::Relaxed)
                && cursor_outside_sprite(&win, &ct);
            apply_ignore(&win, &ct, ignore);
        }
    });
}

fn cursor_outside_sprite(win: &WebviewWindow, ct: &ClickThrough) -> bool {
    let rect = match *ct.rect.lock().unwrap() {
        Some(r) => r,
        None => return false, // no silhouette yet → stay interactive
    };
    match (win.cursor_position(), win.outer_position(), win.scale_factor()) {
        (Ok(cur), Ok(wp), Ok(sf)) => {
            let rx = (cur.x - wp.x as f64) / sf;
            let ry = (cur.y - wp.y as f64) / sf;
            !rect.contains(rx, ry)
        }
        _ => false, // can't tell → stay interactive
    }
}

fn apply_ignore(win: &WebviewWindow, ct: &ClickThrough, ignore: bool) {
    if ct.applied.swap(ignore, Ordering::Relaxed) != ignore {
        let _ = win.set_ignore_cursor_events(ignore);
    }
}

// ---- position persistence (~/.workbuddy-buddy/window.json) ----
fn store_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".workbuddy-buddy").join("window.json"))
}
fn load_pos() -> Option<(i32, i32)> {
    let s = std::fs::read_to_string(store_path()?).ok()?;
    let v: serde_json::Value = serde_json::from_str(&s).ok()?;
    Some((v.get("x")?.as_i64()? as i32, v.get("y")?.as_i64()? as i32))
}
fn save_pos(x: i32, y: i32) {
    if let Some(p) = store_path() {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, format!("{{\"x\":{x},\"y\":{y}}}"));
    }
}
/// True if (x, y) sits on some connected monitor (with slack), so we don't
/// restore the pet off-screen after a display change.
fn pos_visible(win: &WebviewWindow, x: i32, y: i32) -> bool {
    match win.available_monitors() {
        Ok(ms) => ms.iter().any(|m| {
            let p = m.position();
            let s = m.size();
            x >= p.x - 40
                && y >= p.y - 40
                && x <= p.x + s.width as i32 - 40
                && y <= p.y + s.height as i32 - 40
        }),
        Err(_) => true, // can't enumerate → trust the saved position
    }
}
