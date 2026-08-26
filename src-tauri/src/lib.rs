use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    ffi::{c_char, CStr, CString},
    fs,
    io::Read,
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

mod app_updater;
#[cfg(feature = "official-distribution")]
mod update_policy;

#[cfg(not(any(feature = "source-build", feature = "official-distribution")))]
compile_error!("Choose exactly one Macnu build mode: `source-build` or `official-distribution`.");

#[cfg(all(feature = "source-build", feature = "official-distribution"))]
compile_error!(
    "Macnu build modes are mutually exclusive; enable only `source-build` or `official-distribution`."
);

#[cfg(all(feature = "official-distribution", not(target_os = "macos")))]
compile_error!("The official Macnu distribution is supported only on macOS.");

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
    is_macnu: bool,
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

const LICENSE_API_ORIGIN: &str = "https://api.lemonsqueezy.com";
const LICENSE_STORE_ID: u64 = 9_798;
const LICENSE_PRODUCT_ID: u64 = 1_308_383;
const PERSONAL_VARIANT_ID: u64 = 2_046_255;
const BUSINESS_VARIANT_ID: u64 = 2_046_262;
const LICENSE_VALIDATION_CADENCE: Duration = Duration::from_secs(24 * 60 * 60);
const LICENSE_OFFLINE_GRACE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const LICENSE_BACKGROUND_POLL_INTERVAL: Duration = Duration::from_secs(15 * 60);
const LICENSE_RESPONSE_LIMIT: usize = 128 * 1024;
const LICENSE_RECORD_VERSION: u8 = 1;
const LICENSE_REQUIRED_MESSAGE: &str = "A valid Macnu license is required.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum LicenseStatusState {
    Development,
    Unlicensed,
    Validating,
    Licensed,
    NeedsValidation,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum LicensePlan {
    Personal,
    Business,
}

