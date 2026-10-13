//! System-tray icon and menu. The icon colour and tooltip always show whether tracking is on
//! (docs/architecture.md §9). Menu: status line, pause options / resume, open, quit.

use std::time::{SystemTime, UNIX_EPOCH};

use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::app_state::AppState;
use crate::tracker::service::{TrackerCommand, TrackerState, TrackerStatus};
use crate::window_manager;

const TRAY_ID: &str = "studio-pulse";

const ICON_TRACKING: &[u8] = include_bytes!("../icons/tray/tracking.png");
const ICON_IDLE: &[u8] = include_bytes!("../icons/tray/idle.png");
const ICON_STANDBY: &[u8] = include_bytes!("../icons/tray/standby.png");
const ICON_PAUSED: &[u8] = include_bytes!("../icons/tray/paused.png");

/// Menu items whose text or enabled state follows the tracker status.
pub struct TrayState {
    tray: TrayIcon<Wry>,
    status: MenuItem<Wry>,
    pause_15: MenuItem<Wry>,
    pause_60: MenuItem<Wry>,
    pause_indefinitely: MenuItem<Wry>,
    resume: MenuItem<Wry>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn pause_for(app: &AppHandle, minutes: Option<i64>) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let until_ms = minutes.map(|m| now_ms() + m * 60_000);
    state
        .tracker
        .request(|reply| TrackerCommand::Pause { until_ms, reply });
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "pause-15" => pause_for(app, Some(15)),
        "pause-60" => pause_for(app, Some(60)),
        "pause-indefinitely" => pause_for(app, None),
        "resume" => {
            if let Some(state) = app.try_state::<AppState>() {
                state
                    .tracker
                    .request(|reply| TrackerCommand::Resume { reply });
            }
        }
        "open" => window_manager::show_main(app),
        "quit" => app.exit(0),
        _ => {}
    }
}

/// Build the tray icon. Called once during setup.
pub fn create(app: &AppHandle) -> tauri::Result<TrayState> {
    let status = MenuItem::with_id(app, "status", "Studio Pulse", false, None::<&str>)?;
    let pause_15 = MenuItem::with_id(app, "pause-15", "Pause for 15 minutes", true, None::<&str>)?;
    let pause_60 = MenuItem::with_id(app, "pause-60", "Pause for 1 hour", true, None::<&str>)?;
    let pause_indefinitely = MenuItem::with_id(
        app,
        "pause-indefinitely",
        "Pause until I resume",
        true,
        None::<&str>,
    )?;
    let resume = MenuItem::with_id(app, "resume", "Resume tracking", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Studio Pulse", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Studio Pulse", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &PredefinedMenuItem::separator(app)?,
            &pause_15,
            &pause_60,
            &pause_indefinitely,
            &resume,
            &PredefinedMenuItem::separator(app)?,
            &open,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(ICON_STANDBY)?)
        .tooltip("Studio Pulse")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                window_manager::toggle_indicator(tray.app_handle(), Some(rect));
            }
        })
        .build(app)?;

    Ok(TrayState {
        tray,
        status,
        pause_15,
        pause_60,
        pause_indefinitely,
        resume,
    })
}

/// Human description of the tracker state for the tooltip and the menu status line.
pub fn describe(status: &TrackerStatus) -> String {
    let app = status.current.as_ref().map(|c| c.application_name.as_str());
    match status.state {
        TrackerState::Tracking => format!("Tracking {}", app.unwrap_or("an application")),
        TrackerState::Idle => format!("Idle in {}", app.unwrap_or("an application")),
        TrackerState::Untracked => "Tracking on — no tracked app in focus".to_string(),
        TrackerState::Away => "Tracking on — session locked or away".to_string(),
        TrackerState::Paused => match &status.paused_until {
            Some(_) => "Paused for a while".to_string(),
            None => "Paused until you resume".to_string(),
        },
        TrackerState::Disabled => "Tracking is off".to_string(),
        TrackerState::NotStarted => "Not started — finish setup".to_string(),
        TrackerState::ClockBehind => "Waiting for the system clock".to_string(),
    }
}

fn icon_for(state: TrackerState) -> &'static [u8] {
    match state {
        TrackerState::Tracking => ICON_TRACKING,
        TrackerState::Idle => ICON_IDLE,
        TrackerState::Untracked | TrackerState::Away | TrackerState::ClockBehind => ICON_STANDBY,
        TrackerState::Paused | TrackerState::Disabled | TrackerState::NotStarted => ICON_PAUSED,
    }
}

/// Reflect a new tracker status in the tray. Safe to call from any thread.
pub fn update(app: &AppHandle, status: &TrackerStatus) {
    let status = status.clone();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(tray) = handle.try_state::<TrayState>() else {
            return;
        };
        let text = describe(&status);
        let _ = tray.tray.set_tooltip(Some(format!("Studio Pulse — {text}")));
        let _ = tray.status.set_text(&text);
        match Image::from_bytes(icon_for(status.state)) {
            Ok(icon) => {
                let _ = tray.tray.set_icon(Some(icon));
            }
            Err(err) => log::warn!("tray icon decode failed: {err}"),
        }
        let can_pause = matches!(
            status.state,
            TrackerState::Tracking
                | TrackerState::Idle
                | TrackerState::Untracked
                | TrackerState::Away
                | TrackerState::ClockBehind
        );
        let paused = status.state == TrackerState::Paused;
        let _ = tray.pause_15.set_enabled(can_pause || paused);
        let _ = tray.pause_60.set_enabled(can_pause || paused);
        let _ = tray.pause_indefinitely.set_enabled(can_pause || paused);
        let _ = tray.resume.set_enabled(paused);
    });
}
