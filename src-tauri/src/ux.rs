//! UX polish: transparent-area click-through + safe window placement.
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
//! **Position.** The pet's last position is saved to
//! `~/.workbuddy-buddy/window.json`. Restores are clamped to the monitor work
//! area, so the whole window stays clear of the menu bar and Dock. Interactive
//! panels temporarily move to the center of the current work area, then restore
//! the pet to its previous position when they close.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{
    AppHandle, Listener, Manager, Monitor, PhysicalPosition, PhysicalSize, Position, WebviewWindow,
    WindowEvent,
};

const POLL_MS: u64 = 50;
const SAFE_MARGIN_LOGICAL: f64 = 16.0;

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

struct WindowPlacement {
    panel_open: AtomicBool,
    pet_position: Mutex<Option<(i32, i32)>>,
}

impl WindowPlacement {
    fn new(saved_position: Option<(i32, i32)>) -> Self {
        Self {
            panel_open: AtomicBool::new(false),
            pet_position: Mutex::new(saved_position),
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

    // ---- restore and repair the saved pet position ----
    let placement = Arc::new(WindowPlacement::new(load_pos()));
    restore_pet_position(&win, &placement);

    // ---- remember position: record moves, coalesced-flushed by the poll loop ----
    let pending: Arc<Mutex<Option<(i32, i32)>>> = Arc::new(Mutex::new(None));
    {
        let pending = pending.clone();
        let placement = placement.clone();
        win.on_window_event(move |e| {
            if let WindowEvent::Moved(p) = e {
                if !placement.panel_open.load(Ordering::Relaxed) {
                    let position = (p.x, p.y);
                    *placement.pet_position.lock().unwrap() = Some(position);
                    *pending.lock().unwrap() = Some(position);
                }
            }
        });
    }

    // ---- interactive panels use a safe, centered temporary position ----
    {
        let placement = placement.clone();
        let panel_win = win.clone();
        app.listen_any("window-panel-mode", move |event| {
            let open = serde_json::from_str::<serde_json::Value>(event.payload())
                .ok()
                .and_then(|value| value.get("open").and_then(|open| open.as_bool()))
                .unwrap_or(false);
            if open {
                enter_panel_mode(&panel_win, &placement);
            } else {
                restore_pet_position(&panel_win, &placement);
            }
        });
    }
    app.manage(placement.clone());

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

/// Bring the complete window back inside a connected monitor's work area.
/// Used before showing the pet from a tray action or a deep link.
pub fn ensure_visible(app: &AppHandle) {
    let Some(win) = app.get_webview_window("pet") else {
        return;
    };
    let Ok(position) = win.outer_position() else {
        center_fallback(&win);
        return;
    };
    if let Some(safe) = clamped_window_position(&win, (position.x, position.y)) {
        set_physical_position(&win, safe);
    } else {
        center_fallback(&win);
    }
}

/// Recovery action exposed in the tray for a window that is hard to reach.
pub fn center_on_current_screen(app: &AppHandle) {
    let Some(win) = app.get_webview_window("pet") else {
        return;
    };
    if let Some(position) = centered_window_position(&win) {
        set_physical_position(&win, position);
        if let Some(placement) = app.try_state::<Arc<WindowPlacement>>() {
            if !placement.panel_open.load(Ordering::Relaxed) {
                *placement.pet_position.lock().unwrap() = Some(position);
                save_pos(position.0, position.1);
            }
        }
    } else {
        center_fallback(&win);
    }
}

fn cursor_outside_sprite(win: &WebviewWindow, ct: &ClickThrough) -> bool {
    let rect = match *ct.rect.lock().unwrap() {
        Some(r) => r,
        None => return false, // no silhouette yet → stay interactive
    };
    match (
        win.cursor_position(),
        win.outer_position(),
        win.scale_factor(),
    ) {
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
    Some(
        PathBuf::from(home)
            .join(".workbuddy-buddy")
            .join("window.json"),
    )
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

fn enter_panel_mode(win: &WebviewWindow, placement: &WindowPlacement) {
    if placement.panel_open.swap(true, Ordering::Relaxed) {
        return;
    }

    if let Ok(position) = win.outer_position() {
        let position = (position.x, position.y);
        *placement.pet_position.lock().unwrap() = Some(position);
        save_pos(position.0, position.1);
    }

    if let Some(position) = centered_window_position(win) {
        set_physical_position(win, position);
    } else {
        center_fallback(win);
    }
}

fn restore_pet_position(win: &WebviewWindow, placement: &WindowPlacement) {
    placement.panel_open.store(false, Ordering::Relaxed);
    let saved = *placement.pet_position.lock().unwrap();
    let position = saved
        .and_then(|position| clamped_window_position(win, position))
        .or_else(|| default_pet_position(win));

    if let Some(position) = position {
        *placement.pet_position.lock().unwrap() = Some(position);
        set_physical_position(win, position);
        save_pos(position.0, position.1);
    } else {
        center_fallback(win);
    }
}

fn set_physical_position(win: &WebviewWindow, position: (i32, i32)) {
    let _ = win.set_position(Position::Physical(PhysicalPosition::new(
        position.0, position.1,
    )));
}

fn center_fallback(win: &WebviewWindow) {
    let _ = win.center();
}

#[derive(Clone, Copy, Debug)]
struct WorkArea {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale_factor: f64,
}

#[derive(Clone, Copy, Debug)]
struct LogicalWindowSize {
    width: f64,
    height: f64,
}

impl WorkArea {
    fn from_monitor(monitor: &Monitor) -> Self {
        let work_area = monitor.work_area();
        Self {
            x: work_area.position.x,
            y: work_area.position.y,
            width: work_area.size.width,
            height: work_area.size.height,
            scale_factor: monitor.scale_factor(),
        }
    }
}

fn clamped_window_position(win: &WebviewWindow, desired: (i32, i32)) -> Option<(i32, i32)> {
    let logical_size = logical_window_size(win)?;
    let areas = available_work_areas(win);
    let (area, target_size) = select_work_area(&areas, desired, logical_size)?;
    Some(clamp_to_work_area(
        desired,
        target_size,
        area,
        physical_margin(area.scale_factor),
    ))
}

fn centered_window_position(win: &WebviewWindow) -> Option<(i32, i32)> {
    let logical_size = logical_window_size(win)?;
    let current = win.outer_position().ok().map(|p| (p.x, p.y))?;
    let current_area = win
        .current_monitor()
        .ok()
        .flatten()
        .map(|monitor| WorkArea::from_monitor(&monitor));
    let areas = available_work_areas(win);
    let (area, target_size) = current_area
        .map(|area| {
            let target_size = physical_window_size(logical_size, area.scale_factor);
            (area, target_size)
        })
        .or_else(|| select_work_area(&areas, current, logical_size))?;
    Some(center_in_work_area(
        target_size,
        area,
        physical_margin(area.scale_factor),
    ))
}

fn default_pet_position(win: &WebviewWindow) -> Option<(i32, i32)> {
    let logical_size = logical_window_size(win)?;
    let area = win
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| WorkArea::from_monitor(&monitor))
        .or_else(|| available_work_areas(win).into_iter().next())?;
    let target_size = physical_window_size(logical_size, area.scale_factor);
    Some(bottom_right_in_work_area(
        target_size,
        area,
        physical_margin(area.scale_factor),
    ))
}

fn logical_window_size(win: &WebviewWindow) -> Option<LogicalWindowSize> {
    let physical = win.outer_size().ok()?;
    let scale_factor = normalized_scale_factor(win.scale_factor().ok()?);
    Some(LogicalWindowSize {
        width: f64::from(physical.width) / scale_factor,
        height: f64::from(physical.height) / scale_factor,
    })
}

fn available_work_areas(win: &WebviewWindow) -> Vec<WorkArea> {
    win.available_monitors()
        .map(|monitors| {
            monitors
                .iter()
                .map(WorkArea::from_monitor)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn physical_margin(scale_factor: f64) -> i32 {
    (SAFE_MARGIN_LOGICAL * normalized_scale_factor(scale_factor).max(1.0)).round() as i32
}

fn normalized_scale_factor(scale_factor: f64) -> f64 {
    if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    }
}

fn physical_window_size(logical_size: LogicalWindowSize, scale_factor: f64) -> PhysicalSize<u32> {
    let scale_factor = normalized_scale_factor(scale_factor);
    PhysicalSize::new(
        rounded_physical_span(logical_size.width * scale_factor),
        rounded_physical_span(logical_size.height * scale_factor),
    )
}

fn rounded_physical_span(value: f64) -> u32 {
    if !value.is_finite() {
        return 1;
    }
    value.round().clamp(1.0, f64::from(u32::MAX)) as u32
}

fn select_work_area(
    areas: &[WorkArea],
    position: (i32, i32),
    logical_size: LogicalWindowSize,
) -> Option<(WorkArea, PhysicalSize<u32>)> {
    let mut best: Option<(WorkArea, PhysicalSize<u32>, u64, i128)> = None;
    for area in areas.iter().copied() {
        let target_size = physical_window_size(logical_size, area.scale_factor);
        let overlap = overlap_area(position, target_size, area);
        let distance = center_distance_squared(position, target_size, area);
        let replace = match best {
            None => true,
            Some((_, _, best_overlap, best_distance)) => {
                overlap > best_overlap || (overlap == best_overlap && distance < best_distance)
            }
        };
        if replace {
            best = Some((area, target_size, overlap, distance));
        }
    }
    best.map(|(area, target_size, _, _)| (area, target_size))
}

fn overlap_area(position: (i32, i32), size: PhysicalSize<u32>, area: WorkArea) -> u64 {
    let left = i64::from(position.0).max(i64::from(area.x));
    let top = i64::from(position.1).max(i64::from(area.y));
    let right = (i64::from(position.0) + i64::from(size.width))
        .min(i64::from(area.x) + i64::from(area.width));
    let bottom = (i64::from(position.1) + i64::from(size.height))
        .min(i64::from(area.y) + i64::from(area.height));
    if right <= left || bottom <= top {
        0
    } else {
        ((right - left) * (bottom - top)) as u64
    }
}

fn center_distance_squared(position: (i32, i32), size: PhysicalSize<u32>, area: WorkArea) -> i128 {
    let window_center_x = i128::from(position.0) * 2 + i128::from(size.width);
    let window_center_y = i128::from(position.1) * 2 + i128::from(size.height);
    let area_center_x = i128::from(area.x) * 2 + i128::from(area.width);
    let area_center_y = i128::from(area.y) * 2 + i128::from(area.height);
    let dx = window_center_x - area_center_x;
    let dy = window_center_y - area_center_y;
    dx * dx + dy * dy
}

fn clamp_to_work_area(
    position: (i32, i32),
    size: PhysicalSize<u32>,
    area: WorkArea,
    margin: i32,
) -> (i32, i32) {
    (
        clamp_axis(position.0, area.x, area.width, size.width, margin),
        clamp_axis(position.1, area.y, area.height, size.height, margin),
    )
}

fn center_in_work_area(size: PhysicalSize<u32>, area: WorkArea, margin: i32) -> (i32, i32) {
    let x = i64::from(area.x) + (i64::from(area.width) - i64::from(size.width)) / 2;
    let y = i64::from(area.y) + (i64::from(area.height) - i64::from(size.height)) / 2;
    clamp_to_work_area((saturating_i32(x), saturating_i32(y)), size, area, margin)
}

fn bottom_right_in_work_area(size: PhysicalSize<u32>, area: WorkArea, margin: i32) -> (i32, i32) {
    let x = i64::from(area.x) + i64::from(area.width) - i64::from(size.width) - i64::from(margin);
    let y = i64::from(area.y) + i64::from(area.height) - i64::from(size.height) - i64::from(margin);
    clamp_to_work_area((saturating_i32(x), saturating_i32(y)), size, area, margin)
}

fn clamp_axis(position: i32, start: i32, span: u32, window_span: u32, margin: i32) -> i32 {
    let start = i64::from(start);
    let span = i64::from(span);
    let window_span = i64::from(window_span);
    let margin = i64::from(margin.max(0));
    let minimum = start + margin;
    let maximum = start + span - margin - window_span;

    if maximum >= minimum {
        saturating_i32(i64::from(position).clamp(minimum, maximum))
    } else {
        // A window larger than the available area cannot be fully contained.
        // Anchor its leading edge so the title/drag controls stay reachable.
        let leading_margin = margin.min(span.max(1) - 1);
        saturating_i32(start + leading_margin)
    }
}

fn saturating_i32(value: i64) -> i32 {
    value.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

#[cfg(test)]
mod tests {
    use super::{
        bottom_right_in_work_area, center_in_work_area, clamp_to_work_area, physical_margin,
        physical_window_size, select_work_area, LogicalWindowSize, WorkArea,
    };
    use tauri::PhysicalSize;

    fn area(x: i32, y: i32, width: u32, height: u32, scale_factor: f64) -> WorkArea {
        WorkArea {
            x,
            y,
            width,
            height,
            scale_factor,
        }
    }

    #[test]
    fn repairs_the_reported_retina_bottom_right_position() {
        let work_area = area(0, 48, 3008, 1512, 2.0);
        let size = PhysicalSize::new(640, 840);
        let repaired = clamp_to_work_area(
            (2396, 1192),
            size,
            work_area,
            physical_margin(work_area.scale_factor),
        );

        assert_eq!(repaired, (2336, 688));
    }

    #[test]
    fn honors_nonzero_work_area_origins_for_menu_bar_and_left_dock() {
        let work_area = area(160, 48, 2848, 1512, 2.0);
        let size = PhysicalSize::new(640, 840);

        assert_eq!(clamp_to_work_area((0, 0), size, work_area, 32), (192, 80));
    }

    #[test]
    fn preserves_safe_negative_coordinates_on_a_left_hand_display() {
        let work_area = area(-1920, 24, 1920, 1056, 1.0);
        let size = PhysicalSize::new(320, 420);

        assert_eq!(
            clamp_to_work_area((-1800, 500), size, work_area, 16),
            (-1800, 500)
        );
    }

    #[test]
    fn selects_the_display_with_the_largest_window_overlap() {
        let areas = [area(-1920, 0, 1920, 1080, 1.0), area(0, 0, 2560, 1400, 2.0)];
        let logical_size = LogicalWindowSize {
            width: 320.0,
            height: 420.0,
        };
        let (selected, target_size) = select_work_area(&areas, (-100, 200), logical_size).unwrap();

        assert_eq!(selected.x, 0);
        assert_eq!(selected.width, 2560);
        assert_eq!(target_size, PhysicalSize::new(640, 840));
    }

    #[test]
    fn rescales_the_window_before_clamping_to_a_mixed_dpi_target() {
        let logical_size = LogicalWindowSize {
            width: 320.0,
            height: 420.0,
        };
        let target = area(1920, 48, 3008, 1512, 2.0);
        let target_size = physical_window_size(logical_size, target.scale_factor);

        assert_eq!(target_size, PhysicalSize::new(640, 840));
        assert_eq!(
            clamp_to_work_area((4800, 1300), target_size, target, 32),
            (4256, 688)
        );
    }

    #[test]
    fn centers_panels_and_insets_the_default_pet() {
        let work_area = area(100, 50, 1200, 900, 1.0);
        let size = PhysicalSize::new(320, 420);

        assert_eq!(center_in_work_area(size, work_area, 16), (540, 290));
        assert_eq!(bottom_right_in_work_area(size, work_area, 16), (964, 514));
    }

    #[test]
    fn oversized_windows_are_centered_without_panicking() {
        let work_area = area(0, 24, 300, 200, 1.0);
        let size = PhysicalSize::new(500, 420);

        assert_eq!(
            clamp_to_work_area((9999, 9999), size, work_area, 16),
            (16, 40)
        );
    }
}
