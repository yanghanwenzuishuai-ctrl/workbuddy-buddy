//! workbuddy-buddy desktop pet — Tauri v2 shell.
//!
//! Opens a transparent, always-on-top window rendering the pet frontend, and
//! spawns a background thread that tails the event spool (via wb-buddy-watch)
//! and pushes each display-state change to the window as a `pet-state` event.
//! The frontend (frontend/index.html) listens for `pet-state` and animates.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Emitter;
use wb_buddy_core::State;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            let spool = wb_buddy_watch::default_spool();
            eprintln!("[wb-buddy-app] tailing {}", spool.display());
            std::thread::spawn(move || {
                wb_buddy_watch::run(&spool, move |s: State| {
                    let _ = handle.emit("pet-state", s.as_str());
                });
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running workbuddy-buddy");
}