impl LicensePlan {
    fn from_variant_id(variant_id: u64) -> Option<Self> {
        match variant_id {
            PERSONAL_VARIANT_ID => Some(Self::Personal),
            BUSINESS_VARIANT_ID => Some(Self::Business),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct LicenseStatus {
    state: LicenseStatusState,
    license_required: bool,
    can_use_app: bool,
    plan: Option<LicensePlan>,
    offline_grace: bool,
    validation_due: bool,
    last_validated_at: Option<u64>,
    grace_ends_at: Option<u64>,
    message: Option<String>,
}

// This is the only persisted license structure. It deliberately has no Debug
// implementation so accidental structured logging cannot reveal the key.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredLicense {
    version: u8,
    license_key: String,
    instance_id: String,
    installation_id: String,
    variant_id: u64,
    last_validated_at: u64,
    #[serde(default)]
    expires_at: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LicenseNotice {
    ServiceUnavailable,
    Rejected,
    StorageUnavailable,
}

struct LicenseRuntime {
    record: Option<StoredLicense>,
    validation_requests: usize,
    notice: Option<LicenseNotice>,
    storage_available: bool,
    discard_stored_record: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StorageRecoveryAction {
    None,
    Reload,
    Delete,
}

fn storage_recovery_action(runtime: &LicenseRuntime) -> StorageRecoveryAction {
    if runtime.storage_available {
        StorageRecoveryAction::None
    } else if runtime.discard_stored_record {
        StorageRecoveryAction::Delete
    } else {
        StorageRecoveryAction::Reload
    }
}

#[derive(Clone)]
struct LicenseManager {
    runtime: Arc<Mutex<LicenseRuntime>>,
    request_lock: Arc<Mutex<()>>,
    storage_lock: Arc<Mutex<()>>,
    client: reqwest::blocking::Client,
    installation_id: Arc<Mutex<Option<String>>>,
}

#[derive(Deserialize)]
struct LicenseApiKey {
    id: u64,
    status: String,
    key: String,
    activation_limit: Option<u32>,
    activation_usage: u32,
    created_at: String,
    expires_at: serde_json::Value,
}

#[derive(Deserialize)]
struct LicenseApiInstance {
    id: String,
    name: String,
    created_at: String,
}

#[derive(Deserialize)]
struct LicenseApiMeta {
    store_id: u64,
    order_id: u64,
    order_item_id: u64,
    product_id: u64,
    variant_id: u64,
}

#[derive(Deserialize)]
struct ActivateLicenseResponse {
    activated: bool,
    error: serde_json::Value,
    license_key: Option<LicenseApiKey>,
    instance: Option<LicenseApiInstance>,
    meta: Option<LicenseApiMeta>,
}

#[derive(Deserialize)]
struct PreflightLicenseResponse {
    valid: bool,
    error: serde_json::Value,
    license_key: Option<LicenseApiKey>,
    instance: serde_json::Value,
    meta: Option<LicenseApiMeta>,
}

#[derive(Deserialize)]
struct ValidateLicenseResponse {
    valid: bool,
    error: serde_json::Value,
    license_key: Option<LicenseApiKey>,
    instance: Option<LicenseApiInstance>,
    meta: Option<LicenseApiMeta>,
}

#[derive(Deserialize)]
struct DeactivateLicenseResponse {
    deactivated: bool,
    error: serde_json::Value,
    license_key: Option<LicenseApiKey>,
    meta: Option<LicenseApiMeta>,
}

#[derive(Deserialize)]
struct LicenseApiErrorResponse {
    error: Option<String>,
}

#[derive(Debug)]
enum LicenseRemoteError {
    Unavailable,
    Rejected,
    SecurityMismatch,
}

enum StoredLicenseLoad {
    Missing,
    Loaded(StoredLicense),
    Unavailable,
}

fn unix_time() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn license_timing(
    last_validated_at: u64,
    expires_at: Option<u64>,
    now: u64,
) -> (bool, bool, Option<u64>) {
    let age = now.checked_sub(last_validated_at);
    let expired = expires_at.is_some_and(|expires_at| now >= expires_at);
    let validation_due =
        expired || age.is_none_or(|age| age >= LICENSE_VALIDATION_CADENCE.as_secs());
    let within_grace = !expired && age.is_some_and(|age| age <= LICENSE_OFFLINE_GRACE.as_secs());
    let grace_ends_at = last_validated_at
        .checked_add(LICENSE_OFFLINE_GRACE.as_secs())
        .map(|grace_end| expires_at.map_or(grace_end, |expiry| grace_end.min(expiry)));
    (validation_due, within_grace, grace_ends_at)
}

fn stored_license_validation_is_due(record: &StoredLicense, now: u64) -> bool {
    license_timing(record.last_validated_at, record.expires_at, now).0
}

fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

fn normalized_license_key(value: &str) -> Option<String> {
    let key = value.trim();
    (key.len() >= 8
        && key.len() <= 128
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'))
    .then(|| key.to_string())
}

fn instance_name(installation_id: &str) -> String {
    format!("Macnu-{installation_id}")
}

fn api_timestamp(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|timestamp| timestamp.timestamp())
        .or_else(|_| {
            chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S")
                .map(|timestamp| timestamp.and_utc().timestamp())
        })
        .ok()
}

fn api_created_at_is_valid(value: &str) -> bool {
    api_timestamp(value).is_some_and(|timestamp| timestamp > 0)
}

fn api_expiration_is_valid(value: &serde_json::Value, now: u64) -> bool {
    value.is_null()
        || value
            .as_str()
            .and_then(api_timestamp)
            .is_some_and(|timestamp| timestamp > now as i64)
}

fn api_expiration_is_well_formed(value: &serde_json::Value) -> bool {
    value.is_null() || value.as_str().and_then(api_timestamp).is_some()
}

fn api_expiration_timestamp(value: &serde_json::Value) -> Option<u64> {
    value
        .as_str()
        .and_then(api_timestamp)
        .and_then(|timestamp| u64::try_from(timestamp).ok())
}

fn response_metadata_plan(meta: &LicenseApiMeta) -> Result<LicensePlan, LicenseRemoteError> {
    if meta.store_id != LICENSE_STORE_ID
        || meta.product_id != LICENSE_PRODUCT_ID
        || meta.order_id == 0
        || meta.order_item_id == 0
    {
        return Err(LicenseRemoteError::SecurityMismatch);
    }
    LicensePlan::from_variant_id(meta.variant_id).ok_or(LicenseRemoteError::SecurityMismatch)
}

fn validate_api_key(api_key: &LicenseApiKey, expected_key: &str) -> Result<(), LicenseRemoteError> {
    let now = unix_time();
    if api_key.id == 0
        || api_key.status != "active"
        || api_key.key != expected_key
        || api_key.activation_usage == 0
        || api_key.activation_limit.is_some_and(|limit| limit == 0)
        || !api_created_at_is_valid(&api_key.created_at)
        || !api_expiration_is_valid(&api_key.expires_at, now)
    {
        return Err(LicenseRemoteError::SecurityMismatch);
    }
    Ok(())
}

fn validate_preflight_response(
    response: &PreflightLicenseResponse,
    expected_key: &str,
) -> Result<LicensePlan, LicenseRemoteError> {
    if !response.valid || !response.error.is_null() || !response.instance.is_null() {
        return Err(LicenseRemoteError::Rejected);
    }
    let api_key = response
        .license_key
        .as_ref()
        .ok_or(LicenseRemoteError::SecurityMismatch)?;
    if api_key.id == 0
        || !matches!(api_key.status.as_str(), "inactive" | "active")
        || api_key.key != expected_key
        || api_key.activation_limit.is_some_and(|limit| limit == 0)
        || !api_created_at_is_valid(&api_key.created_at)
        || !api_expiration_is_valid(&api_key.expires_at, unix_time())
    {
        return Err(LicenseRemoteError::SecurityMismatch);
    }
    let meta = response
        .meta
        .as_ref()
        .ok_or(LicenseRemoteError::SecurityMismatch)?;
    response_metadata_plan(meta)
}

fn rollback_instance_id<'a>(
    response: &'a ActivateLicenseResponse,
    expected_instance_name: &str,
) -> Option<&'a str> {
    response
        .instance
        .as_ref()
        .filter(|instance| is_uuid(&instance.id) && instance.name == expected_instance_name)
        .map(|instance| instance.id.as_str())
}

fn validate_deactivated_api_key(
    api_key: &LicenseApiKey,
    expected_key: &str,
) -> Result<(), LicenseRemoteError> {
    if api_key.id == 0
        || !matches!(
            api_key.status.as_str(),
            "active" | "inactive" | "expired" | "disabled"
        )
        || api_key.key != expected_key
        || api_key.activation_limit.is_some_and(|limit| limit == 0)
        || !api_created_at_is_valid(&api_key.created_at)
        || !api_expiration_is_well_formed(&api_key.expires_at)
    {
        return Err(LicenseRemoteError::SecurityMismatch);
    }
    Ok(())
}

fn stored_license_is_valid(record: &StoredLicense, installation_id: &str) -> bool {
    record.version == LICENSE_RECORD_VERSION
        && normalized_license_key(&record.license_key).as_deref()
            == Some(record.license_key.as_str())
        && is_uuid(&record.instance_id)
        && is_uuid(&record.installation_id)
        && record.installation_id == installation_id
        && LicensePlan::from_variant_id(record.variant_id).is_some()
        && record.last_validated_at > 0
        && record.expires_at.is_none_or(|expires_at| expires_at > 0)
}

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
    LicenseGate,
    PermissionGate,
}

fn palette_route(
    license_status: &LicenseStatus,
    permission_status: PermissionStatus,
    onboarding_completed: bool,
) -> PaletteRoute {
    if !license_status.can_use_app {
        PaletteRoute::LicenseGate
    } else if permission_status.accessibility_granted && onboarding_completed {
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
    let license_status = app.state::<LicenseManager>().status();
    if !license_status.can_use_app {
        return Err(LICENSE_REQUIRED_MESSAGE.to_string());
    }
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
    fn macnu_copy_installation_id() -> *mut c_char;
    fn macnu_copy_license_record_json() -> *mut c_char;
    fn macnu_license_record_status() -> i32;
    fn macnu_save_license_record_json(record_json: *const c_char) -> i32;
    fn macnu_delete_license_record() -> i32;
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
fn copy_native_owned_string(pointer: *mut c_char) -> Option<String> {
    if pointer.is_null() {
        return None;
    }
    let value = unsafe { CStr::from_ptr(pointer) }
        .to_str()
        .ok()
        .map(str::to_owned);
    unsafe { macnu_free_native_string(pointer) };
    value
}

#[cfg(target_os = "macos")]
fn native_installation_id() -> Option<String> {
    let value = copy_native_owned_string(unsafe { macnu_copy_installation_id() })?;
    is_uuid(&value).then_some(value)
}

#[cfg(target_os = "macos")]
fn load_stored_license() -> StoredLicenseLoad {
    match unsafe { macnu_license_record_status() } {
        1 => StoredLicenseLoad::Missing,
        0 => {
            let Some(json) = copy_native_owned_string(unsafe { macnu_copy_license_record_json() })
            else {
                return StoredLicenseLoad::Unavailable;
            };
            match serde_json::from_str(&json) {
                Ok(record) => StoredLicenseLoad::Loaded(record),
                Err(_) => {
                    if unsafe { macnu_delete_license_record() } == 0 {
                        StoredLicenseLoad::Missing
                    } else {
                        StoredLicenseLoad::Unavailable
                    }
                }
            }
        }
        _ => StoredLicenseLoad::Unavailable,
    }
}

#[cfg(not(target_os = "macos"))]
fn native_installation_id() -> Option<String> {
    None
}

#[cfg(not(target_os = "macos"))]
fn load_stored_license() -> StoredLicenseLoad {
    StoredLicenseLoad::Unavailable
}

#[cfg(target_os = "macos")]
fn save_stored_license(record: &StoredLicense) -> Result<(), ()> {
    let json = serde_json::to_string(record).map_err(|_| ())?;
    let json = CString::new(json).map_err(|_| ())?;
    (unsafe { macnu_save_license_record_json(json.as_ptr()) } == 0)
        .then_some(())
        .ok_or(())
}

#[cfg(not(target_os = "macos"))]
fn save_stored_license(_record: &StoredLicense) -> Result<(), ()> {
    Err(())
}

#[cfg(target_os = "macos")]
fn delete_stored_license() -> Result<(), ()> {
    (unsafe { macnu_delete_license_record() } == 0)
        .then_some(())
        .ok_or(())
}

#[cfg(not(target_os = "macos"))]
fn delete_stored_license() -> Result<(), ()> {
    Err(())
}

impl LicenseManager {
    fn new() -> Result<Self, String> {
        let client = reqwest::blocking::Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(4))
            .timeout(Duration::from_secs(10))
            .user_agent(concat!("Macnu/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| "The license service could not be initialized.".to_string())?;

        if !cfg!(feature = "official-distribution") {
            return Ok(Self {
                runtime: Arc::new(Mutex::new(LicenseRuntime {
                    record: None,
                    validation_requests: 0,
                    notice: None,
                    storage_available: true,
                    discard_stored_record: false,
                })),
                request_lock: Arc::new(Mutex::new(())),
                storage_lock: Arc::new(Mutex::new(())),
                client,
                installation_id: Arc::new(Mutex::new(None)),
            });
        }

        let installation_id = native_installation_id();
        let (record, storage_available, notice, discard_stored_record) =
            match installation_id.as_deref() {
                None => (None, false, Some(LicenseNotice::StorageUnavailable), false),
                Some(installation_id) => match load_stored_license() {
                    StoredLicenseLoad::Missing => (None, true, None, false),
                    StoredLicenseLoad::Unavailable => {
                        (None, false, Some(LicenseNotice::StorageUnavailable), false)
                    }
                    StoredLicenseLoad::Loaded(record)
                        if stored_license_is_valid(&record, installation_id) =>
                    {
                        (Some(record), true, None, false)
                    }
                    StoredLicenseLoad::Loaded(_) => {
                        let deleted = delete_stored_license().is_ok();
                        (
                            None,
                            deleted,
                            Some(if deleted {
                                LicenseNotice::Rejected
                            } else {
                                LicenseNotice::StorageUnavailable
                            }),
                            !deleted,
                        )
                    }
                },
            };

        Ok(Self {
            runtime: Arc::new(Mutex::new(LicenseRuntime {
                record,
                validation_requests: 0,
                notice,
                storage_available,
                discard_stored_record,
            })),
            request_lock: Arc::new(Mutex::new(())),
            storage_lock: Arc::new(Mutex::new(())),
            client,
            installation_id: Arc::new(Mutex::new(installation_id)),
        })
    }

    fn recover_storage(&self) {
        if !cfg!(feature = "official-distribution") {
            return;
        }
        let action = self
            .runtime
            .lock()
            .map(|runtime| storage_recovery_action(&runtime))
            .unwrap_or(StorageRecoveryAction::None);
        if action == StorageRecoveryAction::None {
            return;
        }
        let Ok(_storage_guard) = self.storage_lock.lock() else {
            return;
        };
        let Ok(runtime) = self.runtime.lock() else {
            return;
        };
        let action = storage_recovery_action(&runtime);
        if action == StorageRecoveryAction::None {
            return;
        }
        drop(runtime);

        let Some(installation_id) = native_installation_id() else {
            return;
        };
        if action == StorageRecoveryAction::Delete {
            if delete_stored_license().is_err() {
                return;
            }
            if let Ok(mut stored_installation_id) = self.installation_id.lock() {
                *stored_installation_id = Some(installation_id);
            }
            if let Ok(mut runtime) = self.runtime.lock() {
                runtime.record = None;
                runtime.storage_available = true;
                runtime.discard_stored_record = false;
                runtime.notice = None;
            }
            return;
        }

        let (record, storage_available, notice, discard_stored_record) = match load_stored_license()
        {
            StoredLicenseLoad::Missing => (None, true, None, false),
            StoredLicenseLoad::Unavailable => {
                (None, false, Some(LicenseNotice::StorageUnavailable), false)
            }
            StoredLicenseLoad::Loaded(record)
                if stored_license_is_valid(&record, &installation_id) =>
            {
                (Some(record), true, None, false)
            }
            StoredLicenseLoad::Loaded(_) => {
                let deleted = delete_stored_license().is_ok();
                (
                    None,
                    deleted,
                    Some(if deleted {
                        LicenseNotice::Rejected
                    } else {
                        LicenseNotice::StorageUnavailable
                    }),
                    !deleted,
                )
            }
        };
        if let Ok(mut stored_installation_id) = self.installation_id.lock() {
            *stored_installation_id = Some(installation_id);
        }
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.record = record;
            runtime.storage_available = storage_available;
            runtime.discard_stored_record = discard_stored_record;
            runtime.notice = notice;
        }
    }

    fn status(&self) -> LicenseStatus {
        self.recover_storage();
        self.status_at(unix_time())
    }

    fn require_storage(&self) -> Result<(), String> {
        self.runtime
            .lock()
            .ok()
            .is_some_and(|runtime| runtime.storage_available)
            .then_some(())
            .ok_or_else(|| "Secure license storage is unavailable on this Mac.".to_string())
    }

    fn status_at(&self, now: u64) -> LicenseStatus {
        if !cfg!(feature = "official-distribution") {
            return LicenseStatus {
                state: LicenseStatusState::Development,
                license_required: false,
                can_use_app: true,
                plan: None,
                offline_grace: false,
                validation_due: false,
                last_validated_at: None,
                grace_ends_at: None,
                message: Some(
                    "Development/source build; no paid-license or official-update entitlement."
                        .to_string(),
                ),
            };
        }

        let Ok(runtime) = self.runtime.lock() else {
            return unavailable_license_status();
        };
        if !runtime.storage_available {
            return unavailable_license_status();
        }
        let Some(record) = runtime.record.as_ref() else {
            return LicenseStatus {
                state: if runtime.validation_requests > 0 {
                    LicenseStatusState::Validating
                } else {
                    LicenseStatusState::Unlicensed
                },
                license_required: true,
                can_use_app: false,
                plan: None,
                offline_grace: false,
                validation_due: false,
                last_validated_at: None,
                grace_ends_at: None,
                message: notice_message(runtime.notice),
            };
        };

        let plan = LicensePlan::from_variant_id(record.variant_id);
        let (validation_due, within_grace, grace_ends_at) =
            license_timing(record.last_validated_at, record.expires_at, now);
        let can_use_app = plan.is_some() && within_grace;
        let offline_grace = can_use_app && validation_due;
        let state = if runtime.validation_requests > 0 {
            LicenseStatusState::Validating
        } else if can_use_app {
            LicenseStatusState::Licensed
        } else {
            LicenseStatusState::NeedsValidation
        };
        let message = if !can_use_app {
            Some("Connect to the internet to verify your Macnu license.".to_string())
        } else if offline_grace {
            Some("Using the last verified license while validation is unavailable.".to_string())
        } else {
            notice_message(runtime.notice)
        };
        LicenseStatus {
            state,
            license_required: true,
            can_use_app,
            plan,
            offline_grace,
            validation_due,
            last_validated_at: Some(record.last_validated_at),
            grace_ends_at,
            message,
        }
    }

    fn set_validating(&self, validating: bool) {
        if let Ok(mut runtime) = self.runtime.lock() {
            if validating {
                runtime.validation_requests = runtime.validation_requests.saturating_add(1);
                runtime.notice = None;
            } else {
                runtime.validation_requests = runtime.validation_requests.saturating_sub(1);
            }
        }
    }

    fn activate(&self, raw_key: &str) -> Result<LicenseStatus, String> {
        if !cfg!(feature = "official-distribution") {
            return Ok(self.status());
        }
        self.recover_storage();
        self.require_storage()?;
        let key = normalized_license_key(raw_key)
            .ok_or_else(|| "Enter a valid Lemon Squeezy license key.".to_string())?;
        let _request_guard = self
            .request_lock
            .lock()
            .map_err(|_| "License validation is temporarily unavailable.".to_string())?;
        let installation_id = self
            .installation_id
            .lock()
            .ok()
            .and_then(|installation_id| installation_id.clone())
            .ok_or_else(|| "Secure license storage is unavailable on this Mac.".to_string())?;

        let existing = self
            .runtime
            .lock()
            .map_err(|_| "License validation is temporarily unavailable.".to_string())?
            .record
            .clone();
        if let Some(existing) = existing {
            if existing.license_key != key {
                return Err("Deactivate the current license before using another key.".to_string());
            }
            if !stored_license_validation_is_due(&existing, unix_time()) {
                return Ok(self.status());
            }
            return self.validate_record(existing);
        }

        // Validate the unactivated key before creating an instance. This is
        // the only way to reject a key for another Lemon Squeezy product
        // without consuming one of the customer's activation slots.
        let preflight: PreflightLicenseResponse = self
            .post_form("/v1/licenses/validate", &[("license_key", key.as_str())])
            .map_err(|error| self.remote_error_message(error))?;
        let preflight_plan = validate_preflight_response(&preflight, &key)
            .map_err(|error| self.remote_error_message(error))?;
        let preflight_variant_id = match preflight_plan {
            LicensePlan::Personal => PERSONAL_VARIANT_ID,
            LicensePlan::Business => BUSINESS_VARIANT_ID,
        };

        let expected_instance_name = instance_name(&installation_id);
        let response: ActivateLicenseResponse = self
            .post_form(
                "/v1/licenses/activate",
                &[
                    ("license_key", key.as_str()),
                    ("instance_name", expected_instance_name.as_str()),
                ],
            )
            .map_err(|error| self.remote_error_message(error))?;
        let rollback_instance_id =
            rollback_instance_id(&response, &expected_instance_name).map(str::to_owned);
        if !response.activated || !response.error.is_null() {
            if response.activated {
                if let Some(instance_id) = rollback_instance_id.as_deref() {
                    self.rollback_activation(&key, instance_id, preflight_variant_id);
                }
            }
            self.set_notice(LicenseNotice::Rejected);
            return Err("That license could not be activated.".to_string());
        }

        let checked = (|| -> Result<(&LicenseApiKey, &LicenseApiInstance), LicenseRemoteError> {
            let meta = response
                .meta
                .as_ref()
                .ok_or(LicenseRemoteError::SecurityMismatch)?;
            let plan = response_metadata_plan(meta)?;
            if plan != preflight_plan || meta.variant_id != preflight_variant_id {
                return Err(LicenseRemoteError::SecurityMismatch);
            }
            let api_key = response
                .license_key
                .as_ref()
                .ok_or(LicenseRemoteError::SecurityMismatch)?;
            validate_api_key(api_key, &key)?;
            let instance = response
                .instance
                .as_ref()
                .filter(|instance| {
                    is_uuid(&instance.id)
                        && instance.name == expected_instance_name
                        && api_created_at_is_valid(&instance.created_at)
                })
                .ok_or(LicenseRemoteError::SecurityMismatch)?;
            Ok((api_key, instance))
        })();
        let (api_key, instance) = match checked {
            Ok(checked) => checked,
            Err(error) => {
                if let Some(instance_id) = rollback_instance_id.as_deref() {
                    self.rollback_activation(&key, instance_id, preflight_variant_id);
                }
                return Err(self.remote_error_message(error));
            }
        };
        let record = StoredLicense {
            version: LICENSE_RECORD_VERSION,
            license_key: key.clone(),
            instance_id: instance.id.clone(),
            installation_id,
            variant_id: preflight_variant_id,
            last_validated_at: unix_time(),
            expires_at: api_expiration_timestamp(&api_key.expires_at),
        };
        if let Err(error) = self.persist_verified_record(record) {
            if let Some(instance_id) = rollback_instance_id.as_deref() {
                self.rollback_activation(&key, instance_id, preflight_variant_id);
            }
            return Err(error);
        }
        Ok(self.status())
    }

    fn rollback_activation(&self, key: &str, instance_id: &str, variant_id: u64) {
        // The key was already proven to belong to Macnu by the preflight and
        // the instance identifier came from Lemon's activation response. A
        // rollback failure is intentionally silent; the original safe error
        // remains authoritative and no credential is exposed or logged.
        let Ok(response) = self.post_form::<DeactivateLicenseResponse>(
            "/v1/licenses/deactivate",
            &[("license_key", key), ("instance_id", instance_id)],
        ) else {
            return;
        };
        if !response.deactivated || !response.error.is_null() {
            return;
        }
        let Some(api_key) = response.license_key.as_ref() else {
            return;
        };
        if validate_deactivated_api_key(api_key, key).is_err() {
            return;
        }
        let Some(meta) = response.meta.as_ref() else {
            return;
        };
        let _rollback_confirmed =
            response_metadata_plan(meta).is_ok() && meta.variant_id == variant_id;
    }

    fn refresh(&self, force: bool) -> Result<LicenseStatus, String> {
        if !cfg!(feature = "official-distribution") {
            return Ok(self.status());
        }
        self.recover_storage();
        self.require_storage()?;
        let observed_validation = self.runtime.lock().ok().and_then(|runtime| {
            runtime
                .record
                .as_ref()
                .map(|record| record.last_validated_at)
        });
        let _request_guard = self
            .request_lock
            .lock()
            .map_err(|_| "License validation is temporarily unavailable.".to_string())?;
        let record = self
            .runtime
            .lock()
            .map_err(|_| "License validation is temporarily unavailable.".to_string())?
            .record
            .clone();
        let Some(record) = record else {
            return Ok(self.status());
        };
        if observed_validation != Some(record.last_validated_at) {
            return Ok(self.status());
        }
        if !force && !stored_license_validation_is_due(&record, unix_time()) {
            return Ok(self.status());
        }
        self.validate_record(record)
    }

    fn validate_record(&self, mut record: StoredLicense) -> Result<LicenseStatus, String> {
        let expected_instance_name = instance_name(&record.installation_id);
        let response: ValidateLicenseResponse = self
            .post_form(
                "/v1/licenses/validate",
                &[
                    ("license_key", record.license_key.as_str()),
                    ("instance_id", record.instance_id.as_str()),
                ],
            )
            .map_err(|error| self.invalidate_remote_error(error))?;
        if !response.valid {
            self.invalidate_record(LicenseNotice::Rejected);
            return Err("That license is no longer valid.".to_string());
        }
        if !response.error.is_null() {
            return Err(self.invalidate_remote_error(LicenseRemoteError::SecurityMismatch));
        }
        let api_key = response
            .license_key
            .as_ref()
            .ok_or(LicenseRemoteError::SecurityMismatch)
            .map_err(|error| self.invalidate_remote_error(error))?;
        if matches!(api_key.status.as_str(), "disabled" | "expired" | "inactive") {
            self.invalidate_record(LicenseNotice::Rejected);
            return Err("That license is no longer valid.".to_string());
        }
        validate_api_key(api_key, &record.license_key)
            .map_err(|error| self.invalidate_remote_error(error))?;
        record.expires_at = api_expiration_timestamp(&api_key.expires_at);
        let meta = response
            .meta
            .as_ref()
            .ok_or(LicenseRemoteError::SecurityMismatch)
            .map_err(|error| self.invalidate_remote_error(error))?;
        let plan =
            response_metadata_plan(meta).map_err(|error| self.invalidate_remote_error(error))?;
        if meta.variant_id != record.variant_id
            || LicensePlan::from_variant_id(record.variant_id) != Some(plan)
        {
            return Err(self.invalidate_remote_error(LicenseRemoteError::SecurityMismatch));
        }
        response
            .instance
            .as_ref()
            .filter(|instance| {
                instance.id == record.instance_id
                    && instance.name == expected_instance_name
                    && api_created_at_is_valid(&instance.created_at)
            })
            .ok_or(LicenseRemoteError::SecurityMismatch)
            .map_err(|error| self.invalidate_remote_error(error))?;

        record.last_validated_at = unix_time();
        self.persist_verified_record(record)?;
        Ok(self.status())
    }

    fn deactivate(&self) -> Result<LicenseStatus, String> {
        if !cfg!(feature = "official-distribution") {
            return Ok(self.status());
        }
        self.recover_storage();
        self.require_storage()?;
        let _request_guard = self
            .request_lock
            .lock()
            .map_err(|_| "License validation is temporarily unavailable.".to_string())?;
        let record = self
            .runtime
            .lock()
            .map_err(|_| "License validation is temporarily unavailable.".to_string())?
            .record
            .clone();
        let Some(record) = record else {
            return Ok(self.status());
        };
        let response: DeactivateLicenseResponse = self
            .post_form(
                "/v1/licenses/deactivate",
                &[
                    ("license_key", record.license_key.as_str()),
                    ("instance_id", record.instance_id.as_str()),
                ],
            )
            .map_err(|error| self.remote_error_message(error))?;
        if !response.deactivated || !response.error.is_null() {
            self.set_notice(LicenseNotice::Rejected);
            return Err("Macnu could not deactivate this device.".to_string());
        }
        response
            .license_key
            .as_ref()
            .ok_or(LicenseRemoteError::SecurityMismatch)
            .and_then(|api_key| validate_deactivated_api_key(api_key, &record.license_key))
            .map_err(|error| self.remote_error_message(error))?;
        let meta = response
            .meta
            .as_ref()
            .ok_or(LicenseRemoteError::SecurityMismatch)
            .map_err(|error| self.remote_error_message(error))?;
        let plan =
            response_metadata_plan(meta).map_err(|error| self.remote_error_message(error))?;
        if meta.variant_id != record.variant_id
            || LicensePlan::from_variant_id(record.variant_id) != Some(plan)
        {
            return Err(self.remote_error_message(LicenseRemoteError::SecurityMismatch));
        }

        if delete_stored_license().is_err() {
            if let Ok(mut runtime) = self.runtime.lock() {
                runtime.record = None;
                runtime.storage_available = false;
                runtime.discard_stored_record = true;
                runtime.notice = Some(LicenseNotice::StorageUnavailable);
            }
            return Err(
                "The license was deactivated, but secure local storage is unavailable.".to_string(),
            );
        }
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.record = None;
            runtime.discard_stored_record = false;
            runtime.notice = None;
        }
        Ok(self.status())
    }

    fn post_form<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        form: &[(&str, &str)],
    ) -> Result<T, LicenseRemoteError> {
        let response = self
            .client
            .post(format!("{LICENSE_API_ORIGIN}{path}"))
            .header(reqwest::header::ACCEPT, "application/json")
            .form(form)
            .send()
            .map_err(|_| LicenseRemoteError::Unavailable)?;
        let status = response.status();
        let is_json = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.to_ascii_lowercase().starts_with("application/json"));
        let mut bytes = Vec::new();
        response
            .take((LICENSE_RESPONSE_LIMIT + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| LicenseRemoteError::Unavailable)?;
        if bytes.len() > LICENSE_RESPONSE_LIMIT || !is_json {
            return Err(LicenseRemoteError::Unavailable);
        }
        if !status.is_success() {
            let has_error = serde_json::from_slice::<LicenseApiErrorResponse>(&bytes)
                .ok()
                .and_then(|response| response.error)
                .is_some_and(|error| !error.trim().is_empty());
            if status.is_server_error() || matches!(status.as_u16(), 408 | 425 | 429) || !has_error
            {
                return Err(LicenseRemoteError::Unavailable);
            }
            return Err(LicenseRemoteError::Rejected);
        }
        serde_json::from_slice(&bytes).map_err(|_| LicenseRemoteError::Unavailable)
    }

    fn persist_verified_record(&self, record: StoredLicense) -> Result<(), String> {
        if save_stored_license(&record).is_err() {
            if let Ok(mut runtime) = self.runtime.lock() {
                runtime.storage_available = false;
                runtime.discard_stored_record = false;
                runtime.notice = Some(LicenseNotice::StorageUnavailable);
            }
            return Err("Macnu could not save the license securely.".to_string());
        }
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.record = Some(record);
            runtime.notice = None;
            runtime.storage_available = true;
            runtime.discard_stored_record = false;
        }
        Ok(())
    }

