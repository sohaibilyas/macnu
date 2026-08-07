use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    ffi::{c_char, CStr, CString},
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewWindow,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MenuIcon {
    window_id: u32,
    owner: String,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    image: String,
    #[serde(default)]
    activation_pid: Option<i32>,
    #[serde(default)]
    activation_bundle_id: Option<String>,
    #[serde(default)]
    activation_x: Option<f64>,
    #[serde(default)]
    activation_y: Option<f64>,
    #[serde(default)]
    activation_width: Option<f64>,
    #[serde(default)]
    activation_height: Option<f64>,
    #[serde(default)]
    activation_action: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivationRequest {
    window_id: u32,
    owner: String,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    activation_pid: Option<i32>,
    activation_bundle_id: Option<String>,
    activation_x: Option<f64>,
    activation_y: Option<f64>,
    activation_width: Option<f64>,
    activation_height: Option<f64>,
    activation_action: Option<String>,
}

impl From<MenuIcon> for ActivationRequest {
    fn from(icon: MenuIcon) -> Self {
        Self {
            window_id: icon.window_id,
            owner: icon.owner,
            label: icon.label,
            x: icon.x,
            y: icon.y,
            width: icon.width,
            height: icon.height,
            activation_pid: icon.activation_pid,
            activation_bundle_id: icon.activation_bundle_id,
            activation_x: icon.activation_x,
            activation_y: icon.activation_y,
            activation_width: icon.activation_width,
            activation_height: icon.activation_height,
            activation_action: icon.activation_action,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MenuResponse {
    icons: Vec<MenuIcon>,
    display_id: u32,
    screen_capture_denied: bool,
    accessibility_denied: bool,
    error: Option<String>,
}

#[derive(Clone, Default)]
struct MenuCache {
    responses: Arc<Mutex<HashMap<u32, MenuResponse>>>,
    capture_lock: Arc<Mutex<()>>,
}

const DEFAULT_SHORTCUT: &str = "Command+Semicolon";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    shortcut: String,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            shortcut: DEFAULT_SHORTCUT.to_string(),
        }
    }
}

#[derive(Clone)]
struct PreferencesState {
    preferences: Arc<Mutex<Preferences>>,
    path: PathBuf,
}

#[derive(Clone, Default)]
struct PresentationState {
    suppress_reopen: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsResponse {
    shortcut: String,
    start_at_login_status: i32,
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn macnu_copy_menu_icons_json() -> *mut c_char;
    fn macnu_free_native_string(pointer: *mut c_char);
    fn macnu_active_display_id() -> u32;
    fn macnu_request_screen_capture() -> bool;
    fn macnu_request_accessibility() -> bool;
    fn macnu_start_at_login_status() -> i32;
    fn macnu_set_start_at_login(enabled: bool) -> i32;
    fn macnu_open_login_items_settings();
    fn macnu_activate_application();
    fn macnu_activate_menu_icon_json(request_json: *const c_char) -> i32;
}

#[cfg(target_os = "macos")]
fn copy_native_menu_icons() -> Result<MenuResponse, String> {
    let pointer = unsafe { macnu_copy_menu_icons_json() };
    if pointer.is_null() {
        return Err("The native menu capture returned no data.".to_string());
    }

    let json = unsafe { CStr::from_ptr(pointer) }
        .to_string_lossy()
        .into_owned();
    unsafe { macnu_free_native_string(pointer) };

    serde_json::from_str(&json)
        .map_err(|error| format!("Could not decode native menu icons: {error}"))
}

fn refresh_menu_cache(cache: &MenuCache) -> Result<MenuResponse, String> {
    let _capture_guard = cache
        .capture_lock
        .lock()
        .map_err(|_| "The menu capture lock is unavailable.".to_string())?;
    let response = copy_native_menu_icons()?;

    if !response.screen_capture_denied && !response.accessibility_denied && response.error.is_none()
    {
        cache
            .responses
            .lock()
            .map_err(|_| "The menu cache is unavailable.".to_string())?
            .insert(response.display_id, response.clone());
    }

    Ok(response)
}

#[tauri::command]
async fn list_menu_icons(cache: State<'_, MenuCache>) -> Result<MenuResponse, String> {
    #[cfg(target_os = "macos")]
    {
        let cache = cache.inner().clone();
        return tauri::async_runtime::spawn_blocking(move || refresh_menu_cache(&cache))
            .await
            .map_err(|error| format!("Menu capture task failed: {error}"))?;
    }

    #[cfg(not(target_os = "macos"))]
    Err("Macnu only supports macOS.".to_string())
}

#[tauri::command]
fn cached_menu_icons(
    display_id: u32,
    cache: State<'_, MenuCache>,
) -> Result<Option<MenuResponse>, String> {
    cache
        .responses
        .lock()
        .map_err(|_| "The menu cache is unavailable.".to_string())
        .map(|responses| responses.get(&display_id).cloned())
}

#[tauri::command]
fn active_display_id() -> Result<u32, String> {
    #[cfg(target_os = "macos")]
    {
        return Ok(unsafe { macnu_active_display_id() });
    }

    #[cfg(not(target_os = "macos"))]
    Err("Macnu only supports macOS.".to_string())
}

#[tauri::command]
async fn activate_menu_icon(icon: MenuIcon) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return tauri::async_runtime::spawn_blocking(move || {
            let request = ActivationRequest::from(icon);
            let request_json = serde_json::to_string(&request).map_err(|error| {
                format!("Could not encode the activation catalog entry: {error}")
            })?;
            let request_json = CString::new(request_json)
                .map_err(|_| "The activation catalog entry contains invalid text.".to_string())?;
            match unsafe { macnu_activate_menu_icon_json(request_json.as_ptr()) } {
                0 => Ok(()),
                1 => Err("That menu item is no longer available.".to_string()),
                2 => Err("Accessibility permission is required to open menu items.".to_string()),
                _ => Err("macOS could not activate that menu item.".to_string()),
            }
        })
        .await
        .map_err(|error| format!("Menu activation task failed: {error}"))?;
    }

    #[cfg(not(target_os = "macos"))]
    Err("Macnu only supports macOS.".to_string())
}

