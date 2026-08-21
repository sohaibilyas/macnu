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
    time::{Duration, Instant},
};
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewWindow,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
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
    activation_identifier: Option<String>,
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
    activation_identifier: Option<String>,
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
            activation_identifier: icon.activation_identifier,
            activation_x: icon.activation_x,
            activation_y: icon.activation_y,
            activation_width: icon.activation_width,
            activation_height: icon.activation_height,
            activation_action: icon.activation_action,
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct MenuResponse {
    icons: Vec<MenuIcon>,
    display_id: u32,
    screen_capture_denied: bool,
    accessibility_denied: bool,
    error: Option<String>,
}

#[derive(Clone)]
struct MenuCacheEntry {
    response: MenuResponse,
    refreshed_at: Instant,
    menu_signature: u64,
}

#[derive(Clone, Default)]
struct MenuCache {
    responses: Arc<Mutex<HashMap<u32, MenuCacheEntry>>>,
    capture_lock: Arc<Mutex<()>>,
}

impl MenuCache {
    fn clear(&self) -> Result<(), String> {
        // Match the refresh lock order so an in-flight capture must finish
        // before revocation removes every result it could have produced.
        let _capture_guard = self
            .capture_lock
            .lock()
            .map_err(|_| "The menu capture lock is unavailable.".to_string())?;
        self.responses
            .lock()
            .map_err(|_| "The menu cache is unavailable.".to_string())?
            .clear();
        Ok(())
    }
}

