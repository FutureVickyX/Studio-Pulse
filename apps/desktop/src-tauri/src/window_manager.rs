//! Main and indicator windows: startup view, show/hide, tray anchoring, close-to-tray.
//! docs/architecture.md §8 rule 6 and §9.

use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Rect, Runtime, Theme, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::settings::{Settings, ThemePreference};

pub const MAIN: &str = "main";
pub const INDICATOR: &str = "indicator";

const INDICATOR_WIDTH: f64 = 320.0;
const INDICATOR_HEIGHT: f64 = 204.0;
/// Gap between the indicator and the taskbar / screen edge, in logical pixels.
const EDGE_GAP: f64 = 12.0;
/// A tray click this soon after the indicator hid itself on blur is the same gesture: pressing
/// the tray icon took focus away from the indicator. Treat it as "close", not "open again".
const BLUR_CLICK_WINDOW: Duration = Duration::from_millis(400);

/// When the indicator last hid itself because it lost focus.
static LAST_BLUR_HIDE: Mutex<Option<Instant>> = Mutex::new(None);

fn hidden_by_blur_just_now() -> bool {
    LAST_BLUR_HIDE
        .lock()
        .map(|last| last.is_some_and(|at| at.elapsed() < BLUR_CLICK_WINDOW))
        .unwrap_or(false)
}

/// Which window to show when the process starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartupView {
    TrayOnly,
    Indicator,
    Main,
}

/// Decide the first view: onboarding always shows the main window; manual launches show the main
/// window; sign-in launches honour Start minimized / Launch full window on startup.
pub fn startup_view(settings: &Settings, launched_at_login: bool) -> StartupView {
    if !settings.onboarding.completed || !launched_at_login {
        StartupView::Main
    } else if settings.general.start_minimized {
        StartupView::TrayOnly
    } else if settings.general.launch_full_window_on_startup {
        StartupView::Main
    } else {
        StartupView::Indicator
    }
}

pub fn apply_startup_view<R: Runtime>(app: &AppHandle<R>, view: StartupView) {
    match view {
        StartupView::TrayOnly => {}
        StartupView::Main => show_main(app),
        StartupView::Indicator => show_indicator(app, None),
    }
}

pub fn theme_for(preference: ThemePreference) -> Option<Theme> {
    match preference {
        ThemePreference::Dark => Some(Theme::Dark),
        ThemePreference::Light => Some(Theme::Light),
        ThemePreference::System => None,
    }
}

/// Apply the native frame theme (title bar) to every window.
pub fn apply_theme<R: Runtime>(app: &AppHandle<R>, preference: ThemePreference) {
    let theme = theme_for(preference);
    for window in app.webview_windows().values() {
        if let Err(err) = window.set_theme(theme) {
            log::debug!("could not set window theme: {err}");
        }
    }
}

pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN) else {
        log::error!("main window missing");
        return;
    };
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    let _ = window.show();
    let _ = window.set_focus();
    hide_indicator(app);
}

pub fn hide_indicator<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(INDICATOR) {
        let _ = window.hide();
    }
}

/// Left-click on the tray icon: toggle the compact indicator above the icon.
pub fn toggle_indicator<R: Runtime>(app: &AppHandle<R>, anchor: Option<Rect>) {
    if let Some(window) = app.get_webview_window(INDICATOR) {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
            return;
        }
        // Pressing the tray icon blurred (and so hid) the indicator before this click arrived.
        if hidden_by_blur_just_now() {
            return;
        }
    }
    show_indicator(app, anchor);
}

fn indicator_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    if let Some(window) = app.get_webview_window(INDICATOR) {
        return Some(window);
    }
    let theme = app
        .try_state::<crate::app_state::AppState>()
        .and_then(|state| theme_for(state.settings().general.theme));
    let built = WebviewWindowBuilder::new(app, INDICATOR, WebviewUrl::App("index.html".into()))
        .title("Studio Pulse")
        .inner_size(INDICATOR_WIDTH, INDICATOR_HEIGHT)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(true)
        .visible(false)
        .focused(true)
        .theme(theme)
        .background_color(tauri::window::Color(11, 11, 15, 255))
        .build();
    match built {
        Ok(window) => {
            let handle = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::Focused(false) = event {
                    if let Ok(mut last) = LAST_BLUR_HIDE.lock() {
                        *last = Some(Instant::now());
                    }
                    let _ = handle.hide();
                }
            });
            Some(window)
        }
        Err(err) => {
            log::error!("could not create the indicator window: {err}");
            None
        }
    }
}