    fn set_notice(&self, notice: LicenseNotice) {
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.notice = Some(notice);
        }
    }

    fn invalidate_record(&self, notice: LicenseNotice) {
        let storage_available = delete_stored_license().is_ok();
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.record = None;
            runtime.storage_available = storage_available;
            runtime.discard_stored_record = !storage_available;
            runtime.notice = Some(if storage_available {
                notice
            } else {
                LicenseNotice::StorageUnavailable
            });
        }
    }

    fn remote_error_message(&self, error: LicenseRemoteError) -> String {
        match error {
            LicenseRemoteError::Unavailable => {
                self.set_notice(LicenseNotice::ServiceUnavailable);
                "Macnu could not reach the license service.".to_string()
            }
            LicenseRemoteError::Rejected => {
                self.set_notice(LicenseNotice::Rejected);
                "That license request was rejected.".to_string()
            }
            LicenseRemoteError::SecurityMismatch => {
                self.set_notice(LicenseNotice::Rejected);
                "That key is not a Macnu license.".to_string()
            }
        }
    }

    fn invalidate_remote_error(&self, error: LicenseRemoteError) -> String {
        match error {
            LicenseRemoteError::Unavailable => self.remote_error_message(error),
            LicenseRemoteError::Rejected => {
                self.invalidate_record(LicenseNotice::Rejected);
                self.remote_error_message(error)
            }
            LicenseRemoteError::SecurityMismatch => {
                // A previously verified local license must survive an
                // incomplete or changed service response. Do not advance its
                // validation timestamp, but retain the normal offline grace.
                self.set_notice(LicenseNotice::ServiceUnavailable);
                "Macnu could not verify the license service response.".to_string()
            }
        }
    }
}