#[tauri::command]
fn request_permission(kind: String) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let granted = match kind.as_str() {
            "screen" => unsafe { macnu_request_screen_capture() },
            "accessibility" => unsafe { macnu_request_accessibility() },
            _ => return Err("Unknown permission type.".to_string()),
        };
        return Ok(granted);
    }

    #[cfg(not(target_os = "macos"))]
    Err("Macnu only supports macOS.".to_string())
}

#[tauri::command]
fn open_privacy_settings(kind: String) -> Result<(), String> {
    let destination = match kind.as_str() {
        "screen" => "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        "accessibility" => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        }
        _ => return Err("Unknown privacy settings destination.".to_string()),
    };

    std::process::Command::new("open")
        .arg(destination)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open System Settings: {error}"))
}

fn load_preferences(path: &PathBuf) -> Preferences {
    fs::read_to_string(path)
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn persist_preferences(state: &PreferencesState, preferences: &Preferences) -> Result<(), String> {
    let parent = state
        .path
        .parent()
        .ok_or_else(|| "The settings directory is unavailable.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create the settings directory: {error}"))?;
    let json = serde_json::to_vec_pretty(preferences)
        .map_err(|error| format!("Could not encode settings: {error}"))?;
    let temporary = state.path.with_extension("json.tmp");
    fs::write(&temporary, json).map_err(|error| format!("Could not write settings: {error}"))?;
    fs::rename(&temporary, &state.path).map_err(|error| format!("Could not save settings: {error}"))
}

fn current_settings(state: &PreferencesState) -> Result<SettingsResponse, String> {
    let shortcut = state
        .preferences
        .lock()
        .map_err(|_| "The settings are unavailable.".to_string())?
        .shortcut
        .clone();
    Ok(SettingsResponse {
        shortcut,
        start_at_login_status: unsafe { macnu_start_at_login_status() },
    })
}