/// Show the indicator. With an anchor (tray icon rectangle) it sits just above the icon;
/// otherwise in the bottom-right corner of the primary monitor's work area.
pub fn show_indicator<R: Runtime>(app: &AppHandle<R>, anchor: Option<Rect>) {
    let Some(window) = indicator_window(app) else {
        return;
    };
    if let Some(position) = indicator_position(&window, anchor) {
        let _ = window.set_position(position);
    }
    let _ = window.show();
    let _ = window.set_focus();
}

fn indicator_position<R: Runtime>(
    window: &WebviewWindow<R>,
    anchor: Option<Rect>,
) -> Option<PhysicalPosition<i32>> {
    let monitor = match anchor {
        Some(rect) => {
            let p = rect.position.to_physical::<f64>(1.0);
            window.monitor_from_point(p.x, p.y).ok().flatten()
        }
        None => None,
    }
    .or_else(|| window.primary_monitor().ok().flatten())?;

    let scale = monitor.scale_factor();
    let size = PhysicalSize::new(
        (INDICATOR_WIDTH * scale).round() as i32,
        (INDICATOR_HEIGHT * scale).round() as i32,
    );
    let gap = (EDGE_GAP * scale).round() as i32;
    let work = monitor.work_area();
    let (wx, wy) = (work.position.x, work.position.y);
    let (ww, wh) = (work.size.width as i32, work.size.height as i32);

    let (mut x, mut y) = match anchor {
        Some(rect) => {
            let pos = rect.position.to_physical::<f64>(scale);
            let sz = rect.size.to_physical::<f64>(scale);
            let centre_x = (pos.x + sz.width / 2.0).round() as i32;
            // Above the icon when the taskbar is at the bottom; below it when at the top.
            let above = pos.y.round() as i32 - size.height - gap;
            let below = (pos.y + sz.height).round() as i32 + gap;
            let y = if above >= wy { above } else { below };
            (centre_x - size.width / 2, y)
        }
        None => (wx + ww - size.width - gap, wy + wh - size.height - gap),
    };
    x = x.clamp(wx + gap, (wx + ww - size.width - gap).max(wx));
    y = y.clamp(wy + gap, (wy + wh - size.height - gap).max(wy));
    Some(PhysicalPosition::new(x, y))
}

/// Main-window close/minimize behaviour. Registered once in `lib.rs`.
pub fn handle_main_window_event<R: Runtime>(window: &tauri::Window<R>, event: &WindowEvent) {
    if window.label() != MAIN {
        return;
    }
    let minimize_to_tray = window
        .app_handle()
        .try_state::<crate::app_state::AppState>()
        .map(|state| state.settings().general.minimize_to_tray)
        .unwrap_or(true);
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            if minimize_to_tray {
                api.prevent_close();
                let _ = window.hide();
            } else {
                // Closing quits; the tracker closes the open interval on exit.
                window.app_handle().exit(0);
            }
        }
        WindowEvent::Resized(_) if minimize_to_tray && window.is_minimized().unwrap_or(false) => {
            let _ = window.hide();
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(onboarded: bool, minimized: bool, full: bool) -> Settings {
        let mut s = Settings::default();
        s.onboarding.completed = onboarded;
        s.general.start_minimized = minimized;
        s.general.launch_full_window_on_startup = full;
        s
    }

    #[test]
    fn manual_launch_always_opens_main_window() {
        assert_eq!(
            startup_view(&settings(true, true, false), false),
            StartupView::Main
        );
    }

    #[test]
    fn onboarding_always_opens_main_window() {
        assert_eq!(
            startup_view(&settings(false, true, false), true),
            StartupView::Main
        );
    }

    #[test]
    fn login_launch_respects_start_minimized_and_full_window() {
        assert_eq!(
            startup_view(&settings(true, true, true), true),
            StartupView::TrayOnly
        );
        assert_eq!(
            startup_view(&settings(true, false, true), true),
            StartupView::Main
        );
        assert_eq!(
            startup_view(&settings(true, false, false), true),
            StartupView::Indicator
        );
    }
}