struct CacheRefresh {
    response: MenuResponse,
    changed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveDisplayCache {
    display_id: u32,
    response: Option<MenuResponse>,
    stale: bool,
}

const DEFAULT_SHORTCUT: &str = "Command+Semicolon";
const ACCESSIBILITY_REQUIRED_MESSAGE: &str = "Accessibility permission is required to use Macnu.";
const SETUP_REQUIRED_MESSAGE: &str = "Complete Macnu setup before using the menu search.";
// WindowServer signature changes invalidate immediately. The time limit is a
// low-frequency AX reconciliation for label/action changes that do not create
// or move a status window; it must not force an all-process scan every few
// seconds while Macnu is idle.
const MENU_CACHE_FRESHNESS: Duration = Duration::from_secs(30);
const BACKGROUND_DISPLAY_POLL_INTERVAL: Duration = Duration::from_secs(2);
const BACKGROUND_SIGNATURE_CHECK_INTERVAL: Duration = Duration::from_secs(10);
const PERMISSION_VISIBLE_POLL_INTERVAL: Duration = Duration::from_millis(750);
const PERMISSION_IDLE_POLL_INTERVAL: Duration = Duration::from_secs(10);

#[derive(Debug, Default)]
struct BackgroundCacheSchedule {
    active_display_id: Option<u32>,
    last_signature_check: Option<Instant>,
}

impl BackgroundCacheSchedule {
    fn should_check_signature(&mut self, display_id: u32, now: Instant) -> bool {
        let display_changed = self.active_display_id != Some(display_id);
        let interval_elapsed = self.last_signature_check.is_none_or(|last_check| {
            now.checked_duration_since(last_check)
                .is_some_and(|elapsed| elapsed >= BACKGROUND_SIGNATURE_CHECK_INTERVAL)
        });

        self.active_display_id = Some(display_id);
        if display_changed || interval_elapsed {
            self.last_signature_check = Some(now);
            true
        } else {
            false
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    shortcut: String,
    #[serde(default)]
    onboarding_completed: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            shortcut: DEFAULT_SHORTCUT.to_string(),
            onboarding_completed: false,
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
    onboarding_completed: bool,
    accessibility_granted: bool,
    screen_capture_granted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PermissionStatus {
    accessibility_granted: bool,
    screen_capture_granted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PaletteRoute {
    Palette,
    PermissionGate,
}

fn palette_route(status: PermissionStatus, onboarding_completed: bool) -> PaletteRoute {
    if status.accessibility_granted && onboarding_completed {
        PaletteRoute::Palette
    } else {
        PaletteRoute::PermissionGate
    }
}

fn onboarding_is_complete(app: &AppHandle) -> bool {
    app.state::<PreferencesState>()
        .preferences
        .lock()
        .map(|preferences| preferences.onboarding_completed)
        .unwrap_or(false)
}

fn require_ready(app: &AppHandle) -> Result<(), String> {
    require_accessibility()?;
    onboarding_is_complete(app)
        .then_some(())
        .ok_or_else(|| SETUP_REQUIRED_MESSAGE.to_string())
}

fn require_accessibility_status(status: PermissionStatus) -> Result<(), String> {
    if status.accessibility_granted {
        Ok(())
    } else {
        Err(ACCESSIBILITY_REQUIRED_MESSAGE.to_string())
    }
}

fn require_accessibility() -> Result<(), String> {
    require_accessibility_status(current_permission_status())
}

fn accessibility_was_revoked(previous: PermissionStatus, current: PermissionStatus) -> bool {
    previous.accessibility_granted && !current.accessibility_granted
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn macnu_copy_menu_icons_json() -> *mut c_char;
    fn macnu_free_native_string(pointer: *mut c_char);
    fn macnu_active_display_id() -> u32;
    fn macnu_active_menu_signature(display_id: u32) -> u64;
    fn macnu_screen_capture_granted() -> bool;
    fn macnu_accessibility_granted() -> bool;
    fn macnu_request_screen_capture() -> bool;
    fn macnu_request_accessibility() -> bool;
    fn macnu_reveal_app_in_finder() -> bool;
    fn macnu_start_at_login_status() -> i32;
    fn macnu_set_start_at_login(enabled: bool) -> i32;
    fn macnu_open_login_items_settings();
    fn macnu_activate_application();
    fn macnu_activate_menu_icon_json(request_json: *const c_char) -> i32;
}

#[cfg(target_os = "macos")]
fn current_permission_status() -> PermissionStatus {
    PermissionStatus {
        accessibility_granted: unsafe { macnu_accessibility_granted() },
        screen_capture_granted: unsafe { macnu_screen_capture_granted() },
    }
}

#[cfg(not(target_os = "macos"))]
fn current_permission_status() -> PermissionStatus {
    PermissionStatus {
        accessibility_granted: false,
        screen_capture_granted: false,
    }
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

fn fresh_cached_menu_icons(
    cache: &MenuCache,
    display_id: u32,
    menu_signature: u64,
) -> Result<Option<MenuResponse>, String> {
    cache
        .responses
        .lock()
        .map_err(|_| "The menu cache is unavailable.".to_string())
        .map(|responses| {
            responses.get(&display_id).and_then(|entry| {
                (entry.menu_signature == menu_signature
                    && entry.refreshed_at.elapsed() < MENU_CACHE_FRESHNESS)
                    .then(|| entry.response.clone())
            })
        })
}

fn response_is_cacheable(response: &MenuResponse) -> bool {
    !response.accessibility_denied && response.error.is_none()
}

fn refresh_menu_cache(cache: &MenuCache, force: bool) -> Result<CacheRefresh, String> {
    if let Err(error) = require_accessibility() {
        let _ = cache.clear();
        return Err(error);
    }

    let display_id = unsafe { macnu_active_display_id() };
    let menu_signature = unsafe { macnu_active_menu_signature(display_id) };
    if !force {
        if let Some(response) = fresh_cached_menu_icons(cache, display_id, menu_signature)? {
            return Ok(CacheRefresh {
                response,
                changed: false,
            });
        }
    }

    let _capture_guard = cache
        .capture_lock
        .lock()
        .map_err(|_| "The menu capture lock is unavailable.".to_string())?;

    // A background refresh may have completed while this caller waited for
    // the capture lock. Recheck so multiple callers never repeat the same
    // expensive ScreenCaptureKit work.
    let display_id = unsafe { macnu_active_display_id() };
    let menu_signature = unsafe { macnu_active_menu_signature(display_id) };
    if !force {
        if let Some(response) = fresh_cached_menu_icons(cache, display_id, menu_signature)? {
            return Ok(CacheRefresh {
                response,
                changed: false,
            });
        }
    }

    let response = copy_native_menu_icons()?;
    if let Err(error) = require_accessibility() {
        cache
            .responses
            .lock()
            .map_err(|_| "The menu cache is unavailable.".to_string())?
            .clear();
        return Err(error);
    }
    let menu_signature = unsafe { macnu_active_menu_signature(response.display_id) };
    let mut changed = true;

    // Accessibility provides the catalog identity and activation target.
    // Screen Recording only enriches entries with captured artwork, so a
    // successful AX catalog remains useful and should stay warm without it.
    if response_is_cacheable(&response) {
        let mut responses = cache
            .responses
            .lock()
            .map_err(|_| "The menu cache is unavailable.".to_string())?;
        changed = responses
            .get(&response.display_id)
            .is_none_or(|entry| entry.response != response);
        responses.insert(
            response.display_id,
            MenuCacheEntry {
                response: response.clone(),
                refreshed_at: Instant::now(),
                menu_signature,
            },
        );
    }

    Ok(CacheRefresh { response, changed })
}

#[tauri::command]
async fn list_menu_icons(
    app: AppHandle,
    force: bool,
    cache: State<'_, MenuCache>,
) -> Result<MenuResponse, String> {
    #[cfg(target_os = "macos")]
    {
        if let Err(error) = require_ready(&app) {
            let _ = cache.inner().clear();
            return Err(error);
        }
        let cache = cache.inner().clone();
        tauri::async_runtime::spawn_blocking(move || refresh_menu_cache(&cache, force))
            .await
            .map_err(|error| format!("Menu capture task failed: {error}"))?
            .map(|refresh| refresh.response)
    }

    #[cfg(not(target_os = "macos"))]
    Err("Macnu only supports macOS.".to_string())
}

#[tauri::command]
fn active_display_menu_icons(
    app: AppHandle,
    cache: State<'_, MenuCache>,
) -> Result<ActiveDisplayCache, String> {
    if let Err(error) = require_ready(&app) {
        let _ = cache.inner().clear();
        return Err(error);
    }
    let display_id = unsafe { macnu_active_display_id() };
    let menu_signature = unsafe { macnu_active_menu_signature(display_id) };
    let (response, stale) = cache
        .responses
        .lock()
        .map_err(|_| "The menu cache is unavailable.".to_string())
        .map(|responses| {
            let entry = responses.get(&display_id);
            (
                entry.map(|cached| cached.response.clone()),
                entry.is_some_and(|cached| {
                    cached.menu_signature != menu_signature
                        || cached.refreshed_at.elapsed() >= MENU_CACHE_FRESHNESS
                }),
            )
        })?;
    Ok(ActiveDisplayCache {
        display_id,
        response,
        stale,
    })
}

#[tauri::command]
async fn activate_menu_icon(app: AppHandle, icon: MenuIcon) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        require_ready(&app)?;
        let activation_app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            require_ready(&activation_app)?;
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
        .map_err(|error| format!("Menu activation task failed: {error}"))?
    }

    #[cfg(not(target_os = "macos"))]
    Err("Macnu only supports macOS.".to_string())
}

#[tauri::command]
fn get_permission_status() -> PermissionStatus {
    current_permission_status()
}

#[tauri::command]
fn request_permission(app: AppHandle, kind: String) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let granted = match kind.as_str() {
            "screen" => unsafe { macnu_request_screen_capture() },
            "accessibility" => unsafe { macnu_request_accessibility() },
            _ => return Err("Unknown permission type.".to_string()),
        };
        let _ = app.emit("permission-status-changed", current_permission_status());
        Ok(granted)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        let _ = kind;
        Err("Macnu only supports macOS.".to_string())
    }
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

#[tauri::command]
fn reveal_app_in_finder() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if unsafe { macnu_reveal_app_in_finder() } {
            Ok(())
        } else {
            Err("Macnu is not currently running from an application bundle.".to_string())
        }
    }

