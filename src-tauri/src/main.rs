//! workbuddy-buddy desktop pet — Tauri v2 shell.
//!
//! Opens a transparent, always-on-top window rendering the pet frontend, and
//! spawns a background thread that tails the event spool (via wb-buddy-watch)
//! and pushes each display-state change to the window as a `pet-state` event.
//! A menu-bar tray provides Show/Hide and Quit (the window itself is borderless).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod approval;
mod edge;
mod ux;

use fs2::FileExt;
use std::fs::{File, OpenOptions};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Emitter, Listener, Manager,
};
use wb_buddy_core::State;

struct AppInstanceLock {
    _file: File,
}

/// Bring the host agent app to the foreground (clicking the pet, Codex-pet style).
/// Target app name is `WorkBuddy` by default; override with `WB_BUDDY_HOST_APP`.
fn activate_host() {
    let app = std::env::var("WB_BUDDY_HOST_APP").unwrap_or_else(|_| "WorkBuddy".into());
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .args(["-a", &app])
            .spawn();
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = &app; // TODO: Windows/Linux foreground activation
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            edge::pair_office,
            edge::edge_connection_status
        ])
        .setup(|app| {
            acquire_instance_lock(app)?;
            build_tray(app)?;
            approval::start(app.handle().clone());
            let edge = edge::EdgeManager::start(app)?;
            edge::register_events(app, edge.clone());
            // transparent-area click-through + remember window position
            ux::start(app);
            // clicking the pet brings the host app (WorkBuddy) to the front
            app.listen_any("activate-host", |_| activate_host());

            // Tail the spool on a background thread; push every state change to the pet window.
            let handle = app.handle().clone();
            let spool = wb_buddy_watch::default_spool();
            eprintln!("[wb-buddy-app] tailing {}", spool.display());
            std::thread::spawn(move || {
                wb_buddy_watch::run_snapshots(&spool, move |snapshot| {
                    let state: State = snapshot.legacy_state();
                    let _ = handle.emit("pet-state", state.as_str());
                    edge.publish(snapshot);
                });
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running workbuddy-buddy");
}

fn acquire_instance_lock(app: &tauri::App) -> tauri::Result<()> {
    let data_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data_dir)?;
    let lock_file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(data_dir.join("workbuddy-buddy.instance.lock"))?;
    lock_file.try_lock_exclusive().map_err(|error| {
        std::io::Error::new(
            error.kind(),
            "another workbuddy-buddy process is already running",
        )
    })?;
    app.manage(AppInstanceLock { _file: lock_file });
    Ok(())
}

/// Build the menu-bar tray. The borderless pet window has no title bar, so the
/// tray is the only way to hide or quit it.
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let buddy = MenuItem::with_id(app, "buddy", "选择伙伴 / Choose buddy…", true, None::<&str>)?;
    let connect = MenuItem::with_id(
        app,
        "connect",
        "挂载到办公室 / Connect office…",
        true,
        None::<&str>,
    )?;
    let toggle = MenuItem::with_id(app, "toggle", "Show / hide pet", true, None::<&str>)?;
    // Click-through defaults on (checked); the tray item lets the user disable it.
    let clickthrough = CheckMenuItem::with_id(
        app,
        "clickthrough",
        "点击穿透透明区域",
        true,
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit workbuddy-buddy", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &buddy,
            &connect,
            &toggle,
            &clickthrough,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id("wb-buddy-tray")
        .tooltip("workbuddy-buddy")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "clickthrough" => {
                let on = ux::toggle(app);
                let _ = clickthrough.set_checked(on);
            }
            "buddy" => {
                if let Some(win) = app.get_webview_window("pet") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
                let _ = app.emit("open-picker", ());
            }
            "connect" => {
                if let Some(win) = app.get_webview_window("pet") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
                let _ = app.emit("open-connect", ());
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