fn notice_message(notice: Option<LicenseNotice>) -> Option<String> {
    match notice {
        Some(LicenseNotice::ServiceUnavailable) => {
            Some("Macnu could not reach the license service.".to_string())
        }
        Some(LicenseNotice::Rejected) => Some("Enter a valid Macnu license key.".to_string()),
        Some(LicenseNotice::StorageUnavailable) => {
            Some("Secure license storage is unavailable on this Mac.".to_string())
        }
        None => None,
    }
}

fn unavailable_license_status() -> LicenseStatus {
    LicenseStatus {
        state: LicenseStatusState::NeedsValidation,
        license_required: true,
        can_use_app: false,
        plan: None,
        offline_grace: false,
        validation_due: true,
        last_validated_at: None,
        grace_ends_at: None,
        message: Some("Secure license storage is unavailable on this Mac.".to_string()),
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

fn is_current_process_icon(icon: &MenuIcon) -> bool {
    i32::try_from(std::process::id())
        .ok()
        .is_some_and(|pid| icon.activation_pid == Some(pid))
}

fn identify_macnu_icons(response: &mut MenuResponse) {
    for icon in &mut response.icons {
        icon.is_macnu = is_current_process_icon(icon);
    }
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

    let mut response = copy_native_menu_icons()?;
    identify_macnu_icons(&mut response);
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
        if icon.is_macnu && is_current_process_icon(&icon) {
            return open_settings(app);
        }
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

fn emit_license_status(app: &AppHandle, status: &LicenseStatus, present_gate: bool) {
    let _ = app.emit("license-status-changed", status.clone());
    if !status.can_use_app {
        let _ = app.state::<MenuCache>().clear();
        if present_gate {
            let _ = open_settings(app.clone());
        }
    }
}

#[tauri::command]
fn get_license_status(license: State<'_, LicenseManager>) -> LicenseStatus {
    license.status()
}

#[tauri::command]
async fn activate_license(
    app: AppHandle,
    license_key: String,
    license: State<'_, LicenseManager>,
) -> Result<LicenseStatus, String> {
    let manager = license.inner().clone();
    manager.set_validating(true);
    emit_license_status(&app, &manager.status(), false);
    let operation_manager = manager.clone();
    let joined =
        tauri::async_runtime::spawn_blocking(move || operation_manager.activate(&license_key))
            .await;
    manager.set_validating(false);
    let status = manager.status();
    emit_license_status(&app, &status, false);
    let result = joined.map_err(|_| "License activation did not finish.".to_string())?;
    result.map(|_| status)
}

#[tauri::command]
async fn refresh_license(
    app: AppHandle,
    force: Option<bool>,
    license: State<'_, LicenseManager>,
) -> Result<LicenseStatus, String> {
    let manager = license.inner().clone();
    manager.set_validating(true);
    emit_license_status(&app, &manager.status(), false);
    let operation_manager = manager.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        operation_manager.refresh(force.unwrap_or(false))
    })
    .await;
    manager.set_validating(false);
    let status = manager.status();
    emit_license_status(&app, &status, !status.can_use_app);
    let result = joined.map_err(|_| "License validation did not finish.".to_string())?;
    result.map(|_| status)
}

#[tauri::command]
async fn deactivate_license(
    app: AppHandle,
    license: State<'_, LicenseManager>,
) -> Result<LicenseStatus, String> {
    let manager = license.inner().clone();
    manager.set_validating(true);
    emit_license_status(&app, &manager.status(), false);
    let operation_manager = manager.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || operation_manager.deactivate()).await;
    manager.set_validating(false);
    let status = manager.status();
    emit_license_status(&app, &status, false);
    let result = joined.map_err(|_| "License deactivation did not finish.".to_string())?;
    result.map(|_| status)
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
    if !app.state::<LicenseManager>().status().can_use_app {
        return Err(LICENSE_REQUIRED_MESSAGE.to_string());
    }
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

fn hide_settings_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("settings") {
        window.hide()?;
    }
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Accessory)?;
    Ok(())
}