    #[cfg(not(target_os = "macos"))]
    Err("Macnu only supports macOS.".to_string())
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
    let preferences = state
        .preferences
        .lock()
        .map_err(|_| "The settings are unavailable.".to_string())?
        .clone();
    let permissions = current_permission_status();
    Ok(SettingsResponse {
        shortcut: preferences.shortcut,
        start_at_login_status: unsafe { macnu_start_at_login_status() },
        onboarding_completed: preferences.onboarding_completed,
        accessibility_granted: permissions.accessibility_granted,
        screen_capture_granted: permissions.screen_capture_granted,
    })
}

#[tauri::command]
fn get_settings(state: State<'_, PreferencesState>) -> Result<SettingsResponse, String> {
    current_settings(state.inner())
}

#[tauri::command]
fn complete_onboarding(
    app: AppHandle,
    state: State<'_, PreferencesState>,
) -> Result<SettingsResponse, String> {
    if !current_permission_status().accessibility_granted {
        return Err("Accessibility permission is required before setup can finish.".to_string());
    }

    let mut preferences = state
        .preferences
        .lock()
        .map_err(|_| "The settings are unavailable.".to_string())?;
    if !preferences.onboarding_completed {
        let mut updated = preferences.clone();
        updated.onboarding_completed = true;
        persist_preferences(state.inner(), &updated)?;
        *preferences = updated;
    }
    drop(preferences);
    let settings = current_settings(state.inner())?;
    toggle_palette(&app);
    Ok(settings)
}

#[tauri::command]
fn reset_onboarding(state: State<'_, PreferencesState>) -> Result<SettingsResponse, String> {
    let mut preferences = state
        .preferences
        .lock()
        .map_err(|_| "The settings are unavailable.".to_string())?;
    if preferences.onboarding_completed {
        let mut updated = preferences.clone();
        updated.onboarding_completed = false;
        persist_preferences(state.inner(), &updated)?;
        *preferences = updated;
    }
    drop(preferences);
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

    let current_preferences = state
        .preferences
        .lock()
        .map_err(|_| "The settings are unavailable.".to_string())?
        .clone();
    let current = current_preferences.shortcut.clone();
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
        ..current_preferences
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

#[tauri::command]
fn palette_test_mode() -> bool {
    std::env::args().any(|argument| argument == "--palette")
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
    if palette_route(current_permission_status(), onboarding_is_complete(app))
        == PaletteRoute::PermissionGate
    {
        let _ = app.state::<MenuCache>().clear();
        let _ = open_settings(app.clone());
        return;
    }

    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
        let _ = window.hide();
        return;
    }

    if let Some(settings) = app.get_webview_window("settings") {
        let _ = settings.hide();
    }

    let presentation = app.state::<PresentationState>();
    presentation.suppress_reopen.store(true, Ordering::SeqCst);
    // The private palette launch flag is used only by the live compatibility
    // harness. Keep AppKit's synthetic Reopen event suppressed for that run so
    // it cannot replace the palette with Settings while a slow first catalog
    // is still loading.
    let palette_test_launch = std::env::args().any(|argument| argument == "--palette");
    if !palette_test_launch {
        let suppression = presentation.suppress_reopen.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(750));
            suppression.store(false, Ordering::SeqCst);
        });
    }

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
            let permission_app = app.handle().clone();
            #[cfg(target_os = "macos")]
            let permission_cache = menu_cache.clone();
            #[cfg(target_os = "macos")]
            thread::Builder::new()
                .name("macnu-permission-status".to_string())
                .spawn(move || {
                    let mut last_status = current_permission_status();
                    let mut poll_interval = PERMISSION_VISIBLE_POLL_INTERVAL;
                    loop {
                        thread::sleep(poll_interval);
                        let settings_visible = permission_app
                            .get_webview_window("settings")
                            .and_then(|window| window.is_visible().ok())
                            .unwrap_or(false);
                        let palette_visible = permission_app
                            .get_webview_window("main")
                            .and_then(|window| window.is_visible().ok())
                            .unwrap_or(false);
                        poll_interval = if settings_visible || palette_visible {
                            PERMISSION_VISIBLE_POLL_INTERVAL
                        } else {
                            PERMISSION_IDLE_POLL_INTERVAL
                        };

                        let status = current_permission_status();
                        if status != last_status {
                            let should_present_gate =
                                accessibility_was_revoked(last_status, status);
                            last_status = status;
                            let _ = permission_app.emit("permission-status-changed", status);
                            if should_present_gate {
                                let _ = permission_cache.clear();
                                let _ = open_settings(permission_app.clone());
                            }
                        }
                    }
                })?;

            #[cfg(target_os = "macos")]
            let cache_app = app.handle().clone();
            #[cfg(target_os = "macos")]
            thread::Builder::new()
                .name("macnu-menu-cache".to_string())
                .spawn(move || {
                    let mut schedule = BackgroundCacheSchedule::default();
                    // Setup creates Macnu's own status item just below. Avoid
                    // caching the transient pre-tray menu bar seen during the
                    // first few milliseconds of process startup.
                    thread::sleep(Duration::from_secs(1));
                    loop {
                        if require_ready(&cache_app).is_err() {
                            schedule = BackgroundCacheSchedule::default();
                            thread::sleep(BACKGROUND_DISPLAY_POLL_INTERVAL);
                            continue;
                        }
                        // Display lookup is cheap and keeps a newly targeted
                        // monitor warm immediately. The WindowServer signature
                        // walk is intentionally rate-limited while the pointer
                        // remains on the same display.
                        let display_id = unsafe { macnu_active_display_id() };
                        if schedule.should_check_signature(display_id, Instant::now()) {
                            if let Ok(refresh) = refresh_menu_cache(&menu_cache, false) {
                                if refresh.changed {
                                    let _ = cache_app.emit("menu-cache-updated", refresh.response);
                                }
                            }
                        }
                        thread::sleep(BACKGROUND_DISPLAY_POLL_INTERVAL);
                    }
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

            let launch_arguments: Vec<String> = std::env::args().collect();
            if launch_arguments
                .iter()
                .any(|argument| argument == "--palette")
            {
                // Let the launching test process return focus first; otherwise
                // the normal click-away behavior correctly hides the palette
                // before the GUI harness can inspect it.
                let palette_app = app.handle().clone();
                thread::spawn(move || {
                    thread::sleep(Duration::from_secs(5));
                    if let Some(window) = palette_app.get_webview_window("main") {
                        let _ = window
                            .eval("window.dispatchEvent(new Event('macnu-palette-test-mode'))");
                        let _ = window.emit("palette-test-mode", ());
                    }
                    toggle_palette(&palette_app);
                });
            } else if !launch_arguments
                .iter()
                .any(|argument| argument == "--background")
            {
                open_settings(app.handle().clone()).map_err(std::io::Error::other)?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_menu_icons,
            active_display_menu_icons,
            activate_menu_icon,
            get_settings,
            complete_onboarding,
            reset_onboarding,
            update_shortcut,
            set_start_at_login,
            open_login_items_settings,
            palette_test_mode,
            open_settings,
            get_permission_status,
            request_permission,
            open_privacy_settings,
            reveal_app_in_finder
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

#[cfg(test)]
mod tests {
    use super::*;

    fn icon(identifier: &str) -> MenuIcon {
        MenuIcon {
            window_id: 42,
            owner: "Example".to_string(),
            label: "Status".to_string(),
            x: 100.0,
            y: 0.0,
            width: 24.0,
            height: 24.0,
            image: "data:image/png;base64,test".to_string(),
            activation_pid: Some(100),
            activation_bundle_id: Some("example.status".to_string()),
            activation_identifier: Some(identifier.to_string()),
            activation_x: Some(100.0),
            activation_y: Some(0.0),
            activation_width: Some(24.0),
            activation_height: Some(24.0),
            activation_action: Some("AXPress".to_string()),
        }
    }

    fn response() -> MenuResponse {
        MenuResponse {
            icons: vec![icon("first"), icon("second")],
            display_id: 7,
            screen_capture_denied: false,
            accessibility_denied: false,
            error: None,
        }
    }

    #[test]
    fn legacy_preferences_keep_the_shortcut_and_begin_onboarding() {
        let preferences: Preferences =
            serde_json::from_str(r#"{"shortcut":"Command+Period"}"#).unwrap();

        assert_eq!(preferences.shortcut, "Command+Period");
        assert!(!preferences.onboarding_completed);
    }

    #[test]
    fn completed_onboarding_round_trips_in_preferences() {
        let preferences = Preferences {
            shortcut: "Command+Semicolon".to_string(),
            onboarding_completed: true,
        };

        let json = serde_json::to_string(&preferences).unwrap();
        let decoded: Preferences = serde_json::from_str(&json).unwrap();

        assert_eq!(decoded.shortcut, preferences.shortcut);
        assert!(decoded.onboarding_completed);
    }

    #[test]
    fn permission_status_uses_the_frontend_contract() {
        let json = serde_json::to_value(PermissionStatus {
            accessibility_granted: true,
            screen_capture_granted: false,
        })
        .unwrap();

        assert_eq!(json["accessibilityGranted"], true);
        assert_eq!(json["screenCaptureGranted"], false);
    }

    #[test]
    fn palette_requires_accessibility_but_not_screen_capture() {
        for screen_capture_granted in [false, true] {
            let denied = PermissionStatus {
                accessibility_granted: false,
                screen_capture_granted,
            };
            assert_eq!(palette_route(denied, true), PaletteRoute::PermissionGate);
            assert_eq!(
                require_accessibility_status(denied).unwrap_err(),
                ACCESSIBILITY_REQUIRED_MESSAGE
            );

            let allowed = PermissionStatus {
                accessibility_granted: true,
                screen_capture_granted,
            };
            assert_eq!(palette_route(allowed, false), PaletteRoute::PermissionGate);
            assert_eq!(palette_route(allowed, true), PaletteRoute::Palette);
            assert!(require_accessibility_status(allowed).is_ok());
        }
    }

    #[test]
    fn only_accessibility_revocation_requires_the_gate() {
        let fully_granted = PermissionStatus {
            accessibility_granted: true,
            screen_capture_granted: true,
        };
        assert!(accessibility_was_revoked(
            fully_granted,
            PermissionStatus {
                accessibility_granted: false,
                screen_capture_granted: true,
            }
        ));
        assert!(!accessibility_was_revoked(
            fully_granted,
            PermissionStatus {
                accessibility_granted: true,
                screen_capture_granted: false,
            }
        ));
    }

    #[test]
    fn activation_request_preserves_stable_identifier() {
        let request = ActivationRequest::from(icon("stable-item-id"));
        assert_eq!(
            request.activation_identifier.as_deref(),
            Some("stable-item-id")
        );
    }

    #[test]
    fn cache_preserves_duplicate_labels_with_distinct_identities() {
        let cached = response();
        assert_eq!(cached.icons.len(), 2);
        assert_eq!(cached.icons[0].label, cached.icons[1].label);
        assert_ne!(
            cached.icons[0].activation_identifier,
            cached.icons[1].activation_identifier
        );
    }

    #[test]
    fn clearing_the_catalog_removes_every_display() {
        let cache = MenuCache::default();
        let entry = MenuCacheEntry {
            response: response(),
            refreshed_at: Instant::now(),
            menu_signature: 99,
        };
        let mut responses = cache.responses.lock().unwrap();
        responses.insert(7, entry.clone());
        responses.insert(9, entry);
        drop(responses);

        cache.clear().unwrap();

        assert!(cache.responses.lock().unwrap().is_empty());
    }

    #[test]
    fn stale_cache_is_rejected_even_when_signature_is_unchanged() {
        let cache = MenuCache::default();
        cache.responses.lock().unwrap().insert(
            7,
            MenuCacheEntry {
                response: response(),
                refreshed_at: Instant::now() - MENU_CACHE_FRESHNESS,
                menu_signature: 99,
            },
        );

        assert!(fresh_cached_menu_icons(&cache, 7, 99).unwrap().is_none());
    }

    #[test]
    fn signature_change_invalidates_a_fresh_cache_entry() {
        let cache = MenuCache::default();
        cache.responses.lock().unwrap().insert(
            7,
            MenuCacheEntry {
                response: response(),
                refreshed_at: Instant::now(),
                menu_signature: 99,
            },
        );

        assert!(fresh_cached_menu_icons(&cache, 7, 100).unwrap().is_none());
    }

    #[test]
    fn screen_capture_denial_does_not_block_accessibility_catalog_caching() {
        let mut catalog = response();
        catalog.screen_capture_denied = true;

        assert!(response_is_cacheable(&catalog));
    }

    #[test]
    fn accessibility_denial_or_capture_error_blocks_catalog_caching() {
        let mut denied = response();
        denied.accessibility_denied = true;
        assert!(!response_is_cacheable(&denied));

        let mut failed = response();
        failed.error = Some("capture failed".to_string());
        assert!(!response_is_cacheable(&failed));
    }

    #[test]
    fn background_schedule_checks_immediately_then_every_ten_seconds() {
        let started_at = Instant::now();
        let mut schedule = BackgroundCacheSchedule::default();

        assert!(schedule.should_check_signature(7, started_at));
        for seconds in [2, 4, 6, 8] {
            assert!(!schedule.should_check_signature(7, started_at + Duration::from_secs(seconds)));
        }
        assert!(
            schedule.should_check_signature(7, started_at + BACKGROUND_SIGNATURE_CHECK_INTERVAL)
        );
    }

    #[test]
    fn background_schedule_checks_immediately_when_display_changes() {
        let started_at = Instant::now();
        let mut schedule = BackgroundCacheSchedule::default();

        assert!(schedule.should_check_signature(7, started_at));
        assert!(!schedule.should_check_signature(7, started_at + Duration::from_secs(2)));
        assert!(schedule.should_check_signature(9, started_at + Duration::from_secs(4)));
        assert!(!schedule.should_check_signature(9, started_at + Duration::from_secs(12)));
        assert!(schedule.should_check_signature(9, started_at + Duration::from_secs(14)));
    }
}