#[tauri::command]
fn get_settings(state: State<'_, PreferencesState>) -> Result<SettingsResponse, String> {
    current_settings(state.inner())
}

#[tauri::command]
fn update_shortcut(
    app: AppHandle,
    shortcut: String,
    state: State<'_, PreferencesState>,
) -> Result<SettingsResponse, String> {
    let shortcut = shortcut.trim().to_string();
    if shortcut.split('+').count() < 2 {
        return Err("Use at least one modifier key in the shortcut.".to_string());
    }
    let _: Shortcut = shortcut
        .parse()
        .map_err(|error| format!("That shortcut is not supported: {error}"))?;

    let current = state
        .preferences
        .lock()
        .map_err(|_| "The settings are unavailable.".to_string())?
        .shortcut
        .clone();
    if current.eq_ignore_ascii_case(&shortcut) {
        return current_settings(state.inner());
    }

    app.global_shortcut()
        .unregister(current.as_str())
        .map_err(|error| format!("Could not release the current shortcut: {error}"))?;
    if let Err(error) = app.global_shortcut().register(shortcut.as_str()) {
        let _ = app.global_shortcut().register(current.as_str());
        return Err(format!(
            "That shortcut is already in use or unavailable: {error}"
        ));
    }

    let updated = Preferences {
        shortcut: shortcut.clone(),
    };
    if let Err(error) = persist_preferences(state.inner(), &updated) {
        let _ = app.global_shortcut().unregister(shortcut.as_str());
        let _ = app.global_shortcut().register(current.as_str());
        return Err(error);
    }
    *state
        .preferences
        .lock()
        .map_err(|_| "The settings are unavailable.".to_string())? = updated;
    if let Some(tray) = app.tray_by_id("macnu") {
        let _ = tray.set_tooltip(Some(format!("Macnu — {shortcut}")));
    }
    let _ = app.emit("shortcut-changed", shortcut);
    current_settings(state.inner())
}

#[tauri::command]
fn set_start_at_login(
    enabled: bool,
    state: State<'_, PreferencesState>,
) -> Result<SettingsResponse, String> {
    let status = unsafe { macnu_set_start_at_login(enabled) };
    if status < 0 {
        return Err("macOS could not update Start at Login for this app bundle.".to_string());
    }
    current_settings(state.inner())
}

#[tauri::command]
fn open_login_items_settings() {
    unsafe { macnu_open_login_items_settings() };
}

fn position_palette(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let primary_monitor = window.primary_monitor()?;
    let pointer_monitor = match (window.cursor_position(), primary_monitor.as_ref()) {
        (Ok(position), Some(primary)) => {
            // On macOS tao reports a physical cursor position scaled by the
            // primary display, while monitor_from_point expects global Quartz
            // coordinates. Convert it back before selecting the display.
            let logical = position.to_logical::<f64>(primary.scale_factor());
            window.monitor_from_point(logical.x, logical.y)?
        }
        _ => None,
    };
    let monitor = pointer_monitor
        .or(window.current_monitor()?)
        .or(primary_monitor);

    if let Some(monitor) = monitor {
        let monitor_size = monitor.size();
        let window_size = window.outer_size()?;
        let x = monitor.position().x
            + ((monitor_size.width.saturating_sub(window_size.width)) / 2) as i32;
        let y = monitor.position().y + 58;
        window.set_position(PhysicalPosition::new(x, y))?;
    }
    Ok(())
}

fn position_settings(window: &WebviewWindow) -> tauri::Result<()> {
    let primary_monitor = window.primary_monitor()?;
    let pointer_monitor = match (window.cursor_position(), primary_monitor.as_ref()) {
        (Ok(position), Some(primary)) => {
            let logical = position.to_logical::<f64>(primary.scale_factor());
            window.monitor_from_point(logical.x, logical.y)?
        }
        _ => None,
    };
    let monitor = pointer_monitor
        .or(window.current_monitor()?)
        .or(primary_monitor);

    if let Some(monitor) = monitor {
        let monitor_size = monitor.size();
        let window_size = window.outer_size()?;
        let x = monitor.position().x
            + ((monitor_size.width.saturating_sub(window_size.width)) / 2) as i32;
        let y = monitor.position().y
            + ((monitor_size.height.saturating_sub(window_size.height)) / 2) as i32;
        window.set_position(PhysicalPosition::new(x, y))?;
    }
    Ok(())
}