#[tauri::command]
fn close_settings(app: AppHandle) -> Result<(), String> {
    hide_settings_window(&app).map_err(|error| error.to_string())
}

#[tauri::command]
fn open_settings(app: AppHandle) -> Result<(), String> {
    if let Some(palette) = app.get_webview_window("main") {
        let _ = palette.hide();
    }
    let window = app
        .get_webview_window("settings")
        .ok_or_else(|| "The Settings window is unavailable.".to_string())?;
    if !window.is_visible().unwrap_or(false) {
        position_settings(&window).map_err(|error| error.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        app.set_activation_policy(tauri::ActivationPolicy::Regular)
            .map_err(|error| error.to_string())?;
        unsafe { macnu_activate_application() };
    }
    if let Err(error) = window.show().and_then(|_| window.set_focus()) {
        let _ = hide_settings_window(&app);
        return Err(error.to_string());
    }
    let _ = window.emit("settings-opened", ());
    Ok(())
}

fn toggle_palette(app: &tauri::AppHandle) {
    let license_status = app.state::<LicenseManager>().status();
    match palette_route(
        &license_status,
        current_permission_status(),
        onboarding_is_complete(app),
    ) {
        PaletteRoute::LicenseGate | PaletteRoute::PermissionGate => {
            let _ = app.state::<MenuCache>().clear();
            let _ = open_settings(app.clone());
            return;
        }
        PaletteRoute::Palette => {}
    }

    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
        let _ = window.hide();
        return;
    }

    let _ = hide_settings_window(app);

    let presentation = app.state::<PresentationState>();
    presentation.suppress_reopen.store(true, Ordering::SeqCst);
    // UI automation test mode suppresses AppKit's synthetic Reopen event so it
    // cannot replace the palette with Settings while a slow first catalog is
    // still loading.
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
        .plugin(tauri_plugin_opener::init())
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
                    let _ = hide_settings_window(window.app_handle());
                }
            }
        })
        .setup(|app| {
            #[cfg(feature = "official-distribution")]
            {
                app.handle().plugin(
                    tauri_plugin_updater::Builder::new()
                        .target(app_updater::UPDATE_TARGET)
                        .default_version_comparator(|current, release| {
                            app_updater::is_stable_upgrade(&current, &release.version)
                        })
                        .build(),
                )?;
                app.manage(app_updater::UpdateOperationState::default());
            }

            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            app.manage(PresentationState::default());

            if let Some(window) = app.get_webview_window("main") {
                position_palette(&window)?;
            }

            let menu_cache = MenuCache::default();
            app.manage(menu_cache.clone());

            let license_manager = LicenseManager::new().map_err(std::io::Error::other)?;
            app.manage(license_manager.clone());

            #[cfg(target_os = "macos")]
            let license_app = app.handle().clone();
            #[cfg(target_os = "macos")]
            let license_cache = menu_cache.clone();
            #[cfg(target_os = "macos")]
            thread::Builder::new()
                .name("macnu-license-validation".to_string())
                .spawn(move || {
                    thread::sleep(Duration::from_secs(1));
                    loop {
                        let before = license_manager.status();
                        if before.license_required && before.validation_due {
                            license_manager.set_validating(true);
                            emit_license_status(&license_app, &license_manager.status(), false);
                            let _ = license_manager.refresh(false);
                            license_manager.set_validating(false);
                            let after = license_manager.status();
                            let _ = license_app.emit("license-status-changed", after.clone());
                            if !after.can_use_app {
                                let _ = license_cache.clear();
                                let _ = open_settings(license_app.clone());
                            }
                        }
                        thread::sleep(LICENSE_BACKGROUND_POLL_INTERVAL);
                    }
                })?;

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
                // Let the UI automation test runner return focus first;
                // otherwise the normal click-away behavior correctly hides
                // the palette before the test can inspect it.
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
            get_license_status,
            activate_license,
            refresh_license,
            deactivate_license,
            app_updater::check_for_updates,
            app_updater::install_update,
            get_settings,
            complete_onboarding,
            reset_onboarding,
            update_shortcut,
            set_start_at_login,
            open_login_items_settings,
            palette_test_mode,
            close_settings,
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
            is_macnu: false,
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

    fn licensed_status(can_use_app: bool) -> LicenseStatus {
        LicenseStatus {
            state: if can_use_app {
                LicenseStatusState::Licensed
            } else {
                LicenseStatusState::Unlicensed
            },
            license_required: true,
            can_use_app,
            plan: can_use_app.then_some(LicensePlan::Personal),
            offline_grace: false,
            validation_due: false,
            last_validated_at: can_use_app.then_some(100),
            grace_ends_at: can_use_app.then_some(200),
            message: None,
        }
    }

    fn api_key() -> LicenseApiKey {
        LicenseApiKey {
            id: 44,
            status: "active".to_string(),
            key: "38b1460a-5104-4067-a91d-77b872934d51".to_string(),
            activation_limit: Some(2),
            activation_usage: 1,
            created_at: "2026-08-22T00:00:00.000000Z".to_string(),
            expires_at: serde_json::Value::Null,
        }
    }

    fn api_meta(variant_id: u64) -> LicenseApiMeta {
        LicenseApiMeta {
            store_id: LICENSE_STORE_ID,
            order_id: 80,
            order_item_id: 81,
            product_id: LICENSE_PRODUCT_ID,
            variant_id,
        }
    }

    fn api_instance(name: &str) -> LicenseApiInstance {
        LicenseApiInstance {
            id: "f90ec370-fd83-46a5-8bbd-44a241e78665".to_string(),
            name: name.to_string(),
            created_at: "2026-08-22T00:00:00.000000Z".to_string(),
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
        let licensed = licensed_status(true);
        for screen_capture_granted in [false, true] {
            let denied = PermissionStatus {
                accessibility_granted: false,
                screen_capture_granted,
            };
            assert_eq!(
                palette_route(&licensed, denied, true),
                PaletteRoute::PermissionGate
            );
            assert_eq!(
                require_accessibility_status(denied).unwrap_err(),
                ACCESSIBILITY_REQUIRED_MESSAGE
            );

            let allowed = PermissionStatus {
                accessibility_granted: true,
                screen_capture_granted,
            };
            assert_eq!(
                palette_route(&licensed, allowed, false),
                PaletteRoute::PermissionGate
            );
            assert_eq!(
                palette_route(&licensed, allowed, true),
                PaletteRoute::Palette
            );
            assert!(require_accessibility_status(allowed).is_ok());
        }
    }

    #[test]
    fn license_gate_has_priority_over_permission_gate() {
        let no_permissions = PermissionStatus {
            accessibility_granted: false,
            screen_capture_granted: false,
        };

        assert_eq!(
            palette_route(&licensed_status(false), no_permissions, false),
            PaletteRoute::LicenseGate
        );
    }

    #[test]
    fn redacted_license_status_never_serializes_credentials_or_customer_data() {
        let json = serde_json::to_value(licensed_status(true)).unwrap();
        let object = json.as_object().unwrap();

        for forbidden in [
            "licenseKey",
            "instanceId",
            "installationId",
            "customerEmail",
            "customerName",
            "orderId",
        ] {
            assert!(!object.contains_key(forbidden));
        }
        assert_eq!(json["state"], "licensed");
        assert_eq!(json["licenseRequired"], true);
        assert_eq!(json["plan"], "personal");
    }

    #[test]
    fn only_live_macnu_variants_are_recognized() {
        assert_eq!(
            LicensePlan::from_variant_id(PERSONAL_VARIANT_ID),
            Some(LicensePlan::Personal)
        );
        assert_eq!(
            LicensePlan::from_variant_id(BUSINESS_VARIANT_ID),
            Some(LicensePlan::Business)
        );
        assert_eq!(LicensePlan::from_variant_id(123), None);
    }

    #[cfg(feature = "source-build")]
    #[test]
    fn source_build_is_explicitly_not_a_paid_license() {
        let status = LicenseManager::new().unwrap().status();

        assert_eq!(status.state, LicenseStatusState::Development);
        assert!(!status.license_required);
        assert!(status.can_use_app);
        assert_eq!(status.plan, None);
        assert!(status.message.unwrap().contains("source build"));
    }

    #[test]
    fn lemon_response_checks_key_status_limits_and_live_metadata() {
        let key = api_key();
        assert!(validate_api_key(&key, &key.key).is_ok());
        assert_eq!(
            response_metadata_plan(&api_meta(PERSONAL_VARIANT_ID)).unwrap(),
            LicensePlan::Personal
        );

        let mut wrong_key = api_key();
        wrong_key.key = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa".to_string();
        assert!(validate_api_key(&wrong_key, "38b1460a-5104-4067-a91d-77b872934d51").is_err());

        let mut reduced_limit = api_key();
        reduced_limit.activation_limit = Some(1);
        reduced_limit.activation_usage = 3;
        assert!(validate_api_key(&reduced_limit, &reduced_limit.key).is_ok());

        let mut unlimited = api_key();
        unlimited.activation_limit = None;
        assert!(validate_api_key(&unlimited, &unlimited.key).is_ok());

        let mut server_ahead_of_local_clock = api_key();
        server_ahead_of_local_clock.created_at = "2999-08-22T00:00:00.000000Z".to_string();
        assert!(validate_api_key(
            &server_ahead_of_local_clock,
            &server_ahead_of_local_clock.key
        )
        .is_ok());

        let mut expired = api_key();
        expired.expires_at = serde_json::Value::String("2020-01-01T00:00:00.000000Z".to_string());
        assert!(validate_api_key(&expired, &expired.key).is_err());

        let mut wrong_store = api_meta(PERSONAL_VARIANT_ID);
        wrong_store.store_id += 1;
        assert!(response_metadata_plan(&wrong_store).is_err());
        assert!(response_metadata_plan(&api_meta(999)).is_err());
    }

    #[test]
    fn activation_preflight_accepts_unused_and_existing_macnu_keys() {
        let expected_key = "38b1460a-5104-4067-a91d-77b872934d51";
        let mut unused_key = api_key();
        unused_key.status = "inactive".to_string();
        unused_key.activation_usage = 0;
        let unused = PreflightLicenseResponse {
            valid: true,
            error: serde_json::Value::Null,
            license_key: Some(unused_key),
            instance: serde_json::Value::Null,
            meta: Some(api_meta(PERSONAL_VARIANT_ID)),
        };
        assert_eq!(
            validate_preflight_response(&unused, expected_key).unwrap(),
            LicensePlan::Personal
        );

        let mut active_key = api_key();
        active_key.activation_limit = Some(1);
        active_key.activation_usage = 3;
        let active = PreflightLicenseResponse {
            valid: true,
            error: serde_json::Value::Null,
            license_key: Some(active_key),
            instance: serde_json::Value::Null,
            meta: Some(api_meta(BUSINESS_VARIANT_ID)),
        };
        assert_eq!(
            validate_preflight_response(&active, expected_key).unwrap(),
            LicensePlan::Business
        );
    }

    #[test]
    fn activation_preflight_rejects_foreign_products_and_non_null_instances() {
        let expected_key = "38b1460a-5104-4067-a91d-77b872934d51";
        let mut foreign_meta = api_meta(PERSONAL_VARIANT_ID);
        foreign_meta.product_id += 1;
        let foreign = PreflightLicenseResponse {
            valid: true,
            error: serde_json::Value::Null,
            license_key: Some(api_key()),
            instance: serde_json::Value::Null,
            meta: Some(foreign_meta),
        };
        assert!(validate_preflight_response(&foreign, expected_key).is_err());

        let with_instance = PreflightLicenseResponse {
            valid: true,
            error: serde_json::Value::Null,
            license_key: Some(api_key()),
            instance: serde_json::json!({ "id": "unexpected" }),
            meta: Some(api_meta(PERSONAL_VARIANT_ID)),
        };
        assert!(validate_preflight_response(&with_instance, expected_key).is_err());
    }

    #[test]
    fn rollback_uses_only_the_exact_created_instance_identity() {
        let expected_name = "Macnu-47596ad9-a811-4ebf-ac8a-03fc7b6d2a17";
        let mut response = ActivateLicenseResponse {
            activated: true,
            error: serde_json::Value::Null,
            license_key: Some(api_key()),
            instance: Some(api_instance(expected_name)),
            meta: Some(api_meta(PERSONAL_VARIANT_ID)),
        };
        assert_eq!(
            rollback_instance_id(&response, expected_name),
            Some("f90ec370-fd83-46a5-8bbd-44a241e78665")
        );

        response.instance.as_mut().unwrap().name = "Another device".to_string();
        assert_eq!(rollback_instance_id(&response, expected_name), None);
        response.instance.as_mut().unwrap().name = expected_name.to_string();
        response.instance.as_mut().unwrap().id = "not-an-instance-id".to_string();
        assert_eq!(rollback_instance_id(&response, expected_name), None);
    }

    #[test]
    fn transient_storage_failure_is_retryable_without_relaunch() {
        let mut runtime = LicenseRuntime {
            record: None,
            validation_requests: 0,
            notice: Some(LicenseNotice::StorageUnavailable),
            storage_available: false,
            discard_stored_record: false,
        };
        assert_eq!(
            storage_recovery_action(&runtime),
            StorageRecoveryAction::Reload
        );

        runtime.discard_stored_record = true;
        assert_eq!(
            storage_recovery_action(&runtime),
            StorageRecoveryAction::Delete
        );
        runtime.storage_available = true;
        assert_eq!(
            storage_recovery_action(&runtime),
            StorageRecoveryAction::None
        );
    }

    #[test]
    fn malformed_refresh_response_preserves_the_verified_license() {
        let installation_id = "47596ad9-a811-4ebf-ac8a-03fc7b6d2a17";
        let record = StoredLicense {
            version: LICENSE_RECORD_VERSION,
            license_key: "38b1460a-5104-4067-a91d-77b872934d51".to_string(),
            instance_id: "f90ec370-fd83-46a5-8bbd-44a241e78665".to_string(),
            installation_id: installation_id.to_string(),
            variant_id: PERSONAL_VARIANT_ID,
            last_validated_at: 100,
            expires_at: None,
        };
        let manager = LicenseManager {
            runtime: Arc::new(Mutex::new(LicenseRuntime {
                record: Some(record),
                validation_requests: 0,
                notice: None,
                storage_available: true,
                discard_stored_record: false,
            })),
            request_lock: Arc::new(Mutex::new(())),
            storage_lock: Arc::new(Mutex::new(())),
            client: reqwest::blocking::Client::new(),
            installation_id: Arc::new(Mutex::new(Some(installation_id.to_string()))),
        };

        assert_eq!(
            manager.invalidate_remote_error(LicenseRemoteError::SecurityMismatch),
            "Macnu could not verify the license service response."
        );
        let runtime = manager.runtime.lock().unwrap();
        assert!(runtime.record.is_some());
        assert_eq!(runtime.notice, Some(LicenseNotice::ServiceUnavailable));
    }

    #[test]
    fn successful_api_payload_requires_an_explicit_null_error_field() {
        let missing_error = r#"{
            "activated":true,
            "license_key":null,
            "instance":null,
            "meta":null
        }"#;
        assert!(serde_json::from_str::<ActivateLicenseResponse>(missing_error).is_err());

        let missing_preflight_instance = r#"{
            "valid":true,
            "error":null,
            "license_key":null,
            "meta":null
        }"#;
        assert!(
            serde_json::from_str::<PreflightLicenseResponse>(missing_preflight_instance).is_err()
        );
    }

    #[test]
    fn validation_is_due_daily_and_offline_grace_ends_after_seven_days() {
        let validated_at = 1_000_000;
        let before_day = license_timing(
            validated_at,
            None,
            validated_at + LICENSE_VALIDATION_CADENCE.as_secs() - 1,
        );
        assert!(!before_day.0);
        assert!(before_day.1);

        let at_day = license_timing(
            validated_at,
            None,
            validated_at + LICENSE_VALIDATION_CADENCE.as_secs(),
        );
        assert!(at_day.0);
        assert!(at_day.1);

        let at_grace_end = license_timing(
            validated_at,
            None,
            validated_at + LICENSE_OFFLINE_GRACE.as_secs(),
        );
        assert!(at_grace_end.1);
        let after_grace = license_timing(
            validated_at,
            None,
            validated_at + LICENSE_OFFLINE_GRACE.as_secs() + 1,
        );
        assert!(!after_grace.1);

        let clock_rollback = license_timing(validated_at, None, validated_at - 1);
        assert!(clock_rollback.0);
        assert!(!clock_rollback.1);

        let expiry = validated_at + 2 * LICENSE_VALIDATION_CADENCE.as_secs();
        let before_expiry = license_timing(validated_at, Some(expiry), expiry - 1);
        assert!(before_expiry.1);
        assert_eq!(before_expiry.2, Some(expiry));
        let at_expiry = license_timing(validated_at, Some(expiry), expiry);
        assert!(at_expiry.0);
        assert!(!at_expiry.1);
    }

    #[test]
    fn stored_license_is_bound_to_the_device_installation_identifier() {
        let installation_id = "47596ad9-a811-4ebf-ac8a-03fc7b6d2a17";
        let record = StoredLicense {
            version: LICENSE_RECORD_VERSION,
            license_key: "38b1460a-5104-4067-a91d-77b872934d51".to_string(),
            instance_id: "f90ec370-fd83-46a5-8bbd-44a241e78665".to_string(),
            installation_id: installation_id.to_string(),
            variant_id: PERSONAL_VARIANT_ID,
            last_validated_at: 100,
            expires_at: None,
        };

        assert!(stored_license_is_valid(&record, installation_id));
        assert!(!stored_license_is_valid(
            &record,
            "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"
        ));
    }

    #[test]
    fn recently_checked_but_expired_record_still_requires_network_validation() {
        let now = 2_000_000;
        let record = StoredLicense {
            version: LICENSE_RECORD_VERSION,
            license_key: "38b1460a-5104-4067-a91d-77b872934d51".to_string(),
            instance_id: "f90ec370-fd83-46a5-8bbd-44a241e78665".to_string(),
            installation_id: "47596ad9-a811-4ebf-ac8a-03fc7b6d2a17".to_string(),
            variant_id: PERSONAL_VARIANT_ID,
            last_validated_at: now - 60,
            expires_at: Some(now),
        };

        assert!(stored_license_validation_is_due(&record, now));
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
    fn self_entry_is_identified_by_process_and_keeps_native_activation_label() {
        let mut catalog = response();
        catalog.icons[0].activation_pid = i32::try_from(std::process::id()).ok();
        catalog.icons[0].label = "Macnu — Command+Semicolon".to_string();

        identify_macnu_icons(&mut catalog);

        assert!(catalog.icons[0].is_macnu);
        assert_eq!(catalog.icons[0].label, "Macnu — Command+Semicolon");
        assert!(!catalog.icons[1].is_macnu);
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
