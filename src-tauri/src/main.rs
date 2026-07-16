//! workbuddy-buddy desktop pet — Tauri v2 shell.
//!
//! Opens a transparent, always-on-top window rendering the pet frontend, and
//! spawns a background thread that tails the event spool (via wb-buddy-watch)
//! and pushes each display-state change to the window as a `pet-state` event.
//! A menu-bar tray provides Show/Hide and Quit (the window itself is borderless).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod approval;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Emitter, Listener, Manager,
};
use wb_buddy_core::State;

/// Bring the host agent app to the foreground (clicking the pet, Codex-pet style).
/// Target app name is `WorkBuddy` by default; override with `WB_BUDDY_HOST_APP`.
fn activate_host() {
    let app = std::env::var("WB_BUDDY_HOST_APP").unwrap_or_else(|_| "WorkBuddy".into());
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").args(["-a", &app]).spawn();
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = &app; // TODO: Windows/Linux foreground activation
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            build_tray(app)?;
            approval::start(app.handle().clone());
            // clicking the pet brings the host app (WorkBuddy) to the front
            app.listen_any("activate-host", |_| activate_host());

            // Tail the spool on a background thread; push every state change to the pet window.
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

/// Build the menu-bar tray. The borderless pet window has no title bar, so the
/// tray is the only way to hide or quit it.
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let buddy = MenuItem::with_id(app, "buddy", "选择伙伴 / Choose buddy…", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "Show / hide pet", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit workbuddy-buddy", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&buddy, &toggle, &PredefinedMenuItem::separator(app)?, &quit])?;

    let mut builder = TrayIconBuilder::with_id("wb-buddy-tray")
        .tooltip("workbuddy-buddy")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "buddy" => {
                if let Some(win) = app.get_webview_window("pet") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
                let _ = app.emit("open-picker", ());
            }
            "quit" => app.exit(0),
            "toggle" => {
                if let Some(win) = app.get_webview_window("pet") {
                    let visible = win.is_visible().unwrap_or(true);
                    if visible {
                        let _ = win.hide();
                    } else {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
            }
            _ => {}
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}