#[tauri::command]
fn open_settings(app: AppHandle) -> Result<(), String> {
    if let Some(palette) = app.get_webview_window("main") {
        let _ = palette.hide();
    }
    let window = app
        .get_webview_window("settings")
        .ok_or_else(|| "The Settings window is unavailable.".to_string())?;
    position_settings(&window).map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    let _ = window.emit("settings-opened", ());
    Ok(())
}

fn toggle_palette(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    if window.is_visible().unwrap_or(false) {
        if window.is_focused().unwrap_or(false) {
            let _ = window.hide();
            return;
        }
    }

    if let Some(settings) = app.get_webview_window("settings") {
        let _ = settings.hide();
    }

    let presentation = app.state::<PresentationState>();
    presentation.suppress_reopen.store(true, Ordering::SeqCst);
    let suppression = presentation.suppress_reopen.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(750));
        suppression.store(false, Ordering::SeqCst);
    });

    #[cfg(target_os = "macos")]
    unsafe {
        macnu_activate_application();
    }
    let _ = position_palette(&window);
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.emit("palette-opened", ());

    // Status-item apps can deliver a final focus transition after their popup
    // has visually closed. Reassert Macnu once that short animation window
    // has passed so a single shortcut press always leaves the palette active.
    let refocus_window = window.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(180));
        if refocus_window.is_visible().unwrap_or(false) {
            #[cfg(target_os = "macos")]
            unsafe {
                macnu_activate_application();
            }
            let _ = refocus_window.set_focus();
        }
    });
}

pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_palette(app);
                    }
                })
                .build(),
        )
        .on_window_event(|window, event| {
            if window.label() == "settings" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            app.manage(PresentationState::default());

            if let Some(window) = app.get_webview_window("main") {
                position_palette(&window)?;
            }

            let menu_cache = MenuCache::default();
            app.manage(menu_cache.clone());

            let preferences_path = app.path().app_config_dir()?.join("settings.json");
            let mut preferences = load_preferences(&preferences_path);
            if preferences.shortcut.parse::<Shortcut>().is_err() {
                preferences = Preferences::default();
            }
            let configured_shortcut = preferences.shortcut.clone();
            app.manage(PreferencesState {
                preferences: Arc::new(Mutex::new(preferences)),
                path: preferences_path,
            });

            #[cfg(target_os = "macos")]
            thread::Builder::new()
                .name("macnu-menu-cache".to_string())
                .spawn(move || loop {
                    let _ = refresh_menu_cache(&menu_cache);
                    thread::sleep(Duration::from_secs(10));
                })?;

            app.global_shortcut()
                .register(configured_shortcut.as_str())?;

            let tray_icon =
                tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;
            let tray_menu = MenuBuilder::new(app)
                .text("settings", "Settings…")
                .separator()
                .text("quit", "Quit Macnu")
                .build()?;
            TrayIconBuilder::with_id("macnu")
                .icon(tray_icon)
                .icon_as_template(true)
                .tooltip(format!("Macnu — {configured_shortcut}"))
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "settings" => {
                        let _ = open_settings(app.clone());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_palette(tray.app_handle());
                    }
                })
                .build(app)?;

            if !std::env::args().any(|argument| argument == "--background") {
                open_settings(app.handle().clone()).map_err(std::io::Error::other)?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_menu_icons,
            cached_menu_icons,
            active_display_id,
            activate_menu_icon,
            get_settings,
            update_shortcut,
            set_start_at_login,
            open_login_items_settings,
            open_settings,
            request_permission,
            open_privacy_settings
        ])
        .build(tauri::generate_context!())
        .expect("error while building Macnu")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                let presentation = app.state::<PresentationState>();
                if !presentation.suppress_reopen.load(Ordering::SeqCst) {
                    let _ = open_settings(app.clone());
                }
            }
        });
}
