use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    ffi::{c_char, CStr, CString},
    fs,
    io::Read,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
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
    #[serde(default)]
    item_id: Option<String>,
    #[serde(default)]
    display_key: Option<String>,
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
#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct MenuActionPathSegment {
    title: String,
    occurrence: usize,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct MenuAction {
    id: String,
    title: String,
    path: Vec<MenuActionPathSegment>,
    enabled: bool,
    shortcut: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct MenuActionsResponse {
    actions: Vec<MenuAction>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MenuActionsRequest {
    icon: ActivationRequest,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MenuActionActivationRequest {
    icon: ActivationRequest,
    action: MenuAction,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct MenuResponse {
    icons: Vec<MenuIcon>,
    display_id: u32,
    #[serde(default)]
    display_key: String,
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
const PREFERENCES_STATE_VERSION: u8 = 1;
const CATALOG_STATE_VERSION: u8 = 2;
const GLOBAL_PERSONALIZATION_SCOPE: &str = "global";
const MAX_PERSONALIZED_ITEMS: usize = 512;
const MAX_PERSONALIZED_DISPLAYS: usize = 64;
const MAX_FAVORITES_PER_SCOPE: usize = 256;
const MAX_ALIAS_CHARACTERS: usize = 48;
const MAX_USAGE_COUNT: u64 = 1_000_000;
const MAX_SAVED_ACTIONS: usize = 256;
const MAX_SAVED_ACTION_ID_BYTES: usize = 64;
const MAX_ACTION_PATH_DEPTH: usize = 16;
const MAX_ACTION_TITLE_CHARACTERS: usize = 128;
const MAX_ACTION_DESCRIPTOR_ID_BYTES: usize = 4_096;
const MAX_ACTION_SHORTCUT_CHARACTERS: usize = 64;
const MAX_SAVED_ACTION_OWNER_CHARACTERS: usize = 128;
const MAX_SAVED_ACTION_LABEL_CHARACTERS: usize = 256;
const MAX_ACTION_PATH_OCCURRENCE: usize = 4_096;
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

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum RankingMode {
    #[default]
    Smart,
    MenuBar,
    Alphabetical,
}

fn default_true() -> bool {
    true
}

fn preferences_state_version() -> u8 {
    PREFERENCES_STATE_VERSION
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    #[serde(default = "preferences_state_version")]
    version: u8,
    shortcut: String,
    #[serde(default)]
    onboarding_completed: bool,
    #[serde(default)]
    ranking_mode: RankingMode,
    #[serde(default = "default_true")]
    personalize_per_display: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            version: PREFERENCES_STATE_VERSION,
            shortcut: DEFAULT_SHORTCUT.to_string(),
            onboarding_completed: false,
            ranking_mode: RankingMode::Smart,
            personalize_per_display: true,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageStats {
    #[serde(default)]
    count: u64,
    #[serde(default)]
    last_used_at: Option<u64>,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ItemCustomization {
    #[serde(default)]
    alias: Option<String>,
    #[serde(default)]
    shortcut: Option<String>,
    #[serde(default)]
    global_usage: UsageStats,
    #[serde(default)]
    hidden: bool,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DisplayCustomization {
    #[serde(default)]
    favorites: Vec<String>,
    #[serde(default)]
    usage: HashMap<String, UsageStats>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedAction {
    parent_item_id: String,
    owner: String,
    parent_label: String,
    action: MenuAction,
    #[serde(default)]
    alias: Option<String>,
    #[serde(default)]
    shortcut: Option<String>,
    #[serde(default)]
    global_usage: UsageStats,
    #[serde(default)]
    display_usage: HashMap<String, UsageStats>,
}

fn catalog_state_version() -> u8 {
    CATALOG_STATE_VERSION
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogState {
    #[serde(default = "catalog_state_version")]
    version: u8,
    #[serde(default)]
    items: HashMap<String, ItemCustomization>,
    #[serde(default)]
    global_favorites: Vec<String>,
    #[serde(default)]
    displays: HashMap<String, DisplayCustomization>,
    #[serde(default)]
    saved_actions: HashMap<String, SavedAction>,
}

impl Default for CatalogState {
    fn default() -> Self {
        Self {
            version: CATALOG_STATE_VERSION,
            items: HashMap::new(),
            global_favorites: Vec::new(),
            displays: HashMap::new(),
            saved_actions: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogStateV1 {
    #[serde(default)]
    items: HashMap<String, ItemCustomization>,
    #[serde(default)]
    global_favorites: Vec<String>,
    #[serde(default)]
    displays: HashMap<String, DisplayCustomization>,
}

#[derive(Clone)]
struct CatalogStateStore {
    state: Arc<Mutex<CatalogState>>,
    write_lock: Arc<Mutex<()>>,
    path: PathBuf,
    write_protected: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ItemCustomizationView {
    alias: Option<String>,
    shortcut: Option<String>,
    favorite: bool,
    usage_count: u64,
    last_used_at: Option<u64>,
    hidden: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedActionView {
    id: String,
    parent_item_id: String,
    owner: String,
    parent_label: String,
    action: MenuAction,
    alias: Option<String>,
    shortcut: Option<String>,
    usage_count: u64,
    last_used_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogCustomizationsResponse {
    ranking_mode: RankingMode,
    personalize_per_display: bool,
    display_key: String,
    items: HashMap<String, ItemCustomizationView>,
    saved_actions: HashMap<String, SavedActionView>,
}

#[derive(Clone)]
struct PreferencesState {
    preferences: Arc<Mutex<Preferences>>,
    write_lock: Arc<Mutex<()>>,
    path: PathBuf,
    write_protected: bool,
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
    ranking_mode: RankingMode,
    personalize_per_display: bool,
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
    fn macnu_copy_menu_actions_json(request_json: *const c_char) -> *mut c_char;
    fn macnu_activate_menu_action_json(request_json: *const c_char) -> i32;
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
    let display_key =
        valid_display_key(&response.display_key).then(|| response.display_key.clone());
    if display_key.is_none() {
        response.display_key.clear();
    }
    for icon in &mut response.icons {
        icon.is_macnu = is_current_process_icon(icon);
        icon.display_key = display_key.clone();
        if icon.is_macnu
            || icon
                .item_id
                .as_deref()
                .is_some_and(|item_id| !valid_item_id(item_id))
        {
            icon.item_id = None;
        }
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
async fn list_menu_actions(app: AppHandle, icon: MenuIcon) -> Result<MenuActionsResponse, String> {
    #[cfg(target_os = "macos")]
    {
        require_ready(&app)?;
        if icon.is_macnu && is_current_process_icon(&icon) {
            return Ok(MenuActionsResponse {
                actions: Vec::new(),
                error: None,
            });
        }

        let action_app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            require_ready(&action_app)?;
            let request = MenuActionsRequest {
                icon: ActivationRequest::from(icon),
            };
            let request_json = serde_json::to_string(&request)
                .map_err(|error| format!("Could not encode the menu action request: {error}"))?;
            let request_json = CString::new(request_json)
                .map_err(|_| "The menu action request contains invalid text.".to_string())?;
            let response_json = copy_native_owned_string(unsafe {
                macnu_copy_menu_actions_json(request_json.as_ptr())
            })
            .ok_or_else(|| "macOS did not return a menu action response.".to_string())?;
            serde_json::from_str(&response_json)
                .map_err(|error| format!("Could not decode the menu actions: {error}"))
        })
        .await
        .map_err(|error| format!("Menu action discovery task failed: {error}"))?
    }

    #[cfg(not(target_os = "macos"))]
    Err("Macnu only supports macOS.".to_string())
}

#[cfg(target_os = "macos")]
fn run_native_menu_action(
    app: &AppHandle,
    icon: MenuIcon,
    action: MenuAction,
) -> Result<(), String> {
    require_ready(app)?;
    let request = MenuActionActivationRequest {
        icon: ActivationRequest::from(icon),
        action,
    };
    let request_json = serde_json::to_string(&request)
        .map_err(|error| format!("Could not encode the menu action: {error}"))?;
    let request_json = CString::new(request_json)
        .map_err(|_| "The menu action contains invalid text.".to_string())?;
    match unsafe { macnu_activate_menu_action_json(request_json.as_ptr()) } {
        0 => Ok(()),
        1 => Err("That menu-bar item is no longer available.".to_string()),
        2 => Err("Accessibility permission is required to run menu actions.".to_string()),
        3 => Err("That menu action changed. Open Actions again to refresh it.".to_string()),
        4 => Err("The menu action request was invalid.".to_string()),
        5 => Err("That menu action is currently unavailable.".to_string()),
        _ => Err("macOS could not run that menu action.".to_string()),
    }
}

#[cfg(target_os = "macos")]
fn run_native_menu_icon(app: &AppHandle, icon: MenuIcon) -> Result<(), String> {
    require_ready(app)?;
    let request = ActivationRequest::from(icon);
    let request_json = serde_json::to_string(&request)
        .map_err(|error| format!("Could not encode the activation catalog entry: {error}"))?;
    let request_json = CString::new(request_json)
        .map_err(|_| "The activation catalog entry contains invalid text.".to_string())?;
    match unsafe { macnu_activate_menu_icon_json(request_json.as_ptr()) } {
        0 => Ok(()),
        1 => Err("That menu item is no longer available.".to_string()),
        2 => Err("Accessibility permission is required to open menu items.".to_string()),
        _ => Err("macOS could not activate that menu item.".to_string()),
    }
}

#[tauri::command]
async fn activate_menu_action(
    app: AppHandle,
    icon: MenuIcon,
    action: MenuAction,
    catalog: State<'_, CatalogStateStore>,
    preferences: State<'_, PreferencesState>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        require_ready(&app)?;
        let action_app = app.clone();
        let catalog = catalog.inner().clone();
        let preferences = preferences.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            run_native_menu_action(&action_app, icon.clone(), action)?;
            let _ = record_successful_usage(&catalog, &preferences, &icon);
            Ok(())
        })
        .await
        .map_err(|error| format!("Menu action task failed: {error}"))?
    }

    #[cfg(not(target_os = "macos"))]
    Err("Macnu only supports macOS.".to_string())
}

#[tauri::command]
async fn activate_menu_icon(
    app: AppHandle,
    icon: MenuIcon,
    catalog: State<'_, CatalogStateStore>,
    preferences: State<'_, PreferencesState>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if icon.is_macnu && is_current_process_icon(&icon) {
            return open_settings(app);
        }
        require_ready(&app)?;
        let activation_app = app.clone();
        let catalog = catalog.inner().clone();
        let preferences = preferences.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            run_native_menu_icon(&activation_app, icon.clone())?;
            let _ = record_successful_usage(&catalog, &preferences, &icon);
            Ok(())
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

#[derive(Debug, Clone)]
struct LoadedPersistentState<T> {
    value: T,
    write_protected: bool,
}

fn stored_version_is_supported(value: &serde_json::Value, current: u8) -> bool {
    match value.get("version") {
        None => true,
        Some(version) => version.as_u64() == Some(u64::from(current)),
    }
}

fn salvage_preferences(value: &serde_json::Value) -> Preferences {
    let mut preferences = Preferences::default();
    if let Some(shortcut) = value.get("shortcut").and_then(serde_json::Value::as_str) {
        if let Ok((shortcut, _)) = normalized_global_shortcut(shortcut) {
            preferences.shortcut = shortcut;
        }
    }
    if let Some(completed) = value
        .get("onboardingCompleted")
        .and_then(serde_json::Value::as_bool)
    {
        preferences.onboarding_completed = completed;
    }
    if let Some(mode) = value.get("rankingMode").and_then(serde_json::Value::as_str) {
        preferences.ranking_mode = match mode {
            "smart" => RankingMode::Smart,
            "menuBar" => RankingMode::MenuBar,
            "alphabetical" => RankingMode::Alphabetical,
            _ => preferences.ranking_mode,
        };
    }
    if let Some(per_display) = value
        .get("personalizePerDisplay")
        .and_then(serde_json::Value::as_bool)
    {
        preferences.personalize_per_display = per_display;
    }
    preferences
}

fn decode_preferences(json: &str) -> LoadedPersistentState<Preferences> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return LoadedPersistentState {
            value: Preferences::default(),
            write_protected: true,
        };
    };
    if !stored_version_is_supported(&value, PREFERENCES_STATE_VERSION) {
        return LoadedPersistentState {
            value: salvage_preferences(&value),
            write_protected: true,
        };
    }

    match serde_json::from_value::<Preferences>(value.clone()) {
        Ok(mut preferences) => {
            preferences.version = PREFERENCES_STATE_VERSION;
            preferences.shortcut = normalized_global_shortcut(&preferences.shortcut)
                .map(|(shortcut, _)| shortcut)
                .unwrap_or_else(|_| DEFAULT_SHORTCUT.to_string());
            LoadedPersistentState {
                value: preferences,
                write_protected: false,
            }
        }
        Err(_) => LoadedPersistentState {
            value: salvage_preferences(&value),
            write_protected: true,
        },
    }
}

fn load_preferences(path: &PathBuf) -> LoadedPersistentState<Preferences> {
    match fs::read_to_string(path) {
        Ok(json) => decode_preferences(&json),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => LoadedPersistentState {
            value: Preferences::default(),
            write_protected: false,
        },
        Err(_) => LoadedPersistentState {
            value: Preferences::default(),
            write_protected: true,
        },
    }
}

fn persist_preferences(state: &PreferencesState, preferences: &Preferences) -> Result<(), String> {
    if state.write_protected {
        return Err(
            "These settings were created by a newer or incompatible Macnu version. Upgrade Macnu before changing them."
                .to_string(),
        );
    }
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

fn migrate_catalog_state_v1(state: CatalogStateV1) -> CatalogState {
    CatalogState {
        version: CATALOG_STATE_VERSION,
        items: state.items,
        global_favorites: state.global_favorites,
        displays: state.displays,
        saved_actions: HashMap::new(),
    }
}

fn decode_catalog_state(
    json: &str,
    now: u64,
    reserved_shortcut_id: Option<u32>,
) -> LoadedPersistentState<CatalogState> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return LoadedPersistentState {
            value: CatalogState::default(),
            write_protected: true,
        };
    };

    let stored_version = match value.get("version") {
        None => 1,
        Some(version) => match version.as_u64() {
            Some(version) => version,
            None => {
                return LoadedPersistentState {
                    value: CatalogState::default(),
                    write_protected: true,
                };
            }
        },
    };
    let decoded = match stored_version {
        1 => serde_json::from_value::<CatalogStateV1>(value).map(migrate_catalog_state_v1),
        version if version == u64::from(CATALOG_STATE_VERSION) => {
            serde_json::from_value::<CatalogState>(value)
        }
        _ => {
            return LoadedPersistentState {
                value: CatalogState::default(),
                write_protected: true,
            };
        }
    };

    match decoded {
        Ok(state) => LoadedPersistentState {
            value: sanitize_catalog_state(state, now, reserved_shortcut_id),
            write_protected: false,
        },
        Err(_) => LoadedPersistentState {
            value: CatalogState::default(),
            write_protected: true,
        },
    }
}

fn load_catalog_state(
    path: &PathBuf,
    reserved_shortcut_id: Option<u32>,
) -> LoadedPersistentState<CatalogState> {
    match fs::read_to_string(path) {
        Ok(json) => decode_catalog_state(&json, unix_timestamp(), reserved_shortcut_id),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => LoadedPersistentState {
            value: CatalogState::default(),
            write_protected: false,
        },
        Err(_) => LoadedPersistentState {
            value: CatalogState::default(),
            write_protected: true,
        },
    }
}

fn persist_catalog_state(store: &CatalogStateStore, state: &CatalogState) -> Result<(), String> {
    if store.write_protected {
        return Err(
            "This personalization data was created by a newer or incompatible Macnu version. Upgrade Macnu before changing it."
                .to_string(),
        );
    }
    let parent = store
        .path
        .parent()
        .ok_or_else(|| "The personalization directory is unavailable.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create the personalization directory: {error}"))?;
    let json = serde_json::to_vec_pretty(state)
        .map_err(|error| format!("Could not encode personalization: {error}"))?;
    let temporary = store.path.with_extension("json.tmp");
    fs::write(&temporary, json)
        .map_err(|error| format!("Could not write personalization: {error}"))?;
    fs::rename(&temporary, &store.path)
        .map_err(|error| format!("Could not save personalization: {error}"))
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn valid_stable_component(component: &str) -> bool {
    !component.is_empty()
        && component
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn valid_versioned_key(
    value: &str,
    namespace: &str,
    component_count: usize,
    max_len: usize,
) -> bool {
    if value.len() > max_len || value.chars().any(char::is_control) {
        return false;
    }
    let mut parts = value.split('.');
    if parts.next() != Some("v1") || parts.next() != Some(namespace) {
        return false;
    }
    let components: Vec<_> = parts.collect();
    components.len() == component_count
        && components
            .iter()
            .all(|component| valid_stable_component(component))
}

fn valid_item_id(item_id: &str) -> bool {
    valid_versioned_key(item_id, "item-identifier", 2, 512)
        || valid_versioned_key(item_id, "item-single", 1, 512)
        || valid_versioned_key(item_id, "item-label-role", 3, 512)
}

fn valid_item_shortcut_id(item_id: &str) -> bool {
    valid_versioned_key(item_id, "item-identifier", 2, 512)
}

fn valid_display_key(display_key: &str) -> bool {
    valid_versioned_key(display_key, "display-uuid", 1, 256)
        || valid_versioned_key(display_key, "display-bounds", 4, 256)
}

fn valid_saved_action_id(saved_action_id: &str) -> bool {
    valid_versioned_key(
        saved_action_id,
        "saved-action",
        1,
        MAX_SAVED_ACTION_ID_BYTES,
    )
}

fn normalized_saved_text(
    value: String,
    maximum_characters: usize,
    field: &str,
) -> Result<String, String> {
    let value = value.trim().to_string();
    if value.is_empty()
        || value.chars().count() > maximum_characters
        || value.chars().any(char::is_control)
    {
        return Err(format!(
            "Saved action {field} must contain 1 to {maximum_characters} visible characters."
        ));
    }
    Ok(value)
}

fn menu_action_identifier(path: &[MenuActionPathSegment]) -> String {
    path.iter()
        .map(|segment| {
            format!(
                "{}:{}#{}",
                segment.title.len(),
                segment.title,
                segment.occurrence
            )
        })
        .collect::<Vec<_>>()
        .join("|")
}

fn validate_menu_action(action: &MenuAction) -> Result<(), String> {
    if action.path.is_empty() || action.path.len() > MAX_ACTION_PATH_DEPTH {
        return Err(format!(
            "Saved actions support menu paths between 1 and {MAX_ACTION_PATH_DEPTH} levels."
        ));
    }
    for segment in &action.path {
        if segment.title.trim() != segment.title
            || segment.title.is_empty()
            || segment.title.chars().count() > MAX_ACTION_TITLE_CHARACTERS
            || segment.title.chars().any(char::is_control)
            || segment.occurrence > MAX_ACTION_PATH_OCCURRENCE
        {
            return Err("That menu action contains invalid or oversized path data.".to_string());
        }
    }
    if action.title
        != action
            .path
            .last()
            .map(|segment| segment.title.as_str())
            .unwrap_or("")
        || action.id.is_empty()
        || action.id.len() > MAX_ACTION_DESCRIPTOR_ID_BYTES
        || action.id.chars().any(char::is_control)
        || action.id != menu_action_identifier(&action.path)
    {
        return Err("That menu action descriptor is invalid or has changed.".to_string());
    }
    if action.shortcut.as_ref().is_some_and(|shortcut| {
        shortcut.chars().count() > MAX_ACTION_SHORTCUT_CHARACTERS
            || shortcut.chars().any(char::is_control)
    }) {
        return Err("That menu action contains invalid shortcut metadata.".to_string());
    }
    Ok(())
}

fn stable_hash64(bytes: &[u8], seed: u64) -> u64 {
    bytes.iter().fold(seed, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
    })
}

fn saved_action_id(parent_item_id: &str, action: &MenuAction) -> String {
    let mut identity = Vec::with_capacity(parent_item_id.len() + action.id.len() + 1);
    identity.extend_from_slice(parent_item_id.as_bytes());
    identity.push(0);
    identity.extend_from_slice(action.id.as_bytes());
    let first = stable_hash64(&identity, 0xcbf29ce484222325);
    let second = stable_hash64(&identity, 0x84222325cbf29ce4);
    format!("v1.saved-action.{first:016x}{second:016x}")
}

fn normalized_alias(alias: Option<String>) -> Result<Option<String>, String> {
    let alias = alias
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(value) = alias.as_ref() {
        if value.chars().count() > MAX_ALIAS_CHARACTERS || value.chars().any(char::is_control) {
            return Err(format!(
                "Aliases can contain up to {MAX_ALIAS_CHARACTERS} visible characters."
            ));
        }
    }
    Ok(alias)
}

fn shortcut_id(shortcut: &str) -> Result<u32, String> {
    let parsed: Shortcut = shortcut
        .parse()
        .map_err(|error| format!("That shortcut is not supported: {error}"))?;
    Ok(parsed.id())
}

fn normalized_global_shortcut(shortcut: &str) -> Result<(String, Shortcut), String> {
    let shortcut = shortcut.trim().to_string();
    if shortcut.split('+').count() < 2 {
        return Err("Use at least one modifier key in the shortcut.".to_string());
    }
    let parsed = shortcut
        .parse()
        .map_err(|error| format!("That shortcut is not supported: {error}"))?;
    Ok((shortcut, parsed))
}

fn normalized_item_shortcut(shortcut: Option<String>) -> Result<Option<String>, String> {
    let shortcut = shortcut
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(value) = shortcut.as_ref() {
        let _ = normalized_global_shortcut(value)?;
    }
    Ok(shortcut)
}
fn sanitize_usage(usage: &mut UsageStats, now: u64) {
    usage.count = usage.count.min(MAX_USAGE_COUNT);
    usage.last_used_at = match (usage.count, usage.last_used_at) {
        (0, _) => None,
        (_, Some(timestamp)) => Some(timestamp.min(now)),
        (_, None) => None,
    };
}

fn sanitize_saved_action(
    saved_action_id_value: &str,
    mut saved_action: SavedAction,
    now: u64,
) -> Option<SavedAction> {
    if !valid_saved_action_id(saved_action_id_value)
        || !valid_item_id(&saved_action.parent_item_id)
        || saved_action_id(&saved_action.parent_item_id, &saved_action.action)
            != saved_action_id_value
        || validate_menu_action(&saved_action.action).is_err()
    {
        return None;
    }
    saved_action.owner = normalized_saved_text(
        saved_action.owner,
        MAX_SAVED_ACTION_OWNER_CHARACTERS,
        "owner",
    )
    .ok()?;
    saved_action.parent_label = normalized_saved_text(
        saved_action.parent_label,
        MAX_SAVED_ACTION_LABEL_CHARACTERS,
        "parent label",
    )
    .ok()?;
    saved_action.alias = normalized_alias(saved_action.alias).ok().flatten();
    saved_action.shortcut = if valid_item_shortcut_id(&saved_action.parent_item_id) {
        normalized_item_shortcut(saved_action.shortcut)
            .ok()
            .flatten()
    } else {
        None
    };
    sanitize_usage(&mut saved_action.global_usage, now);

    let mut display_usage: Vec<_> = saved_action
        .display_usage
        .into_iter()
        .filter(|(display_key, _)| valid_display_key(display_key))
        .collect();
    display_usage.sort_by(|left, right| left.0.cmp(&right.0));
    display_usage.truncate(MAX_PERSONALIZED_DISPLAYS);
    saved_action.display_usage = display_usage
        .into_iter()
        .filter_map(|(display_key, mut usage)| {
            sanitize_usage(&mut usage, now);
            (usage != UsageStats::default()).then_some((display_key, usage))
        })
        .collect();
    Some(saved_action)
}

fn sanitize_direct_shortcut_collisions(
    items: &mut HashMap<String, ItemCustomization>,
    saved_actions: &mut HashMap<String, SavedAction>,
    reserved_shortcut_id: Option<u32>,
) {
    let mut counts = HashMap::new();
    for id in items
        .values()
        .filter_map(|item| item.shortcut.as_deref())
        .chain(
            saved_actions
                .values()
                .filter_map(|action| action.shortcut.as_deref()),
        )
        .filter_map(|shortcut| shortcut_id(shortcut).ok())
    {
        *counts.entry(id).or_insert(0usize) += 1;
    }
    let keep = |shortcut: &Option<String>| {
        shortcut
            .as_deref()
            .and_then(|value| shortcut_id(value).ok())
            .is_some_and(|id| {
                counts.get(&id).copied() == Some(1) && reserved_shortcut_id != Some(id)
            })
    };
    for item in items.values_mut() {
        if item.shortcut.is_some() && !keep(&item.shortcut) {
            item.shortcut = None;
        }
    }
    for action in saved_actions.values_mut() {
        if action.shortcut.is_some() && !keep(&action.shortcut) {
            action.shortcut = None;
        }
    }
}

fn sanitize_item_references(references: Vec<String>, item_ids: &HashSet<String>) -> Vec<String> {
    let mut references: Vec<_> = references
        .into_iter()
        .filter(|item_id| item_ids.contains(item_id))
        .collect();
    references.sort();
    references.dedup();
    references.truncate(MAX_FAVORITES_PER_SCOPE);
    references
}

fn item_is_referenced(catalog: &CatalogState, item_id: &str) -> bool {
    catalog
        .global_favorites
        .iter()
        .any(|favorite| favorite == item_id)
        || catalog.displays.values().any(|display| {
            display.favorites.iter().any(|favorite| favorite == item_id)
                || display.usage.contains_key(item_id)
        })
}

fn item_customization_is_empty(customization: &ItemCustomization) -> bool {
    customization.alias.is_none()
        && customization.shortcut.is_none()
        && customization.global_usage == UsageStats::default()
        && !customization.hidden
}

fn item_is_favorite(catalog: &CatalogState, item_id: &str) -> bool {
    catalog
        .global_favorites
        .iter()
        .any(|favorite| favorite == item_id)
        || catalog
            .displays
            .values()
            .any(|display| display.favorites.iter().any(|favorite| favorite == item_id))
}

fn latest_item_usage(catalog: &CatalogState, item_id: &str) -> u64 {
    let global = catalog
        .items
        .get(item_id)
        .and_then(|item| item.global_usage.last_used_at)
        .unwrap_or_default();
    catalog
        .displays
        .values()
        .filter_map(|display| display.usage.get(item_id)?.last_used_at)
        .fold(global, u64::max)
}

fn evict_oldest_usage_only_item(catalog: &mut CatalogState) -> Option<String> {
    let candidate = catalog
        .items
        .iter()
        .filter(|(item_id, item)| {
            item.alias.is_none()
                && item.shortcut.is_none()
                && !item.hidden
                && !item_is_favorite(catalog, item_id)
        })
        .map(|(item_id, _)| (latest_item_usage(catalog, item_id), item_id.clone()))
        .min()
        .map(|(_, item_id)| item_id)?;

    catalog.items.remove(&candidate);
    for display in catalog.displays.values_mut() {
        display.usage.remove(&candidate);
    }
    Some(candidate)
}

fn ensure_catalog_item_capacity(catalog: &mut CatalogState) -> bool {
    catalog.items.len() < MAX_PERSONALIZED_ITEMS || evict_oldest_usage_only_item(catalog).is_some()
}

fn retain_catalog_items_within_limit(catalog: &mut CatalogState) {
    if catalog.items.len() <= MAX_PERSONALIZED_ITEMS {
        return;
    }

    // The capacity is a bound on automatically accumulated usage history, not
    // a license to discard explicit user customizations. A deliberately or
    // previously oversized protected set may therefore remain above the soft
    // limit; every usage-only record is still removed in that exceptional case.
    let mut retained: HashSet<_> = catalog
        .items
        .iter()
        .filter(|(item_id, item)| {
            item.alias.is_some()
                || item.shortcut.is_some()
                || item.hidden
                || item_is_favorite(catalog, item_id)
        })
        .map(|(item_id, _)| item_id.clone())
        .collect();

    let available_usage_slots = MAX_PERSONALIZED_ITEMS.saturating_sub(retained.len());
    let mut usage_only_item_ids: Vec<_> = catalog
        .items
        .keys()
        .filter(|item_id| !retained.contains(*item_id))
        .cloned()
        .collect();
    usage_only_item_ids.sort_by(|left_id, right_id| {
        latest_item_usage(catalog, right_id)
            .cmp(&latest_item_usage(catalog, left_id))
            .then_with(|| left_id.cmp(right_id))
    });
    retained.extend(usage_only_item_ids.into_iter().take(available_usage_slots));

    catalog
        .items
        .retain(|item_id, _| retained.contains(item_id));
    catalog
        .global_favorites
        .retain(|item_id| retained.contains(item_id));
    for display in catalog.displays.values_mut() {
        display
            .favorites
            .retain(|item_id| retained.contains(item_id));
        display
            .usage
            .retain(|item_id, _| retained.contains(item_id));
    }
}

fn prune_catalog_state(catalog: &mut CatalogState) {
    for display in catalog.displays.values_mut() {
        display
            .usage
            .retain(|_, usage| usage != &UsageStats::default());
    }

    let removable: Vec<_> = catalog
        .items
        .iter()
        .filter(|(item_id, customization)| {
            item_customization_is_empty(customization) && !item_is_referenced(catalog, item_id)
        })
        .map(|(item_id, _)| item_id.clone())
        .collect();
    for item_id in removable {
        catalog.items.remove(&item_id);
    }
}

fn sanitize_catalog_state(
    state: CatalogState,
    now: u64,
    reserved_shortcut_id: Option<u32>,
) -> CatalogState {
    if state.version != CATALOG_STATE_VERSION {
        return CatalogState::default();
    }

    let mut items = HashMap::new();
    for (item_id, mut customization) in state
        .items
        .into_iter()
        .filter(|(item_id, _)| valid_item_id(item_id))
    {
        customization.alias = normalized_alias(customization.alias).ok().flatten();
        customization.shortcut = if valid_item_shortcut_id(&item_id) {
            normalized_item_shortcut(customization.shortcut)
                .ok()
                .flatten()
        } else {
            None
        };
        sanitize_usage(&mut customization.global_usage, now);
        items.insert(item_id, customization);
    }

    let mut raw_saved_actions: Vec<_> = state.saved_actions.into_iter().collect();
    raw_saved_actions.sort_by(|left, right| left.0.cmp(&right.0));
    raw_saved_actions.truncate(MAX_SAVED_ACTIONS);
    let mut saved_actions: HashMap<_, _> = raw_saved_actions
        .into_iter()
        .filter_map(|(id, saved_action)| {
            sanitize_saved_action(&id, saved_action, now).map(|saved_action| (id, saved_action))
        })
        .collect();
    sanitize_direct_shortcut_collisions(&mut items, &mut saved_actions, reserved_shortcut_id);

    let item_ids: HashSet<_> = items.keys().cloned().collect();
    let global_favorites = sanitize_item_references(state.global_favorites, &item_ids);

    let mut raw_displays: Vec<_> = state
        .displays
        .into_iter()
        .filter(|(display_key, _)| valid_display_key(display_key))
        .collect();
    raw_displays.sort_by(|left, right| left.0.cmp(&right.0));
    raw_displays.truncate(MAX_PERSONALIZED_DISPLAYS);

    let mut displays = HashMap::new();
    for (display_key, display) in raw_displays {
        let favorites = sanitize_item_references(display.favorites, &item_ids);
        let mut usage = HashMap::new();
        for (item_id, mut stats) in display
            .usage
            .into_iter()
            .filter(|(item_id, _)| item_ids.contains(item_id))
        {
            sanitize_usage(&mut stats, now);
            if stats != UsageStats::default() {
                usage.insert(item_id, stats);
            }
        }
        // An empty display record is an explicit per-display override of global
        // favorites, so it must survive sanitization and relaunch.
        displays.insert(display_key, DisplayCustomization { favorites, usage });
    }

    let mut sanitized = CatalogState {
        version: CATALOG_STATE_VERSION,
        items,
        global_favorites,
        displays,
        saved_actions,
    };
    prune_catalog_state(&mut sanitized);
    retain_catalog_items_within_limit(&mut sanitized);
    sanitized
}

fn customization_scope<'a>(preferences: &Preferences, display_key: &'a str) -> &'a str {
    if preferences.personalize_per_display {
        display_key
    } else {
        GLOBAL_PERSONALIZATION_SCOPE
    }
}

fn resolved_customizations(
    catalog: &CatalogState,
    preferences: &Preferences,
    display_key: &str,
) -> CatalogCustomizationsResponse {
    let scope = customization_scope(preferences, display_key);
    let favorites = if scope == GLOBAL_PERSONALIZATION_SCOPE {
        &catalog.global_favorites
    } else {
        catalog
            .displays
            .get(scope)
            .map(|display| &display.favorites)
            .unwrap_or(&catalog.global_favorites)
    };
    let display_usage = (scope != GLOBAL_PERSONALIZATION_SCOPE)
        .then(|| catalog.displays.get(scope))
        .flatten();

    let items = catalog
        .items
        .iter()
        .map(|(item_id, customization)| {
            let usage = display_usage
                .and_then(|display| display.usage.get(item_id))
                .unwrap_or(&customization.global_usage);
            (
                item_id.clone(),
                ItemCustomizationView {
                    alias: customization.alias.clone(),
                    shortcut: customization.shortcut.clone(),
                    favorite: favorites.contains(item_id),
                    usage_count: usage.count,
                    last_used_at: usage.last_used_at,
                    hidden: customization.hidden,
                },
            )
        })
        .collect();

    let saved_actions = catalog
        .saved_actions
        .iter()
        .map(|(id, saved_action)| {
            let usage = if scope == GLOBAL_PERSONALIZATION_SCOPE {
                &saved_action.global_usage
            } else {
                saved_action
                    .display_usage
                    .get(scope)
                    .unwrap_or(&saved_action.global_usage)
            };
            (
                id.clone(),
                SavedActionView {
                    id: id.clone(),
                    parent_item_id: saved_action.parent_item_id.clone(),
                    owner: saved_action.owner.clone(),
                    parent_label: saved_action.parent_label.clone(),
                    action: saved_action.action.clone(),
                    alias: saved_action.alias.clone(),
                    shortcut: saved_action.shortcut.clone(),
                    usage_count: usage.count,
                    last_used_at: usage.last_used_at,
                },
            )
        })
        .collect();

    CatalogCustomizationsResponse {
        ranking_mode: preferences.ranking_mode,
        personalize_per_display: preferences.personalize_per_display,
        display_key: display_key.to_string(),
        items,
        saved_actions,
    }
}

fn current_customizations(
    store: &CatalogStateStore,
    preferences: &PreferencesState,
    display_key: &str,
) -> Result<CatalogCustomizationsResponse, String> {
    if !valid_display_key(display_key) {
        return Err("That display is no longer available.".to_string());
    }
    let preferences = preferences
        .preferences
        .lock()
        .map_err(|_| "The settings are unavailable.".to_string())?
        .clone();
    let catalog = store
        .state
        .lock()
        .map_err(|_| "The personalization data is unavailable.".to_string())?
        .clone();
    Ok(resolved_customizations(&catalog, &preferences, display_key))
}

fn update_favorite_list(
    favorites: &mut Vec<String>,
    item_id: &str,
    favorite: bool,
) -> Result<(), String> {
    let already_favorite = favorites.iter().any(|existing| existing == item_id);
    if favorite && !already_favorite && favorites.len() >= MAX_FAVORITES_PER_SCOPE {
        return Err("Macnu has reached the pins limit for this display.".to_string());
    }
    favorites.retain(|existing| existing != item_id);
    if favorite {
        favorites.push(item_id.to_string());
    }
    Ok(())
}

fn ensure_display_customization<'a>(
    catalog: &'a mut CatalogState,
    display_key: &str,
) -> Result<&'a mut DisplayCustomization, String> {
    if !catalog.displays.contains_key(display_key)
        && catalog.displays.len() >= MAX_PERSONALIZED_DISPLAYS
    {
        return Err("Macnu has reached its local display personalization limit.".to_string());
    }
    let inherited_favorites = catalog.global_favorites.clone();
    Ok(catalog
        .displays
        .entry(display_key.to_string())
        .or_insert_with(|| DisplayCustomization {
            favorites: inherited_favorites,
            usage: HashMap::new(),
        }))
}

fn update_display_favorite(
    catalog: &mut CatalogState,
    display_key: &str,
    item_id: &str,
    favorite: bool,
) -> Result<(), String> {
    let inherited_favorite = catalog
        .global_favorites
        .iter()
        .any(|existing| existing == item_id);
    if !catalog.displays.contains_key(display_key) && favorite == inherited_favorite {
        return Ok(());
    }
    update_favorite_list(
        &mut ensure_display_customization(catalog, display_key)?.favorites,
        item_id,
        favorite,
    )
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
        ranking_mode: preferences.ranking_mode,
        personalize_per_display: preferences.personalize_per_display,
    })
}

#[tauri::command]
fn get_settings(state: State<'_, PreferencesState>) -> Result<SettingsResponse, String> {
    current_settings(state.inner())
}

#[tauri::command]
fn get_catalog_customizations(
    display_key: String,
    catalog: State<'_, CatalogStateStore>,
    preferences: State<'_, PreferencesState>,
) -> Result<CatalogCustomizationsResponse, String> {
    current_customizations(catalog.inner(), preferences.inner(), &display_key)
}

fn menu_cache_contains_item(
    cache: &MenuCache,
    display_key: &str,
    item_id: &str,
) -> Result<bool, String> {
    Ok(menu_cache_item(cache, display_key, item_id)?.is_some())
}

fn menu_cache_item(
    cache: &MenuCache,
    display_key: &str,
    item_id: &str,
) -> Result<Option<MenuIcon>, String> {
    let responses = cache
        .responses
        .lock()
        .map_err(|_| "The menu cache is unavailable.".to_string())?;
    Ok(responses
        .values()
        .filter(|entry| entry.response.display_key == display_key)
        .flat_map(|entry| entry.response.icons.iter())
        .find(|icon| !icon.is_macnu && icon.item_id.as_deref() == Some(item_id))
        .cloned())
}

fn resolve_saved_action_parent_with_refresh<Lookup>(
    display_key: &str,
    item_id: &str,
    mut lookup: Lookup,
) -> Result<MenuIcon, String>
where
    Lookup: FnMut(bool) -> Result<Option<MenuIcon>, String>,
{
    for force in [false, true] {
        if let Some(icon) = lookup(force)? {
            if !icon.is_macnu
                && icon.item_id.as_deref() == Some(item_id)
                && icon.display_key.as_deref() == Some(display_key)
            {
                return Ok(icon);
            }
        }
    }

    Err("That menu-bar item is no longer available on this display.".to_string())
}

fn restore_released_shortcuts<Restore>(shortcuts: &[String], restore: &mut Restore) -> Vec<String>
where
    Restore: FnMut(&str) -> Result<(), String>,
{
    let mut errors = Vec::new();
    for shortcut in shortcuts.iter().rev() {
        if let Err(error) = restore(shortcut) {
            errors.push(format!("Could not restore {shortcut}: {error}"));
        }
    }
    errors
}

fn error_with_rollback_details(primary: String, rollback_errors: Vec<String>) -> String {
    if rollback_errors.is_empty() {
        primary
    } else {
        format!(
            "{primary} Rollback also failed: {}",
            rollback_errors.join("; ")
        )
    }
}

fn release_shortcuts_atomically<Release, Restore>(
    shortcuts: &[String],
    mut release: Release,
    mut restore: Restore,
) -> Result<Vec<String>, String>
where
    Release: FnMut(&str) -> Result<(), String>,
    Restore: FnMut(&str) -> Result<(), String>,
{
    let mut released = Vec::new();
    for shortcut in shortcuts {
        if let Err(error) = release(shortcut) {
            let rollback_errors = restore_released_shortcuts(&released, &mut restore);
            return Err(error_with_rollback_details(
                format!("Could not release {shortcut}: {error}"),
                rollback_errors,
            ));
        }
        released.push(shortcut.clone());
    }
    Ok(released)
}

fn replace_shortcut_atomically<Release, Register, Persist>(
    current: &str,
    replacement: &str,
    mut release: Release,
    mut register: Register,
    persist: Persist,
) -> Result<(), String>
where
    Release: FnMut(&str) -> Result<(), String>,
    Register: FnMut(&str) -> Result<(), String>,
    Persist: FnOnce() -> Result<(), String>,
{
    release(current).map_err(|error| format!("Could not release the current shortcut: {error}"))?;

    if let Err(error) = register(replacement) {
        let rollback_errors = restore_released_shortcuts(&[current.to_string()], &mut register);
        return Err(error_with_rollback_details(
            format!("That shortcut is already in use or unavailable: {error}"),
            rollback_errors,
        ));
    }

    if let Err(error) = persist() {
        let mut rollback_errors = Vec::new();
        if let Err(rollback_error) = release(replacement) {
            rollback_errors.push(format!(
                "Could not release the new shortcut {replacement}: {rollback_error}"
            ));
        }
        rollback_errors.extend(restore_released_shortcuts(
            &[current.to_string()],
            &mut register,
        ));
        return Err(error_with_rollback_details(error, rollback_errors));
    }

    Ok(())
}

fn direct_shortcut_conflicts(
    catalog: &CatalogState,
    desired_id: u32,
    excluded_item_id: Option<&str>,
    excluded_saved_action_id: Option<&str>,
) -> bool {
    catalog.items.iter().any(|(item_id, item)| {
        Some(item_id.as_str()) != excluded_item_id
            && item
                .shortcut
                .as_deref()
                .and_then(|shortcut| shortcut_id(shortcut).ok())
                == Some(desired_id)
    }) || catalog
        .saved_actions
        .iter()
        .any(|(saved_action_id, action)| {
            Some(saved_action_id.as_str()) != excluded_saved_action_id
                && action
                    .shortcut
                    .as_deref()
                    .and_then(|shortcut| shortcut_id(shortcut).ok())
                    == Some(desired_id)
        })
}

fn persist_catalog_with_shortcut_change(
    app: &AppHandle,
    store: &CatalogStateStore,
    updated: CatalogState,
    old_shortcut: Option<String>,
    new_shortcut: Option<String>,
) -> Result<(), String> {
    let old_id = old_shortcut
        .as_deref()
        .and_then(|shortcut| shortcut_id(shortcut).ok());
    let new_id = new_shortcut.as_deref().map(shortcut_id).transpose()?;
    let registration_changed = old_id != new_id;
    let old_registered: Vec<_> = old_shortcut
        .filter(|shortcut| shortcut_id(shortcut).is_ok())
        .into_iter()
        .collect();
    let mut released_old = Vec::new();
    let mut registered_new = false;

    if registration_changed {
        released_old = release_shortcuts_atomically(
            &old_registered,
            |shortcut| {
                app.global_shortcut()
                    .unregister(shortcut)
                    .map_err(|error| error.to_string())
            },
            |shortcut| {
                app.global_shortcut()
                    .register(shortcut)
                    .map_err(|error| error.to_string())
            },
        )?;
        if let Some(shortcut) = new_shortcut.as_deref() {
            if let Err(error) = app.global_shortcut().register(shortcut) {
                let rollback_errors = restore_released_shortcuts(&released_old, &mut |old| {
                    app.global_shortcut()
                        .register(old)
                        .map_err(|error| error.to_string())
                });
                return Err(error_with_rollback_details(
                    format!("That shortcut is already in use or unavailable: {error}"),
                    rollback_errors,
                ));
            }
            registered_new = true;
        }
    }

    if let Err(error) = persist_catalog_state(store, &updated) {
        let mut rollback_errors = Vec::new();
        if registered_new {
            if let Some(shortcut) = new_shortcut.as_deref() {
                if let Err(rollback_error) = app.global_shortcut().unregister(shortcut) {
                    rollback_errors.push(format!(
                        "Could not release the new shortcut {shortcut}: {rollback_error}"
                    ));
                }
            }
        }
        rollback_errors.extend(restore_released_shortcuts(&released_old, &mut |old| {
            app.global_shortcut()
                .register(old)
                .map_err(|error| error.to_string())
        }));
        return Err(error_with_rollback_details(error, rollback_errors));
    }
    *store
        .state
        .lock()
        .map_err(|_| "The personalization data is unavailable.".to_string())? = updated;
    Ok(())
}

// Tauri exposes command inputs and managed state as separate parameters.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn set_item_customization(
    app: AppHandle,
    display_key: String,
    item_id: String,
    alias: Option<String>,
    favorite: bool,
    shortcut: Option<String>,
    hidden: bool,
    menu_cache: State<'_, MenuCache>,
    catalog: State<'_, CatalogStateStore>,
    preferences: State<'_, PreferencesState>,
) -> Result<CatalogCustomizationsResponse, String> {
    require_ready(&app)?;
    if !valid_item_id(&item_id) {
        return Err("This menu-bar item does not expose a stable identity.".to_string());
    }
    if !valid_display_key(&display_key) {
        return Err("That display is no longer available.".to_string());
    }
    if !menu_cache_contains_item(menu_cache.inner(), &display_key, &item_id)? {
        return Err("That menu-bar item is no longer available on this display.".to_string());
    }

    let alias = normalized_alias(alias)?;
    let shortcut = normalized_item_shortcut(shortcut)?;
    if shortcut.is_some() && !valid_item_shortcut_id(&item_id) {
        return Err(
            "A direct shortcut requires an item identity supplied by the original app.".to_string(),
        );
    }

    let _write_guard = catalog
        .write_lock
        .lock()
        .map_err(|_| "The personalization writer is unavailable.".to_string())?;
    let current_preferences = preferences
        .preferences
        .lock()
        .map_err(|_| "The settings are unavailable.".to_string())?
        .clone();
    let mut updated = catalog
        .state
        .lock()
        .map_err(|_| "The personalization data is unavailable.".to_string())?
        .clone();

    let creates_item = alias.is_some() || shortcut.is_some() || favorite || hidden;
    if !updated.items.contains_key(&item_id)
        && creates_item
        && !ensure_catalog_item_capacity(&mut updated)
    {
        return Err("Macnu has reached its local personalization limit.".to_string());
    }

    let old_shortcut = updated
        .items
        .get(&item_id)
        .and_then(|item| item.shortcut.clone());
    let new_shortcut_id = shortcut.as_deref().map(shortcut_id).transpose()?;
    if let Some(new_id) = new_shortcut_id {
        if shortcut_id(&current_preferences.shortcut)? == new_id {
            return Err("That shortcut already opens Macnu.".to_string());
        }
        if direct_shortcut_conflicts(&updated, new_id, Some(&item_id), None) {
            return Err("That shortcut is already assigned to another direct command.".to_string());
        }
    }

    if updated.items.contains_key(&item_id) || creates_item {
        let item = updated.items.entry(item_id.clone()).or_default();
        item.alias = alias;
        item.shortcut = shortcut.clone();
        item.hidden = hidden;
    }

    let scope = customization_scope(&current_preferences, &display_key);
    if scope == GLOBAL_PERSONALIZATION_SCOPE {
        update_favorite_list(&mut updated.global_favorites, &item_id, favorite)?;
    } else {
        update_display_favorite(&mut updated, scope, &item_id, favorite)?;
    }
    prune_catalog_state(&mut updated);

    let response = resolved_customizations(&updated, &current_preferences, &display_key);
    persist_catalog_with_shortcut_change(&app, catalog.inner(), updated, old_shortcut, shortcut)?;
    let _ = app.emit("catalog-customizations-changed", response.clone());
    Ok(response)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn save_saved_action(
    app: AppHandle,
    display_key: String,
    icon: MenuIcon,
    action: MenuAction,
    alias: Option<String>,
    shortcut: Option<String>,
    menu_cache: State<'_, MenuCache>,
    catalog: State<'_, CatalogStateStore>,
    preferences: State<'_, PreferencesState>,
) -> Result<CatalogCustomizationsResponse, String> {
    require_ready(&app)?;
    if !valid_display_key(&display_key) || icon.display_key.as_deref() != Some(display_key.as_str())
    {
        return Err("That display is no longer available.".to_string());
    }
    let parent_item_id = icon
        .item_id
        .as_deref()
        .filter(|item_id| valid_item_id(item_id))
        .ok_or_else(|| "This menu-bar item does not expose a stable identity.".to_string())?
        .to_string();
    let live_icon =
        resolve_saved_action_parent_with_refresh(&display_key, &parent_item_id, |force| {
            if !force {
                return menu_cache_item(menu_cache.inner(), &display_key, &parent_item_id);
            }

            let refreshed = refresh_menu_cache(menu_cache.inner(), true)?.response;
            Ok((refreshed.display_key == display_key)
                .then(|| {
                    refreshed
                        .icons
                        .into_iter()
                        .find(|candidate| candidate.item_id.as_deref() == Some(&parent_item_id))
                })
                .flatten())
        })?;
    validate_menu_action(&action)?;
    let owner = normalized_saved_text(live_icon.owner, MAX_SAVED_ACTION_OWNER_CHARACTERS, "owner")?;
    let parent_label = normalized_saved_text(
        live_icon.label,
        MAX_SAVED_ACTION_LABEL_CHARACTERS,
        "parent label",
    )?;
    let alias = normalized_alias(alias)?;
    let shortcut = normalized_item_shortcut(shortcut)?;
    if shortcut.is_some() && !valid_item_shortcut_id(&parent_item_id) {
        return Err(
            "A saved-action shortcut requires an identity supplied by the original app."
                .to_string(),
        );
    }
    let id = saved_action_id(&parent_item_id, &action);

    let _write_guard = catalog
        .write_lock
        .lock()
        .map_err(|_| "The personalization writer is unavailable.".to_string())?;
    let current_preferences = preferences
        .preferences
        .lock()
        .map_err(|_| "The settings are unavailable.".to_string())?
        .clone();
    let mut updated = catalog
        .state
        .lock()
        .map_err(|_| "The personalization data is unavailable.".to_string())?
        .clone();
    if !updated.saved_actions.contains_key(&id) && updated.saved_actions.len() >= MAX_SAVED_ACTIONS
    {
        return Err("Macnu has reached the saved-actions limit.".to_string());
    }
    if updated.saved_actions.get(&id).is_some_and(|existing| {
        existing.parent_item_id != parent_item_id
            || existing.action.id != action.id
            || existing.action.path != action.path
    }) {
        return Err("That saved action identity conflicts with another command.".to_string());
    }
    let old = updated.saved_actions.get(&id).cloned();
    let old_shortcut = old.as_ref().and_then(|existing| existing.shortcut.clone());
    if let Some(new_id) = shortcut.as_deref().map(shortcut_id).transpose()? {
        if shortcut_id(&current_preferences.shortcut)? == new_id {
            return Err("That shortcut already opens Macnu.".to_string());
        }
        if direct_shortcut_conflicts(&updated, new_id, None, Some(&id)) {
            return Err("That shortcut is already assigned to another direct command.".to_string());
        }
    }
    let global_usage = old
        .as_ref()
        .map(|existing| existing.global_usage.clone())
        .unwrap_or_default();
    let display_usage = old
        .map(|existing| existing.display_usage)
        .unwrap_or_default();
    updated.saved_actions.insert(
        id,
        SavedAction {
            parent_item_id,
            owner,
            parent_label,
            action,
            alias,
            shortcut: shortcut.clone(),
            global_usage,
            display_usage,
        },
    );
    let response = resolved_customizations(&updated, &current_preferences, &display_key);
    persist_catalog_with_shortcut_change(&app, catalog.inner(), updated, old_shortcut, shortcut)?;
    let _ = app.emit("catalog-customizations-changed", response.clone());
    Ok(response)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn update_saved_action(
    app: AppHandle,
    display_key: String,
    saved_action_id: String,
    alias: Option<String>,
    shortcut: Option<String>,
    catalog: State<'_, CatalogStateStore>,
    preferences: State<'_, PreferencesState>,
) -> Result<CatalogCustomizationsResponse, String> {
    require_ready(&app)?;
    if !valid_display_key(&display_key) {
        return Err("That display is no longer available.".to_string());
    }
    if !valid_saved_action_id(&saved_action_id) {
        return Err("That saved action identity is invalid.".to_string());
    }
    let alias = normalized_alias(alias)?;
    let shortcut = normalized_item_shortcut(shortcut)?;

    let _write_guard = catalog
        .write_lock
        .lock()
        .map_err(|_| "The personalization writer is unavailable.".to_string())?;
    let current_preferences = preferences
        .preferences
        .lock()
        .map_err(|_| "The settings are unavailable.".to_string())?
        .clone();
    let mut updated = catalog
        .state
        .lock()
        .map_err(|_| "The personalization data is unavailable.".to_string())?
        .clone();
    let parent_item_id = updated
        .saved_actions
        .get(&saved_action_id)
        .ok_or_else(|| "That saved action no longer exists.".to_string())?
        .parent_item_id
        .clone();
    if shortcut.is_some() && !valid_item_shortcut_id(&parent_item_id) {
        return Err(
            "A saved-action shortcut requires an identity supplied by the original app."
                .to_string(),
        );
    }
    if let Some(new_id) = shortcut.as_deref().map(shortcut_id).transpose()? {
        if shortcut_id(&current_preferences.shortcut)? == new_id {
            return Err("That shortcut already opens Macnu.".to_string());
        }
        if direct_shortcut_conflicts(&updated, new_id, None, Some(&saved_action_id)) {
            return Err("That shortcut is already assigned to another direct command.".to_string());
        }
    }
    let saved_action = updated.saved_actions.get_mut(&saved_action_id).unwrap();
    let old_shortcut = saved_action.shortcut.clone();
    saved_action.alias = alias;
    saved_action.shortcut = shortcut.clone();
    let response = resolved_customizations(&updated, &current_preferences, &display_key);
    persist_catalog_with_shortcut_change(&app, catalog.inner(), updated, old_shortcut, shortcut)?;
    let _ = app.emit("catalog-customizations-changed", response.clone());
    Ok(response)
}

#[tauri::command]
fn remove_saved_action(
    app: AppHandle,
    display_key: String,
    saved_action_id: String,
    catalog: State<'_, CatalogStateStore>,
    preferences: State<'_, PreferencesState>,
) -> Result<CatalogCustomizationsResponse, String> {
    require_ready(&app)?;
    if !valid_display_key(&display_key) {
        return Err("That display is no longer available.".to_string());
    }
    if !valid_saved_action_id(&saved_action_id) {
        return Err("That saved action identity is invalid.".to_string());
    }
    let _write_guard = catalog
        .write_lock
        .lock()
        .map_err(|_| "The personalization writer is unavailable.".to_string())?;
    let current_preferences = preferences
        .preferences
        .lock()
        .map_err(|_| "The settings are unavailable.".to_string())?
        .clone();
    let mut updated = catalog
        .state
        .lock()
        .map_err(|_| "The personalization data is unavailable.".to_string())?
        .clone();
    let removed = updated
        .saved_actions
        .remove(&saved_action_id)
        .ok_or_else(|| "That saved action no longer exists.".to_string())?;
    let old_shortcut = removed.shortcut;
    let response = resolved_customizations(&updated, &current_preferences, &display_key);
    persist_catalog_with_shortcut_change(&app, catalog.inner(), updated, old_shortcut, None)?;
    let _ = app.emit("catalog-customizations-changed", response.clone());
    Ok(response)
}

#[tauri::command]
fn update_personalization_settings(
    app: AppHandle,
    ranking_mode: RankingMode,
    personalize_per_display: bool,
    state: State<'_, PreferencesState>,
) -> Result<SettingsResponse, String> {
    let write_guard = state
        .write_lock
        .lock()
        .map_err(|_| "The settings writer is unavailable.".to_string())?;
    let mut updated = state
        .preferences
        .lock()
        .map_err(|_| "The settings are unavailable.".to_string())?
        .clone();
    updated.ranking_mode = ranking_mode;
    updated.personalize_per_display = personalize_per_display;
    persist_preferences(state.inner(), &updated)?;
    *state
        .preferences
        .lock()
        .map_err(|_| "The settings are unavailable.".to_string())? = updated;
    drop(write_guard);
    let settings = current_settings(state.inner())?;
    let _ = app.emit("personalization-settings-changed", settings.clone());
    Ok(settings)
}

#[tauri::command]
fn reset_personalization_history(
    app: AppHandle,
    catalog: State<'_, CatalogStateStore>,
) -> Result<(), String> {
    let _write_guard = catalog
        .write_lock
        .lock()
        .map_err(|_| "The personalization writer is unavailable.".to_string())?;
    let mut updated = catalog
        .state
        .lock()
        .map_err(|_| "The personalization data is unavailable.".to_string())?
        .clone();
    for item in updated.items.values_mut() {
        item.global_usage = UsageStats::default();
    }
    for display in updated.displays.values_mut() {
        display.usage.clear();
    }
    for saved_action in updated.saved_actions.values_mut() {
        saved_action.global_usage = UsageStats::default();
        saved_action.display_usage.clear();
    }
    prune_catalog_state(&mut updated);
    persist_catalog_state(catalog.inner(), &updated)?;
    *catalog
        .state
        .lock()
        .map_err(|_| "The personalization data is unavailable.".to_string())? = updated;
    let _ = app.emit("personalization-history-reset", ());
    Ok(())
}
#[tauri::command]
fn clear_all_item_shortcuts(
    app: AppHandle,
    catalog: State<'_, CatalogStateStore>,
) -> Result<usize, String> {
    let _write_guard = catalog
        .write_lock
        .lock()
        .map_err(|_| "The personalization writer is unavailable.".to_string())?;
    let mut updated = catalog
        .state
        .lock()
        .map_err(|_| "The personalization data is unavailable.".to_string())?
        .clone();

    let cleared = updated
        .items
        .values()
        .filter(|item| item.shortcut.is_some())
        .count()
        + updated
            .saved_actions
            .values()
            .filter(|action| action.shortcut.is_some())
            .count();
    if cleared == 0 {
        return Ok(0);
    }

    let mut registered_by_id = HashMap::new();
    for shortcut in updated
        .items
        .values()
        .filter_map(|item| item.shortcut.as_deref())
        .chain(
            updated
                .saved_actions
                .values()
                .filter_map(|action| action.shortcut.as_deref()),
        )
    {
        if let Ok(id) = shortcut_id(shortcut) {
            registered_by_id
                .entry(id)
                .or_insert_with(|| shortcut.to_string());
        }
    }
    let mut registered: Vec<_> = registered_by_id.into_iter().collect();
    registered.sort_by_key(|(id, _)| *id);
    let registered: Vec<_> = registered
        .into_iter()
        .map(|(_, shortcut)| shortcut)
        .collect();

    for item in updated.items.values_mut() {
        item.shortcut = None;
    }
    for saved_action in updated.saved_actions.values_mut() {
        saved_action.shortcut = None;
    }
    prune_catalog_state(&mut updated);

    let released = release_shortcuts_atomically(
        &registered,
        |shortcut| {
            app.global_shortcut()
                .unregister(shortcut)
                .map_err(|error| error.to_string())
        },
        |shortcut| {
            app.global_shortcut()
                .register(shortcut)
                .map_err(|error| error.to_string())
        },
    )?;

    if let Err(error) = persist_catalog_state(catalog.inner(), &updated) {
        let rollback_errors = restore_released_shortcuts(&released, &mut |shortcut| {
            app.global_shortcut()
                .register(shortcut)
                .map_err(|rollback_error| rollback_error.to_string())
        });
        return Err(error_with_rollback_details(error, rollback_errors));
    }
    *catalog
        .state
        .lock()
        .map_err(|_| "The personalization data is unavailable.".to_string())? = updated;
    let _ = app.emit("item-shortcuts-cleared", cleared);
    let _ = app.emit("catalog-customizations-invalidated", ());
    Ok(cleared)
}

#[tauri::command]
fn clear_hidden_items(
    app: AppHandle,
    catalog: State<'_, CatalogStateStore>,
) -> Result<usize, String> {
    let _write_guard = catalog
        .write_lock
        .lock()
        .map_err(|_| "The personalization writer is unavailable.".to_string())?;
    let mut updated = catalog
        .state
        .lock()
        .map_err(|_| "The personalization data is unavailable.".to_string())?
        .clone();
    let cleared = updated.items.values().filter(|item| item.hidden).count();
    if cleared == 0 {
        return Ok(0);
    }
    for item in updated.items.values_mut() {
        item.hidden = false;
    }
    prune_catalog_state(&mut updated);
    persist_catalog_state(catalog.inner(), &updated)?;
    *catalog
        .state
        .lock()
        .map_err(|_| "The personalization data is unavailable.".to_string())? = updated;
    let _ = app.emit("hidden-items-cleared", cleared);
    let _ = app.emit("catalog-customizations-invalidated", ());
    Ok(cleared)
}

fn record_successful_usage(
    catalog: &CatalogStateStore,
    preferences: &PreferencesState,
    icon: &MenuIcon,
) -> Result<(), String> {
    let (Some(item_id), Some(display_key)) = (icon.item_id.as_deref(), icon.display_key.as_deref())
    else {
        return Ok(());
    };
    if icon.is_macnu || !valid_item_id(item_id) || !valid_display_key(display_key) {
        return Ok(());
    }
    let _write_guard = catalog
        .write_lock
        .lock()
        .map_err(|_| "The personalization writer is unavailable.".to_string())?;
    let current_preferences = preferences
        .preferences
        .lock()
        .map_err(|_| "The settings are unavailable.".to_string())?
        .clone();
    let mut updated = catalog
        .state
        .lock()
        .map_err(|_| "The personalization data is unavailable.".to_string())?
        .clone();
    if !updated.items.contains_key(item_id) && !ensure_catalog_item_capacity(&mut updated) {
        return Ok(());
    }
    let now = unix_timestamp();
    let item = updated.items.entry(item_id.to_string()).or_default();
    item.global_usage.count = item
        .global_usage
        .count
        .saturating_add(1)
        .min(MAX_USAGE_COUNT);
    item.global_usage.last_used_at = Some(now);
    if current_preferences.personalize_per_display {
        if let Ok(display) = ensure_display_customization(&mut updated, display_key) {
            let usage = display.usage.entry(item_id.to_string()).or_default();
            usage.count = usage.count.saturating_add(1).min(MAX_USAGE_COUNT);
            usage.last_used_at = Some(now);
        }
    }
    persist_catalog_state(catalog, &updated)?;
    *catalog
        .state
        .lock()
        .map_err(|_| "The personalization data is unavailable.".to_string())? = updated;
    Ok(())
}

fn increment_usage(usage: &mut UsageStats, now: u64) {
    usage.count = usage.count.saturating_add(1).min(MAX_USAGE_COUNT);
    usage.last_used_at = Some(now);
}

fn record_successful_saved_action_usage(
    catalog: &CatalogStateStore,
    preferences: &PreferencesState,
    icon: &MenuIcon,
    saved_action_id: &str,
) -> Result<(), String> {
    let (Some(item_id), Some(display_key)) = (icon.item_id.as_deref(), icon.display_key.as_deref())
    else {
        return Ok(());
    };
    if icon.is_macnu || !valid_item_id(item_id) || !valid_display_key(display_key) {
        return Ok(());
    }
    let _write_guard = catalog
        .write_lock
        .lock()
        .map_err(|_| "The personalization writer is unavailable.".to_string())?;
    let current_preferences = preferences
        .preferences
        .lock()
        .map_err(|_| "The settings are unavailable.".to_string())?
        .clone();
    let mut updated = catalog
        .state
        .lock()
        .map_err(|_| "The personalization data is unavailable.".to_string())?
        .clone();
    if updated
        .saved_actions
        .get(saved_action_id)
        .is_none_or(|saved_action| saved_action.parent_item_id != item_id)
    {
        return Ok(());
    }
    let now = unix_timestamp();
    if updated.items.contains_key(item_id) || ensure_catalog_item_capacity(&mut updated) {
        increment_usage(
            &mut updated
                .items
                .entry(item_id.to_string())
                .or_default()
                .global_usage,
            now,
        );
        if current_preferences.personalize_per_display {
            if let Ok(display) = ensure_display_customization(&mut updated, display_key) {
                increment_usage(display.usage.entry(item_id.to_string()).or_default(), now);
            }
        }
    }
    let saved_action = updated.saved_actions.get_mut(saved_action_id).unwrap();
    increment_usage(&mut saved_action.global_usage, now);
    if current_preferences.personalize_per_display
        && (saved_action.display_usage.contains_key(display_key)
            || saved_action.display_usage.len() < MAX_PERSONALIZED_DISPLAYS)
    {
        increment_usage(
            saved_action
                .display_usage
                .entry(display_key.to_string())
                .or_default(),
            now,
        );
    }
    persist_catalog_state(catalog, &updated)?;
    *catalog
        .state
        .lock()
        .map_err(|_| "The personalization data is unavailable.".to_string())? = updated;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum GlobalShortcutRoute {
    Palette,
    Item(String),
    SavedAction(String),
    None,
}

fn global_shortcut_route(
    pressed_id: u32,
    preferences: &Preferences,
    catalog: &CatalogState,
) -> GlobalShortcutRoute {
    if shortcut_id(&preferences.shortcut).ok() == Some(pressed_id) {
        return GlobalShortcutRoute::Palette;
    }

    let item_matches = catalog
        .items
        .iter()
        .filter(|(item_id, item)| {
            valid_item_shortcut_id(item_id)
                && item
                    .shortcut
                    .as_deref()
                    .and_then(|shortcut| shortcut_id(shortcut).ok())
                    == Some(pressed_id)
        })
        .map(|(item_id, _)| GlobalShortcutRoute::Item(item_id.clone()));
    let action_matches = catalog
        .saved_actions
        .iter()
        .filter(|(_, action)| {
            valid_item_shortcut_id(&action.parent_item_id)
                && action
                    .shortcut
                    .as_deref()
                    .and_then(|shortcut| shortcut_id(shortcut).ok())
                    == Some(pressed_id)
        })
        .map(|(saved_action_id, _)| GlobalShortcutRoute::SavedAction(saved_action_id.clone()));
    let mut matches = item_matches.chain(action_matches);
    match (matches.next(), matches.next()) {
        (Some(route), None) => route,
        _ => GlobalShortcutRoute::None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DirectShortcutTarget {
    Item(String),
    SavedAction(String),
}

impl DirectShortcutTarget {
    fn sort_key(&self) -> (u8, &str) {
        match self {
            Self::Item(id) => (0, id),
            Self::SavedAction(id) => (1, id),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DirectShortcutAssignment {
    target: DirectShortcutTarget,
    shortcut: String,
    id: u32,
}

fn persisted_direct_shortcut_assignments(
    preferences: &Preferences,
    catalog: &CatalogState,
) -> Vec<DirectShortcutAssignment> {
    let item_shortcuts = catalog.items.iter().filter_map(|(item_id, item)| {
        valid_item_shortcut_id(item_id)
            .then_some(item.shortcut.as_deref())
            .flatten()
            .and_then(|shortcut| {
                shortcut_id(shortcut)
                    .ok()
                    .map(|id| DirectShortcutAssignment {
                        target: DirectShortcutTarget::Item(item_id.clone()),
                        shortcut: shortcut.to_string(),
                        id,
                    })
            })
    });
    let action_shortcuts = catalog
        .saved_actions
        .iter()
        .filter_map(|(saved_action_id, action)| {
            valid_item_shortcut_id(&action.parent_item_id)
                .then_some(action.shortcut.as_deref())
                .flatten()
                .and_then(|shortcut| {
                    shortcut_id(shortcut)
                        .ok()
                        .map(|id| DirectShortcutAssignment {
                            target: DirectShortcutTarget::SavedAction(saved_action_id.clone()),
                            shortcut: shortcut.to_string(),
                            id,
                        })
                })
        });
    let mut shortcuts: Vec<_> = item_shortcuts.chain(action_shortcuts).collect();
    shortcuts.sort_by(|left, right| left.target.sort_key().cmp(&right.target.sort_key()));

    let mut counts = HashMap::new();
    for assignment in &shortcuts {
        *counts.entry(assignment.id).or_insert(0usize) += 1;
    }
    let launcher_id = shortcut_id(&preferences.shortcut).ok();
    shortcuts.retain(|assignment| {
        counts.get(&assignment.id).copied() == Some(1) && launcher_id != Some(assignment.id)
    });
    shortcuts
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DirectShortcutRegistrationFailure {
    target: DirectShortcutTarget,
    shortcut: String,
    error: String,
}

fn reconcile_persisted_direct_shortcuts<Register>(
    preferences: &Preferences,
    catalog: &CatalogState,
    mut register: Register,
) -> (CatalogState, Vec<DirectShortcutRegistrationFailure>)
where
    Register: FnMut(&str) -> Result<(), String>,
{
    let mut updated = catalog.clone();
    let mut failures = Vec::new();
    for assignment in persisted_direct_shortcut_assignments(preferences, catalog) {
        if let Err(error) = register(&assignment.shortcut) {
            match &assignment.target {
                DirectShortcutTarget::Item(item_id) => {
                    if let Some(item) = updated.items.get_mut(item_id) {
                        item.shortcut = None;
                    }
                }
                DirectShortcutTarget::SavedAction(saved_action_id) => {
                    if let Some(action) = updated.saved_actions.get_mut(saved_action_id) {
                        action.shortcut = None;
                    }
                }
            }
            failures.push(DirectShortcutRegistrationFailure {
                target: assignment.target,
                shortcut: assignment.shortcut,
                error,
            });
        }
    }
    if !failures.is_empty() {
        prune_catalog_state(&mut updated);
    }
    (updated, failures)
}

fn register_persisted_direct_shortcuts(
    app: &AppHandle,
    preferences: &Preferences,
    store: &CatalogStateStore,
) -> Result<(), String> {
    let _write_guard = store
        .write_lock
        .lock()
        .map_err(|_| "The personalization writer is unavailable.".to_string())?;
    let current = store
        .state
        .lock()
        .map_err(|_| "The personalization data is unavailable.".to_string())?
        .clone();
    let (updated, failures) =
        reconcile_persisted_direct_shortcuts(preferences, &current, |shortcut| {
            app.global_shortcut()
                .register(shortcut)
                .map_err(|error| error.to_string())
        });
    if failures.is_empty() {
        return Ok(());
    }

    persist_catalog_state(store, &updated)
        .map_err(|error| format!("Could not save unavailable direct shortcut cleanup: {error}"))?;
    *store
        .state
        .lock()
        .map_err(|_| "The personalization data is unavailable.".to_string())? = updated;
    for failure in failures {
        eprintln!(
            "Macnu removed unavailable direct shortcut {} for {:?}: {}",
            failure.shortcut, failure.target, failure.error
        );
    }
    Ok(())
}

fn resolve_parent_icon_with_refresh<Lookup>(
    parent_item_id: &str,
    mut lookup: Lookup,
) -> Result<MenuIcon, String>
where
    Lookup: FnMut(bool) -> Result<Option<MenuIcon>, String>,
{
    for force in [false, true] {
        if let Some(icon) = lookup(force)? {
            if !icon.is_macnu && icon.item_id.as_deref() == Some(parent_item_id) {
                return Ok(icon);
            }
        }
    }
    Err("That menu-bar item is not available on this display.".to_string())
}

#[cfg(target_os = "macos")]
fn catalog_icon_for_item(
    cache: &MenuCache,
    item_id: &str,
    force: bool,
) -> Result<Option<MenuIcon>, String> {
    let response = refresh_menu_cache(cache, force)?.response;
    Ok(response
        .icons
        .into_iter()
        .find(|icon| icon.item_id.as_deref() == Some(item_id)))
}

fn activate_item_shortcut(app: &AppHandle, item_id: String) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }

    #[cfg(target_os = "macos")]
    {
        let shortcut_app = app.clone();
        let cache = app.state::<MenuCache>().inner().clone();
        let catalog = app.state::<CatalogStateStore>().inner().clone();
        let preferences = app.state::<PreferencesState>().inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            let result = (|| {
                require_ready(&shortcut_app)?;
                let icon = resolve_parent_icon_with_refresh(&item_id, |force| {
                    catalog_icon_for_item(&cache, &item_id, force)
                })?;
                run_native_menu_icon(&shortcut_app, icon.clone())?;
                let _ = record_successful_usage(&catalog, &preferences, &icon);
                Ok::<(), String>(())
            })();
            if let Err(error) = result {
                let _ = shortcut_app.emit("item-shortcut-error", error);
            }
        });
    }
}

#[cfg(target_os = "macos")]
fn run_saved_action_by_id(
    app: &AppHandle,
    cache: &MenuCache,
    catalog: &CatalogStateStore,
    preferences: &PreferencesState,
    saved_action_id_value: &str,
) -> Result<(), String> {
    if !valid_saved_action_id(saved_action_id_value) {
        return Err("That saved action identity is invalid.".to_string());
    }
    let saved_action = catalog
        .state
        .lock()
        .map_err(|_| "The personalization data is unavailable.".to_string())?
        .saved_actions
        .get(saved_action_id_value)
        .cloned()
        .ok_or_else(|| "That saved action no longer exists.".to_string())?;
    validate_menu_action(&saved_action.action)?;
    let icon = resolve_parent_icon_with_refresh(&saved_action.parent_item_id, |force| {
        catalog_icon_for_item(cache, &saved_action.parent_item_id, force)
    })?;
    run_native_menu_action(app, icon.clone(), saved_action.action)?;
    let _ =
        record_successful_saved_action_usage(catalog, preferences, &icon, saved_action_id_value);
    Ok(())
}

#[tauri::command]
async fn activate_saved_action(
    app: AppHandle,
    saved_action_id: String,
    menu_cache: State<'_, MenuCache>,
    catalog: State<'_, CatalogStateStore>,
    preferences: State<'_, PreferencesState>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        require_ready(&app)?;
        let action_app = app.clone();
        let cache = menu_cache.inner().clone();
        let catalog = catalog.inner().clone();
        let preferences = preferences.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            run_saved_action_by_id(
                &action_app,
                &cache,
                &catalog,
                &preferences,
                &saved_action_id,
            )
        })
        .await
        .map_err(|error| format!("Saved action task failed: {error}"))?
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, saved_action_id, menu_cache, catalog, preferences);
        Err("Macnu only supports macOS.".to_string())
    }
}

fn activate_saved_action_shortcut(app: &AppHandle, saved_action_id: String) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }

    #[cfg(target_os = "macos")]
    {
        let shortcut_app = app.clone();
        let cache = app.state::<MenuCache>().inner().clone();
        let catalog = app.state::<CatalogStateStore>().inner().clone();
        let preferences = app.state::<PreferencesState>().inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            let result = (|| {
                require_ready(&shortcut_app)?;
                run_saved_action_by_id(
                    &shortcut_app,
                    &cache,
                    &catalog,
                    &preferences,
                    &saved_action_id,
                )
            })();
            if let Err(error) = result {
                let _ = shortcut_app.emit("saved-action-shortcut-error", error);
            }
        });
    }
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

    let write_guard = state
        .write_lock
        .lock()
        .map_err(|_| "The settings writer is unavailable.".to_string())?;
    let current = state
        .preferences
        .lock()
        .map_err(|_| "The settings are unavailable.".to_string())?
        .clone();
    if !current.onboarding_completed {
        let mut updated = current;
        updated.onboarding_completed = true;
        persist_preferences(state.inner(), &updated)?;
        *state
            .preferences
            .lock()
            .map_err(|_| "The settings are unavailable.".to_string())? = updated;
    }
    drop(write_guard);
    let settings = current_settings(state.inner())?;
    toggle_palette(&app);
    Ok(settings)
}

#[tauri::command]
fn reset_onboarding(state: State<'_, PreferencesState>) -> Result<SettingsResponse, String> {
    let write_guard = state
        .write_lock
        .lock()
        .map_err(|_| "The settings writer is unavailable.".to_string())?;
    let current = state
        .preferences
        .lock()
        .map_err(|_| "The settings are unavailable.".to_string())?
        .clone();
    if current.onboarding_completed {
        let mut updated = current;
        updated.onboarding_completed = false;
        persist_preferences(state.inner(), &updated)?;
        *state
            .preferences
            .lock()
            .map_err(|_| "The settings are unavailable.".to_string())? = updated;
    }
    drop(write_guard);
    current_settings(state.inner())
}

#[tauri::command]
fn update_shortcut(
    app: AppHandle,
    shortcut: String,
    state: State<'_, PreferencesState>,
    catalog: State<'_, CatalogStateStore>,
) -> Result<SettingsResponse, String> {
    let (shortcut, parsed) = normalized_global_shortcut(&shortcut)?;
    let write_guard = state
        .write_lock
        .lock()
        .map_err(|_| "The settings writer is unavailable.".to_string())?;

    let catalog = catalog
        .state
        .lock()
        .map_err(|_| "The personalization data is unavailable.".to_string())?
        .clone();
    if direct_shortcut_conflicts(&catalog, parsed.id(), None, None) {
        return Err("That shortcut is already assigned to another direct command.".to_string());
    }

    let current_preferences = state
        .preferences
        .lock()
        .map_err(|_| "The settings are unavailable.".to_string())?
        .clone();
    let current = current_preferences.shortcut.clone();
    if current.eq_ignore_ascii_case(&shortcut) {
        return current_settings(state.inner());
    }

    let updated = Preferences {
        shortcut: shortcut.clone(),
        ..current_preferences
    };
    replace_shortcut_atomically(
        &current,
        &shortcut,
        |value| {
            app.global_shortcut()
                .unregister(value)
                .map_err(|error| error.to_string())
        },
        |value| {
            app.global_shortcut()
                .register(value)
                .map_err(|error| error.to_string())
        },
        || persist_preferences(state.inner(), &updated),
    )?;
    *state
        .preferences
        .lock()
        .map_err(|_| "The settings are unavailable.".to_string())? = updated;
    drop(write_guard);
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
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        let route = (|| {
                            let preferences = app
                                .state::<PreferencesState>()
                                .preferences
                                .lock()
                                .ok()?
                                .clone();
                            let catalog =
                                app.state::<CatalogStateStore>().state.lock().ok()?.clone();
                            Some(global_shortcut_route(shortcut.id(), &preferences, &catalog))
                        })()
                        .unwrap_or(GlobalShortcutRoute::None);
                        match route {
                            GlobalShortcutRoute::Palette => toggle_palette(app),
                            GlobalShortcutRoute::Item(item_id) => {
                                activate_item_shortcut(app, item_id)
                            }
                            GlobalShortcutRoute::SavedAction(saved_action_id) => {
                                activate_saved_action_shortcut(app, saved_action_id)
                            }
                            GlobalShortcutRoute::None => {}
                        }
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
            let loaded_preferences = load_preferences(&preferences_path);
            let preferences = loaded_preferences.value;
            let configured_shortcut = preferences.shortcut.clone();
            let preferences_state = PreferencesState {
                preferences: Arc::new(Mutex::new(preferences.clone())),
                write_lock: Arc::new(Mutex::new(())),
                path: preferences_path,
                write_protected: loaded_preferences.write_protected,
            };
            if let Ok(_write_guard) = preferences_state.write_lock.lock() {
                let _ = persist_preferences(&preferences_state, &preferences);
            }
            app.manage(preferences_state);

            let catalog_path = app.path().app_config_dir()?.join("catalog-state.json");
            let loaded_catalog =
                load_catalog_state(&catalog_path, shortcut_id(&preferences.shortcut).ok());
            let catalog_state = loaded_catalog.value;
            let catalog_store = CatalogStateStore {
                state: Arc::new(Mutex::new(catalog_state)),
                write_lock: Arc::new(Mutex::new(())),
                path: catalog_path,
                write_protected: loaded_catalog.write_protected,
            };
            app.manage(catalog_store);

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
            register_persisted_direct_shortcuts(
                app.handle(),
                &preferences,
                app.state::<CatalogStateStore>().inner(),
            )?;

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
            list_menu_actions,
            activate_menu_action,
            get_license_status,
            activate_license,
            refresh_license,
            deactivate_license,
            app_updater::check_for_updates,
            app_updater::install_update,
            get_settings,
            get_catalog_customizations,
            set_item_customization,
            save_saved_action,
            update_saved_action,
            remove_saved_action,
            activate_saved_action,
            update_personalization_settings,
            reset_personalization_history,
            clear_all_item_shortcuts,
            clear_hidden_items,
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
            item_id: Some(format!(
                "v1.item-identifier.ZXhhbXBsZS5zdGF0dXM.{identifier}"
            )),
            display_key: Some("v1.display-uuid.dGVzdA".to_string()),
        }
    }

    fn response() -> MenuResponse {
        MenuResponse {
            icons: vec![icon("first"), icon("second")],
            display_id: 7,
            display_key: "v1.display-uuid.dGVzdA".to_string(),
            screen_capture_denied: false,
            accessibility_denied: false,
            error: None,
        }
    }

    fn action(title: &str) -> MenuAction {
        let path = vec![MenuActionPathSegment {
            title: title.to_string(),
            occurrence: 0,
        }];
        MenuAction {
            id: menu_action_identifier(&path),
            title: title.to_string(),
            path,
            enabled: true,
            shortcut: None,
        }
    }

    fn saved_action(parent_item_id: &str, title: &str) -> (String, SavedAction) {
        let action = action(title);
        let id = saved_action_id(parent_item_id, &action);
        (
            id,
            SavedAction {
                parent_item_id: parent_item_id.to_string(),
                owner: "Example App".to_string(),
                parent_label: "Example".to_string(),
                action,
                alias: None,
                shortcut: None,
                global_usage: UsageStats::default(),
                display_usage: HashMap::new(),
            },
        )
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

        assert_eq!(preferences.version, PREFERENCES_STATE_VERSION);
        assert_eq!(preferences.shortcut, "Command+Period");
        assert!(!preferences.onboarding_completed);
        assert_eq!(preferences.ranking_mode, RankingMode::Smart);
        assert!(preferences.personalize_per_display);
    }

    #[test]
    fn completed_onboarding_round_trips_in_preferences() {
        let preferences = Preferences {
            shortcut: "Command+Semicolon".to_string(),
            onboarding_completed: true,
            ranking_mode: RankingMode::Smart,
            personalize_per_display: true,
            ..Preferences::default()
        };

        let json = serde_json::to_string(&preferences).unwrap();
        let decoded: Preferences = serde_json::from_str(&json).unwrap();

        assert_eq!(decoded.shortcut, preferences.shortcut);
        assert!(decoded.onboarding_completed);
    }

    #[test]
    fn stored_launcher_shortcuts_require_a_modifier() {
        let loaded = decode_preferences(r#"{"shortcut":"A"}"#);

        assert!(!loaded.write_protected);
        assert_eq!(loaded.value.shortcut, DEFAULT_SHORTCUT);
        assert!(normalized_global_shortcut("A").is_err());
        assert!(normalized_global_shortcut("Command+A").is_ok());
    }

    #[test]
    fn future_preferences_are_salvaged_read_only() {
        let loaded = decode_preferences(
            r#"{
                "version": 99,
                "shortcut": "Command+Period",
                "onboardingCompleted": true,
                "rankingMode": "alphabetical",
                "personalizePerDisplay": false,
                "futureField": {"must": "survive"}
            }"#,
        );

        assert!(loaded.write_protected);
        assert_eq!(loaded.value.shortcut, "Command+Period");
        assert!(loaded.value.onboarding_completed);
        assert_eq!(loaded.value.ranking_mode, RankingMode::Alphabetical);
        assert!(!loaded.value.personalize_per_display);

        let state = PreferencesState {
            preferences: Arc::new(Mutex::new(loaded.value.clone())),
            write_lock: Arc::new(Mutex::new(())),
            path: PathBuf::from("/does/not/matter/settings.json"),
            write_protected: true,
        };
        let error = persist_preferences(&state, &loaded.value).unwrap_err();
        assert!(error.contains("Upgrade Macnu"));
    }

    #[test]
    fn future_catalog_state_is_preserved_read_only() {
        let loaded = decode_catalog_state(
            r#"{"version":99,"items":{"future":"shape"},"globalFavorites":[],"displays":{}}"#,
            500,
            None,
        );

        assert!(loaded.write_protected);
        assert!(loaded.value.items.is_empty());

        let store = CatalogStateStore {
            state: Arc::new(Mutex::new(loaded.value.clone())),
            write_lock: Arc::new(Mutex::new(())),
            path: PathBuf::from("/does/not/matter/catalog-state.json"),
            write_protected: true,
        };
        let error = persist_catalog_state(&store, &loaded.value).unwrap_err();
        assert!(error.contains("Upgrade Macnu"));

        for malformed in [
            r#"{"version":"99"}"#,
            r#"{"version":null}"#,
            r#"{"version":1.5}"#,
        ] {
            let loaded = decode_catalog_state(malformed, 500, None);
            assert!(
                loaded.write_protected,
                "explicit malformed version was treated as writable: {malformed}"
            );
        }
    }

    #[test]
    fn legacy_catalog_state_migrates_to_the_current_version() {
        let item_id = "v1.item-identifier.Y29tLmV4YW1wbGU.Zmlyc3Q";
        let display_key = "v1.display-uuid.ZGlzcGxheQ";
        let loaded = decode_catalog_state(
            &format!(
                r#"{{
                    "version":1,
                    "items":{{"{item_id}":{{
                        "alias":"Work VPN",
                        "shortcut":"Command+Period",
                        "globalUsage":{{"count":7,"lastUsedAt":100}}
                    }}}},
                    "globalFavorites":["{item_id}"],
                    "displays":{{"{display_key}":{{
                        "favorites":["{item_id}"],
                        "usage":{{"{item_id}":{{"count":3,"lastUsedAt":90}}}}
                    }}}}
                }}"#
            ),
            500,
            None,
        );

        assert!(!loaded.write_protected);
        assert_eq!(loaded.value.version, CATALOG_STATE_VERSION);
        assert_eq!(
            loaded.value.items[item_id].alias.as_deref(),
            Some("Work VPN")
        );
        assert_eq!(
            loaded.value.items[item_id].shortcut.as_deref(),
            Some("Command+Period")
        );
        assert_eq!(loaded.value.items[item_id].global_usage.count, 7);
        assert!(!loaded.value.items[item_id].hidden);
        assert_eq!(loaded.value.global_favorites, vec![item_id]);
        assert_eq!(loaded.value.displays[display_key].favorites, vec![item_id]);
        assert_eq!(loaded.value.displays[display_key].usage[item_id].count, 3);
        assert!(loaded.value.saved_actions.is_empty());
    }

    #[test]
    fn personalization_isolated_by_display_with_an_explicit_global_fallback() {
        let first = "v1.item-identifier.Y29tLmV4YW1wbGU.Zmlyc3Q".to_string();
        let second = "v1.item-identifier.Y29tLmV4YW1wbGU.c2Vjb25k".to_string();
        let mut catalog = CatalogState::default();
        catalog.items.insert(
            first.clone(),
            ItemCustomization {
                alias: Some("Work VPN".to_string()),
                shortcut: None,
                global_usage: UsageStats {
                    count: 3,
                    last_used_at: Some(100),
                },
                hidden: false,
            },
        );
        catalog
            .items
            .insert(second.clone(), ItemCustomization::default());
        catalog.global_favorites.push(first.clone());
        catalog.displays.insert(
            "v1.display-uuid.ZXh0ZXJuYWw".to_string(),
            DisplayCustomization {
                favorites: vec![second.clone()],
                usage: HashMap::from([(
                    first.clone(),
                    UsageStats {
                        count: 9,
                        last_used_at: Some(200),
                    },
                )]),
            },
        );

        let per_display = Preferences::default();
        let external =
            resolved_customizations(&catalog, &per_display, "v1.display-uuid.ZXh0ZXJuYWw");
        assert_eq!(external.items[&first].alias.as_deref(), Some("Work VPN"));
        assert_eq!(external.items[&first].usage_count, 9);
        assert!(!external.items[&first].favorite);
        assert!(external.items[&second].favorite);

        let unseen = resolved_customizations(&catalog, &per_display, "v1.display-uuid.bmV3");
        assert_eq!(unseen.items[&first].usage_count, 3);
        assert!(unseen.items[&first].favorite);

        let global = Preferences {
            personalize_per_display: false,
            ..Preferences::default()
        };
        let global_view = resolved_customizations(&catalog, &global, "v1.display-uuid.ZXh0ZXJuYWw");
        assert!(global_view.items[&first].favorite);
        assert!(!global_view.items[&second].favorite);
    }

    #[test]
    fn shortcut_routing_is_exact_and_ambiguous_assignments_fail_closed() {
        let preferences = Preferences::default();
        let item_shortcut = "Command+Period";
        let mut catalog = CatalogState::default();
        catalog.items.insert(
            "v1.item-identifier.Y29tLmV4YW1wbGU.Zmlyc3Q".to_string(),
            ItemCustomization {
                shortcut: Some(item_shortcut.to_string()),
                ..ItemCustomization::default()
            },
        );

        assert_eq!(
            global_shortcut_route(
                shortcut_id(&preferences.shortcut).unwrap(),
                &preferences,
                &catalog,
            ),
            GlobalShortcutRoute::Palette
        );
        assert_eq!(
            global_shortcut_route(shortcut_id(item_shortcut).unwrap(), &preferences, &catalog),
            GlobalShortcutRoute::Item("v1.item-identifier.Y29tLmV4YW1wbGU.Zmlyc3Q".to_string())
        );

        catalog.items.insert(
            "v1.item-identifier.Y29tLmV4YW1wbGU.c2Vjb25k".to_string(),
            ItemCustomization {
                shortcut: Some(item_shortcut.to_string()),
                ..ItemCustomization::default()
            },
        );
        assert_eq!(
            global_shortcut_route(shortcut_id(item_shortcut).unwrap(), &preferences, &catalog),
            GlobalShortcutRoute::None
        );
    }

    #[test]
    fn only_versioned_native_identities_are_personalizable() {
        assert!(valid_item_id("v1.item-single.Y29tLmV4YW1wbGU"));
        assert!(valid_item_shortcut_id(
            "v1.item-identifier.Y29tLmV4YW1wbGU.aXRlbQ"
        ));
        assert!(!valid_item_shortcut_id("v1.item-single.Y29tLmV4YW1wbGU"));
        assert!(valid_display_key("v1.display-uuid.ZGlzcGxheQ"));
        assert!(!valid_item_id("legacy-item"));
        assert!(!valid_display_key("42"));
    }

    #[test]
    fn saved_action_descriptors_and_metadata_are_strictly_validated() {
        let parent = "v1.item-identifier.Y29tLmV4YW1wbGU.aXRlbQ";
        let valid = action("Disconnect");
        assert!(validate_menu_action(&valid).is_ok());
        let id = saved_action_id(parent, &valid);
        assert!(valid_saved_action_id(&id));
        assert_eq!(id, saved_action_id(parent, &valid));

        let ellipsis = action("Account Settings…");
        assert_eq!(ellipsis.id, "19:Account Settings…#0");
        assert!(validate_menu_action(&ellipsis).is_ok());

        let mut controlled = action("Disconnect");
        controlled.path[0].title = "Dis\nconnect".to_string();
        controlled.id = menu_action_identifier(&controlled.path);
        controlled.title = controlled.path[0].title.clone();
        assert!(validate_menu_action(&controlled).is_err());

        let mut deep = action("Leaf");
        deep.path = (0..=MAX_ACTION_PATH_DEPTH)
            .map(|index| MenuActionPathSegment {
                title: format!("Level {index}"),
                occurrence: 0,
            })
            .collect();
        deep.title = deep.path.last().unwrap().title.clone();
        deep.id = menu_action_identifier(&deep.path);
        assert!(validate_menu_action(&deep).is_err());
        assert!(normalized_saved_text(
            "Bad\nOwner".to_string(),
            MAX_SAVED_ACTION_OWNER_CHARACTERS,
            "owner"
        )
        .is_err());
    }

    #[test]
    fn saved_action_parent_retries_one_forced_refresh_after_cache_miss() {
        let expected = icon("target");
        let display_key = expected.display_key.clone().unwrap();
        let item_id = expected.item_id.clone().unwrap();
        let mut attempts = Vec::new();

        let resolved = resolve_saved_action_parent_with_refresh(&display_key, &item_id, |force| {
            attempts.push(force);
            Ok(force.then(|| expected.clone()))
        })
        .unwrap();

        assert_eq!(resolved, expected);
        assert_eq!(attempts, vec![false, true]);
    }

    #[test]
    fn saved_action_parent_rejects_a_refreshed_icon_from_another_display() {
        let expected = icon("target");
        let display_key = expected.display_key.clone().unwrap();
        let item_id = expected.item_id.clone().unwrap();
        let mut mismatched = expected;
        mismatched.display_key = Some("v1.display-uuid.b3RoZXI".to_string());
        let mut attempts = Vec::new();

        let error = resolve_saved_action_parent_with_refresh(&display_key, &item_id, |force| {
            attempts.push(force);
            Ok(force.then(|| mismatched.clone()))
        })
        .unwrap_err();

        assert_eq!(attempts, vec![false, true]);
        assert_eq!(
            error,
            "That menu-bar item is no longer available on this display."
        );
    }

    #[test]
    fn saved_action_parent_fails_closed_when_the_parent_remains_missing() {
        let expected = icon("target");
        let display_key = expected.display_key.unwrap();
        let item_id = expected.item_id.unwrap();
        let mut attempts = Vec::new();

        let error = resolve_saved_action_parent_with_refresh(&display_key, &item_id, |force| {
            attempts.push(force);
            Ok(None)
        })
        .unwrap_err();

        assert_eq!(attempts, vec![false, true]);
        assert_eq!(
            error,
            "That menu-bar item is no longer available on this display."
        );
    }

    #[test]
    fn saved_action_parent_never_accepts_macnu_itself() {
        let mut macnu = icon("target");
        let display_key = macnu.display_key.clone().unwrap();
        let item_id = macnu.item_id.clone().unwrap();
        macnu.is_macnu = true;

        assert!(
            resolve_saved_action_parent_with_refresh(&display_key, &item_id, |_| {
                Ok(Some(macnu.clone()))
            })
            .is_err()
        );
    }

    #[test]
    fn saved_action_sanitization_enforces_limits_and_shortcut_parent_confidence() {
        let low_confidence_parent = "v1.item-single.Y29tLmV4YW1wbGU";
        let (low_id, mut low) = saved_action(low_confidence_parent, "Open");
        low.shortcut = Some("Command+Period".to_string());
        let mut state = CatalogState::default();
        state.saved_actions.insert(low_id.clone(), low);
        let sanitized = sanitize_catalog_state(state, 500, None);
        assert!(sanitized.saved_actions.contains_key(&low_id));
        assert!(sanitized.saved_actions[&low_id].shortcut.is_none());

        let parent = "v1.item-identifier.Y29tLmV4YW1wbGU.aXRlbQ";
        let mut oversized = CatalogState::default();
        for index in 0..(MAX_SAVED_ACTIONS + 5) {
            let (id, saved) = saved_action(parent, &format!("Action {index}"));
            oversized.saved_actions.insert(id, saved);
        }
        let sanitized = sanitize_catalog_state(oversized, 500, None);
        assert_eq!(sanitized.saved_actions.len(), MAX_SAVED_ACTIONS);

        let (bad_id, mut bad) = saved_action(parent, "Invalid owner");
        bad.owner = "Bad\nOwner".to_string();
        let mut invalid = CatalogState::default();
        invalid.saved_actions.insert(bad_id, bad);
        assert!(sanitize_catalog_state(invalid, 500, None)
            .saved_actions
            .is_empty());
    }

    #[test]
    fn item_and_saved_action_shortcuts_collide_and_route_fail_closed() {
        let preferences = Preferences::default();
        let parent = "v1.item-identifier.Y29tLmV4YW1wbGU.aXRlbQ".to_string();
        let mut catalog = CatalogState::default();
        catalog.items.insert(
            parent.clone(),
            ItemCustomization {
                shortcut: Some("Command+Period".to_string()),
                hidden: true,
                ..ItemCustomization::default()
            },
        );
        let (saved_id, mut saved) = saved_action(&parent, "Disconnect");
        saved.shortcut = Some("Command+Period".to_string());
        catalog.saved_actions.insert(saved_id.clone(), saved);
        let pressed = shortcut_id("Command+Period").unwrap();
        assert_eq!(
            global_shortcut_route(pressed, &preferences, &catalog),
            GlobalShortcutRoute::None
        );
        let sanitized = sanitize_catalog_state(catalog.clone(), 500, None);
        assert!(sanitized.items[&parent].shortcut.is_none());
        assert!(sanitized.saved_actions[&saved_id].shortcut.is_none());

        catalog.items.get_mut(&parent).unwrap().shortcut = Some("Command+Comma".to_string());
        assert_eq!(
            global_shortcut_route(pressed, &preferences, &catalog),
            GlobalShortcutRoute::SavedAction(saved_id)
        );
    }

    #[test]
    fn startup_cleanup_removes_only_the_unavailable_saved_action_shortcut() {
        let preferences = Preferences::default();
        let parent = "v1.item-identifier.Y29tLmV4YW1wbGU.aXRlbQ";
        let (saved_id, mut saved) = saved_action(parent, "Disconnect");
        saved.shortcut = Some("Command+Period".to_string());
        let mut catalog = CatalogState::default();
        catalog.saved_actions.insert(saved_id.clone(), saved);

        let (reconciled, failures) =
            reconcile_persisted_direct_shortcuts(&preferences, &catalog, |_| {
                Err("occupied".to_string())
            });
        assert_eq!(failures.len(), 1);
        assert_eq!(
            failures[0].target,
            DirectShortcutTarget::SavedAction(saved_id.clone())
        );
        assert!(reconciled.saved_actions[&saved_id].shortcut.is_none());
    }

    #[test]
    fn parent_resolution_retries_stale_data_and_missing_parents_fail_closed() {
        let parent = icon("first").item_id.unwrap();
        let mut calls = Vec::new();
        let resolved = resolve_parent_icon_with_refresh(&parent, |force| {
            calls.push(force);
            Ok(force.then(|| icon("first")))
        })
        .unwrap();
        assert_eq!(resolved.item_id.as_deref(), Some(parent.as_str()));
        assert_eq!(calls, vec![false, true]);

        let mut missing_calls = 0;
        let error = resolve_parent_icon_with_refresh(&parent, |_| {
            missing_calls += 1;
            Ok(None)
        })
        .unwrap_err();
        assert_eq!(missing_calls, 2);
        assert!(error.contains("not available"));
    }

    #[test]
    fn successful_saved_action_usage_updates_parent_and_action_scopes() {
        let icon = icon("first");
        let parent = icon.item_id.clone().unwrap();
        let display = icon.display_key.clone().unwrap();
        let (saved_id, saved) = saved_action(&parent, "Disconnect");
        let mut state = CatalogState::default();
        state.saved_actions.insert(saved_id.clone(), saved);
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "macnu-saved-action-test-{}-{unique}",
            std::process::id()
        ));
        let store = CatalogStateStore {
            state: Arc::new(Mutex::new(state)),
            write_lock: Arc::new(Mutex::new(())),
            path: directory.join("catalog-state.json"),
            write_protected: false,
        };
        let preferences = PreferencesState {
            preferences: Arc::new(Mutex::new(Preferences::default())),
            write_lock: Arc::new(Mutex::new(())),
            path: directory.join("settings.json"),
            write_protected: false,
        };

        record_successful_saved_action_usage(&store, &preferences, &icon, &saved_id).unwrap();
        let updated = store.state.lock().unwrap().clone();
        assert_eq!(updated.items[&parent].global_usage.count, 1);
        assert_eq!(updated.displays[&display].usage[&parent].count, 1);
        assert_eq!(updated.saved_actions[&saved_id].global_usage.count, 1);
        assert_eq!(
            updated.saved_actions[&saved_id].display_usage[&display].count,
            1
        );
        let _ = fs::remove_file(&store.path);
        let _ = fs::remove_dir(&directory);
    }

    #[test]
    fn hidden_defaults_false_and_does_not_disable_direct_commands() {
        let preferences = Preferences::default();
        let item_id = "v1.item-identifier.Y29tLmV4YW1wbGU.aXRlbQ".to_string();
        let mut catalog = CatalogState::default();
        catalog
            .items
            .insert(item_id.clone(), ItemCustomization::default());
        let view = resolved_customizations(&catalog, &preferences, "v1.display-uuid.dGVzdA");
        assert!(!view.items[&item_id].hidden);

        let item = catalog.items.get_mut(&item_id).unwrap();
        item.hidden = true;
        item.shortcut = Some("Command+Period".to_string());
        prune_catalog_state(&mut catalog);
        assert!(catalog.items.contains_key(&item_id));
        assert_eq!(
            global_shortcut_route(
                shortcut_id("Command+Period").unwrap(),
                &preferences,
                &catalog
            ),
            GlobalShortcutRoute::Item(item_id)
        );
    }

    #[test]
    fn capacity_eviction_never_removes_hidden_only_customizations() {
        let hidden = "v1.item-identifier.Y29tLmV4YW1wbGU.aGlkZGVu".to_string();
        let usage_only = "v1.item-identifier.Y29tLmV4YW1wbGU.dXNhZ2U".to_string();
        let mut catalog = CatalogState::default();
        catalog.items.insert(
            hidden.clone(),
            ItemCustomization {
                hidden: true,
                ..ItemCustomization::default()
            },
        );
        catalog.items.insert(
            usage_only.clone(),
            ItemCustomization {
                global_usage: UsageStats {
                    count: 1,
                    last_used_at: Some(10),
                },
                ..ItemCustomization::default()
            },
        );

        assert_eq!(evict_oldest_usage_only_item(&mut catalog), Some(usage_only));
        assert!(catalog.items.contains_key(&hidden));
    }

    #[test]
    fn loaded_catalog_is_sanitized_and_shortcut_collisions_fail_closed() {
        let first = "v1.item-identifier.Y29tLmV4YW1wbGU.Zmlyc3Q".to_string();
        let second = "v1.item-identifier.Y29tLmV4YW1wbGU.c2Vjb25k".to_string();
        let reserved = "v1.item-identifier.Y29tLmV4YW1wbGU.cmVzZXJ2ZWQ".to_string();
        let malformed = "v1.item-identifier.Y29tLmV4YW1wbGU.bWFsZm9ybWVk".to_string();
        let single = "v1.item-single.Y29tLmV4YW1wbGU".to_string();
        let mut state = CatalogState::default();
        state.items.insert(
            first.clone(),
            ItemCustomization {
                alias: Some("Bad\nAlias".to_string()),
                shortcut: Some("Command+Period".to_string()),
                global_usage: UsageStats {
                    count: u64::MAX,
                    last_used_at: Some(900),
                },
                hidden: false,
            },
        );
        state.items.insert(
            second.clone(),
            ItemCustomization {
                shortcut: Some("Command+Period".to_string()),
                ..ItemCustomization::default()
            },
        );
        state.items.insert(
            reserved.clone(),
            ItemCustomization {
                shortcut: Some("Command+Comma".to_string()),
                ..ItemCustomization::default()
            },
        );
        state.items.insert(
            malformed.clone(),
            ItemCustomization {
                shortcut: Some("not-a-shortcut".to_string()),
                ..ItemCustomization::default()
            },
        );
        state.items.insert(
            single.clone(),
            ItemCustomization {
                alias: Some("  Stable alias  ".to_string()),
                shortcut: Some("Command+Period".to_string()),
                ..ItemCustomization::default()
            },
        );
        state.items.insert(
            "invalid-item".to_string(),
            ItemCustomization {
                alias: Some("Invalid".to_string()),
                ..ItemCustomization::default()
            },
        );
        state.global_favorites = vec![
            second.clone(),
            first.clone(),
            first.clone(),
            reserved.clone(),
            malformed.clone(),
            single.clone(),
            "invalid-item".to_string(),
        ];
        state.displays.insert(
            "v1.display-uuid.ZGlzcGxheQ".to_string(),
            DisplayCustomization {
                favorites: vec![second.clone(), second.clone()],
                usage: HashMap::from([(
                    first.clone(),
                    UsageStats {
                        count: u64::MAX,
                        last_used_at: Some(1_000),
                    },
                )]),
            },
        );
        state.displays.insert(
            "invalid-display".to_string(),
            DisplayCustomization {
                favorites: vec![first.clone()],
                usage: HashMap::new(),
            },
        );

        let sanitized = sanitize_catalog_state(state, 500, shortcut_id("Command+Comma").ok());

        assert!(!sanitized.items.contains_key("invalid-item"));
        assert_eq!(
            sanitized.items[&single].alias.as_deref(),
            Some("Stable alias")
        );
        assert!(sanitized.items.values().all(|item| item.shortcut.is_none()));
        assert_eq!(sanitized.items[&first].global_usage.count, MAX_USAGE_COUNT);
        assert_eq!(sanitized.items[&first].global_usage.last_used_at, Some(500));
        assert_eq!(
            sanitized.displays["v1.display-uuid.ZGlzcGxheQ"].usage[&first],
            UsageStats {
                count: MAX_USAGE_COUNT,
                last_used_at: Some(500),
            }
        );
        assert_eq!(sanitized.displays.len(), 1);
        assert_eq!(
            sanitized.global_favorites,
            vec![first, malformed, second, reserved, single]
        );
    }

    #[test]
    fn catalog_limits_preserve_protected_records_and_lru_usage() {
        let mut state = CatalogState::default();
        let usage_ids: Vec<_> = (0..MAX_PERSONALIZED_ITEMS)
            .map(|index| format!("v1.item-identifier.Y29tLmV4YW1wbGU.dXNhZ2U{index:04}"))
            .collect();
        for (index, item_id) in usage_ids.iter().enumerate() {
            state.items.insert(
                item_id.clone(),
                ItemCustomization {
                    global_usage: UsageStats {
                        count: 1,
                        last_used_at: Some(index as u64 + 1),
                    },
                    ..ItemCustomization::default()
                },
            );
        }
        let aliased = "v1.item-identifier.Y29tLmV4YW1wbGU.zzzzAlias".to_string();
        let shortcut = "v1.item-identifier.Y29tLmV4YW1wbGU.zzzzShortcut".to_string();
        let global_favorite = "v1.item-identifier.Y29tLmV4YW1wbGU.zzzzGlobalFavorite".to_string();
        let display_favorite = "v1.item-identifier.Y29tLmV4YW1wbGU.zzzzDisplayFavorite".to_string();
        state.items.insert(
            aliased.clone(),
            ItemCustomization {
                alias: Some("Protected alias".to_string()),
                ..ItemCustomization::default()
            },
        );
        state.items.insert(
            shortcut.clone(),
            ItemCustomization {
                shortcut: Some("Command+Period".to_string()),
                ..ItemCustomization::default()
            },
        );
        state
            .items
            .insert(global_favorite.clone(), ItemCustomization::default());
        state
            .items
            .insert(display_favorite.clone(), ItemCustomization::default());
        state.global_favorites.push(global_favorite.clone());

        let primary_display = "v1.display-uuid.A".to_string();
        state.displays.insert(
            primary_display.clone(),
            DisplayCustomization {
                favorites: vec![display_favorite.clone()],
                usage: HashMap::from([(
                    usage_ids[0].clone(),
                    UsageStats {
                        count: 1,
                        last_used_at: Some(10_000),
                    },
                )]),
            },
        );
        for index in 0..MAX_PERSONALIZED_DISPLAYS + 5 {
            let display_key = format!("v1.display-uuid.ZGlzcGxheS{index:04}");
            state
                .displays
                .insert(display_key, DisplayCustomization::default());
        }

        let sanitized = sanitize_catalog_state(state, 20_000, None);

        assert_eq!(sanitized.items.len(), MAX_PERSONALIZED_ITEMS);
        assert!(sanitized.items.contains_key(&aliased));
        assert!(sanitized.items.contains_key(&shortcut));
        assert!(sanitized.items.contains_key(&global_favorite));
        assert!(sanitized.items.contains_key(&display_favorite));
        assert!(sanitized.items.contains_key(&usage_ids[0]));
        for evicted in &usage_ids[1..=4] {
            assert!(!sanitized.items.contains_key(evicted));
        }
        assert!(sanitized.items.contains_key(&usage_ids[5]));
        assert_eq!(sanitized.global_favorites, vec![global_favorite]);
        assert_eq!(
            sanitized.displays[&primary_display].favorites,
            vec![display_favorite]
        );
        assert_eq!(
            sanitized.displays[&primary_display].usage[&usage_ids[0]].last_used_at,
            Some(10_000)
        );
        assert_eq!(sanitized.displays.len(), MAX_PERSONALIZED_DISPLAYS);
    }

    #[test]
    fn catalog_limit_never_discards_explicit_user_customizations() {
        let mut state = CatalogState::default();
        let protected_ids: Vec<_> = (0..=MAX_PERSONALIZED_ITEMS)
            .map(|index| format!("v1.item-identifier.Y29tLmV4YW1wbGU.cHJvdGVjdGVk{index:04}"))
            .collect();
        for (index, item_id) in protected_ids.iter().enumerate() {
            state.items.insert(
                item_id.clone(),
                ItemCustomization {
                    alias: Some(format!("Protected {index}")),
                    ..ItemCustomization::default()
                },
            );
        }
        let usage_only = "v1.item-identifier.Y29tLmV4YW1wbGU.dXNhZ2VPbmx5".to_string();
        state.items.insert(
            usage_only.clone(),
            ItemCustomization {
                global_usage: UsageStats {
                    count: 1,
                    last_used_at: Some(10_000),
                },
                ..ItemCustomization::default()
            },
        );

        let sanitized = sanitize_catalog_state(state, 20_000, None);

        assert_eq!(sanitized.items.len(), MAX_PERSONALIZED_ITEMS + 1);
        assert!(!sanitized.items.contains_key(&usage_only));
        assert!(protected_ids
            .iter()
            .all(|item_id| sanitized.items.contains_key(item_id)));
    }

    #[test]
    fn favorite_limit_is_an_error_but_existing_favorites_can_be_updated() {
        let mut favorites: Vec<_> = (0..MAX_FAVORITES_PER_SCOPE)
            .map(|index| format!("item-{index}"))
            .collect();

        assert!(update_favorite_list(&mut favorites, "new-item", true).is_err());
        assert!(update_favorite_list(&mut favorites, "item-0", true).is_ok());
        assert_eq!(favorites.len(), MAX_FAVORITES_PER_SCOPE);
        assert!(update_favorite_list(&mut favorites, "item-0", false).is_ok());
        assert_eq!(favorites.len(), MAX_FAVORITES_PER_SCOPE - 1);
    }

    #[test]
    fn pruning_removes_empty_items_without_erasing_display_overrides() {
        let removable = "v1.item-single.cmVtb3ZhYmxl".to_string();
        let favorite = "v1.item-single.ZmF2b3JpdGU".to_string();
        let aliased = "v1.item-single.YWxpYXNlZA".to_string();
        let mut catalog = CatalogState::default();
        catalog
            .items
            .insert(removable.clone(), ItemCustomization::default());
        catalog
            .items
            .insert(favorite.clone(), ItemCustomization::default());
        catalog.items.insert(
            aliased.clone(),
            ItemCustomization {
                alias: Some("Alias".to_string()),
                ..ItemCustomization::default()
            },
        );
        catalog.global_favorites.push(favorite.clone());
        catalog.displays.insert(
            "v1.display-uuid.ZW1wdHk".to_string(),
            DisplayCustomization {
                favorites: Vec::new(),
                usage: HashMap::from([(removable.clone(), UsageStats::default())]),
            },
        );

        prune_catalog_state(&mut catalog);

        assert!(!catalog.items.contains_key(&removable));
        assert!(catalog.items.contains_key(&favorite));
        assert!(catalog.items.contains_key(&aliased));
        assert!(catalog.displays.contains_key("v1.display-uuid.ZW1wdHk"));
    }

    #[test]
    fn lru_capacity_evicts_only_unreferenced_usage_records() {
        let oldest = "v1.item-identifier.Y29tLmV4YW1wbGU.b2xk".to_string();
        let newer = "v1.item-identifier.Y29tLmV4YW1wbGU.bmV3ZXI".to_string();
        let aliased = "v1.item-identifier.Y29tLmV4YW1wbGU.YWxpYXNlZA".to_string();
        let shortcut = "v1.item-identifier.Y29tLmV4YW1wbGU.c2hvcnRjdXQ".to_string();
        let global_favorite = "v1.item-identifier.Y29tLmV4YW1wbGU.Z2xvYmFsZmF2".to_string();
        let display_favorite = "v1.item-identifier.Y29tLmV4YW1wbGU.ZGlzcGxheWZhdg".to_string();
        let mut catalog = CatalogState::default();
        for (item_id, last_used_at) in [(&oldest, 1), (&newer, 200)] {
            catalog.items.insert(
                item_id.clone(),
                ItemCustomization {
                    global_usage: UsageStats {
                        count: 1,
                        last_used_at: Some(last_used_at),
                    },
                    ..ItemCustomization::default()
                },
            );
        }
        catalog.items.insert(
            aliased.clone(),
            ItemCustomization {
                alias: Some("Keep".to_string()),
                ..ItemCustomization::default()
            },
        );
        catalog.items.insert(
            shortcut.clone(),
            ItemCustomization {
                shortcut: Some("Command+Period".to_string()),
                ..ItemCustomization::default()
            },
        );
        catalog
            .items
            .insert(global_favorite.clone(), ItemCustomization::default());
        catalog
            .items
            .insert(display_favorite.clone(), ItemCustomization::default());
        catalog.global_favorites.push(global_favorite.clone());
        let display_key = "v1.display-uuid.ZXh0ZXJuYWw".to_string();
        catalog.displays.insert(
            display_key.clone(),
            DisplayCustomization {
                favorites: vec![display_favorite.clone()],
                usage: HashMap::from([(
                    oldest.clone(),
                    UsageStats {
                        count: 1,
                        last_used_at: Some(1),
                    },
                )]),
            },
        );
        for index in catalog.items.len()..MAX_PERSONALIZED_ITEMS {
            catalog.items.insert(
                format!("v1.item-identifier.Y29tLmV4YW1wbGU.ZmlsbGVy{index:04}"),
                ItemCustomization {
                    global_usage: UsageStats {
                        count: 1,
                        last_used_at: Some(100),
                    },
                    ..ItemCustomization::default()
                },
            );
        }

        assert!(ensure_catalog_item_capacity(&mut catalog));
        assert_eq!(catalog.items.len(), MAX_PERSONALIZED_ITEMS - 1);
        assert!(!catalog.items.contains_key(&oldest));
        assert!(catalog.items.contains_key(&newer));
        assert!(catalog.items.contains_key(&aliased));
        assert!(catalog.items.contains_key(&shortcut));
        assert!(catalog.items.contains_key(&global_favorite));
        assert!(catalog.items.contains_key(&display_favorite));
        assert!(!catalog.displays[&display_key].usage.contains_key(&oldest));
    }

    #[test]
    fn new_display_state_inherits_global_favorites_and_can_override_them() {
        let display_key = "v1.display-uuid.ZXh0ZXJuYWw";
        let first = "v1.item-identifier.Y29tLmV4YW1wbGU.Zmlyc3Q".to_string();
        let second = "v1.item-identifier.Y29tLmV4YW1wbGU.c2Vjb25k".to_string();
        let mut catalog = CatalogState::default();
        catalog
            .items
            .insert(first.clone(), ItemCustomization::default());
        catalog
            .items
            .insert(second.clone(), ItemCustomization::default());
        catalog.global_favorites = vec![first.clone(), second.clone()];

        ensure_display_customization(&mut catalog, display_key)
            .unwrap()
            .usage
            .insert(
                first.clone(),
                UsageStats {
                    count: 1,
                    last_used_at: Some(100),
                },
            );
        let inherited = resolved_customizations(&catalog, &Preferences::default(), display_key);
        assert!(inherited.items[&first].favorite);
        assert!(inherited.items[&second].favorite);

        update_display_favorite(&mut catalog, display_key, &first, false).unwrap();
        update_display_favorite(&mut catalog, display_key, &second, false).unwrap();
        catalog.displays.get_mut(display_key).unwrap().usage.clear();
        prune_catalog_state(&mut catalog);

        let overridden = resolved_customizations(&catalog, &Preferences::default(), display_key);
        assert!(!overridden.items[&first].favorite);
        assert!(!overridden.items[&second].favorite);
        assert!(catalog.displays.contains_key(display_key));
    }

    #[test]
    fn unseen_display_can_unfavorite_an_inherited_global_favorite() {
        let display_key = "v1.display-uuid.bmV3";
        let item_id = "v1.item-identifier.Y29tLmV4YW1wbGU.Zmlyc3Q".to_string();
        let mut catalog = CatalogState::default();
        catalog
            .items
            .insert(item_id.clone(), ItemCustomization::default());
        catalog.global_favorites.push(item_id.clone());

        update_display_favorite(&mut catalog, display_key, &item_id, false).unwrap();
        prune_catalog_state(&mut catalog);

        let resolved = resolved_customizations(&catalog, &Preferences::default(), display_key);
        assert!(!resolved.items[&item_id].favorite);
        assert!(catalog
            .displays
            .get(display_key)
            .is_some_and(|display| display.favorites.is_empty()));

        let json = serde_json::to_string(&catalog).unwrap();
        let reloaded = decode_catalog_state(&json, 500, None);
        assert!(!reloaded.write_protected);
        assert!(reloaded
            .value
            .displays
            .get(display_key)
            .is_some_and(|display| display.favorites.is_empty()));
        let resolved =
            resolved_customizations(&reloaded.value, &Preferences::default(), display_key);
        assert!(!resolved.items[&item_id].favorite);
    }

    #[test]
    fn customization_requires_an_exact_cached_display_and_item_pair() {
        let cache = MenuCache::default();
        let mut response = response();
        let item_id = response.icons[0].item_id.clone().unwrap();
        let mut self_icon = icon("self");
        self_icon.is_macnu = true;
        let self_id = self_icon.item_id.clone().unwrap();
        response.icons.push(self_icon);
        cache.responses.lock().unwrap().insert(
            response.display_id,
            MenuCacheEntry {
                response: response.clone(),
                refreshed_at: Instant::now(),
                menu_signature: 1,
            },
        );

        assert!(menu_cache_contains_item(&cache, &response.display_key, &item_id).unwrap());
        assert!(!menu_cache_contains_item(&cache, &response.display_key, &self_id).unwrap());
        assert!(!menu_cache_contains_item(&cache, "v1.display-uuid.b3RoZXI", &item_id).unwrap());
        assert!(
            !menu_cache_contains_item(&cache, &response.display_key, "v1.item-single.b3RoZXI")
                .unwrap()
        );
    }

    #[test]
    fn startup_registers_only_unique_high_confidence_non_launcher_shortcuts() {
        let preferences = Preferences::default();
        let first = "v1.item-identifier.Y29tLmV4YW1wbGU.Zmlyc3Q".to_string();
        let second = "v1.item-identifier.Y29tLmV4YW1wbGU.c2Vjb25k".to_string();
        let launcher = "v1.item-identifier.Y29tLmV4YW1wbGU.bGF1bmNoZXI".to_string();
        let low_confidence = "v1.item-single.Y29tLmV4YW1wbGU".to_string();
        let mut catalog = CatalogState::default();
        for item_id in [&first, &second] {
            catalog.items.insert(
                item_id.clone(),
                ItemCustomization {
                    shortcut: Some("Command+Period".to_string()),
                    ..ItemCustomization::default()
                },
            );
        }
        catalog.items.insert(
            launcher,
            ItemCustomization {
                shortcut: Some(DEFAULT_SHORTCUT.to_string()),
                ..ItemCustomization::default()
            },
        );
        catalog.items.insert(
            low_confidence,
            ItemCustomization {
                shortcut: Some("Command+Comma".to_string()),
                ..ItemCustomization::default()
            },
        );

        assert!(persisted_direct_shortcut_assignments(&preferences, &catalog).is_empty());

        catalog.items.get_mut(&second).unwrap().shortcut = Some("Command+Comma".to_string());
        let assignments = persisted_direct_shortcut_assignments(&preferences, &catalog);
        assert_eq!(assignments.len(), 2);
        assert_eq!(assignments[0].target, DirectShortcutTarget::Item(first));
        assert_eq!(assignments[1].target, DirectShortcutTarget::Item(second));
    }

    #[test]
    fn startup_reconciliation_removes_unavailable_shortcuts_from_views_and_storage() {
        let preferences = Preferences::default();
        let failed = "v1.item-identifier.Y29tLmV4YW1wbGU.ZmFpbGVk".to_string();
        let registered = "v1.item-identifier.Y29tLmV4YW1wbGU.c3VjY2Vzcw".to_string();
        let mut catalog = CatalogState::default();
        catalog.items.insert(
            failed.clone(),
            ItemCustomization {
                alias: Some("Keep this alias".to_string()),
                shortcut: Some("Command+Period".to_string()),
                ..ItemCustomization::default()
            },
        );
        catalog.items.insert(
            registered.clone(),
            ItemCustomization {
                shortcut: Some("Command+Comma".to_string()),
                ..ItemCustomization::default()
            },
        );
        let attempted = std::cell::RefCell::new(Vec::new());

        let (reconciled, failures) =
            reconcile_persisted_direct_shortcuts(&preferences, &catalog, |shortcut| {
                attempted.borrow_mut().push(shortcut.to_string());
                if shortcut == "Command+Period" {
                    Err("occupied".to_string())
                } else {
                    Ok(())
                }
            });

        assert_eq!(
            failures,
            vec![DirectShortcutRegistrationFailure {
                target: DirectShortcutTarget::Item(failed.clone()),
                shortcut: "Command+Period".to_string(),
                error: "occupied".to_string(),
            }]
        );
        assert_eq!(
            reconciled.items[&failed].alias.as_deref(),
            Some("Keep this alias")
        );
        assert!(reconciled.items[&failed].shortcut.is_none());
        assert_eq!(
            reconciled.items[&registered].shortcut.as_deref(),
            Some("Command+Comma")
        );
        let view = resolved_customizations(&reconciled, &preferences, "v1.display-uuid.dGVzdA");
        assert!(view.items[&failed].shortcut.is_none());

        let json = serde_json::to_string(&reconciled).unwrap();
        let reloaded = decode_catalog_state(&json, 500, None);
        assert!(reloaded.value.items[&failed].shortcut.is_none());
        assert_eq!(attempted.borrow().len(), 2);
    }

    #[test]
    fn shortcut_release_rolls_back_before_reporting_failure() {
        let shortcuts = vec![
            "Command+1".to_string(),
            "Command+2".to_string(),
            "Command+3".to_string(),
        ];
        let mut released = Vec::new();
        let mut restored = Vec::new();

        let error = release_shortcuts_atomically(
            &shortcuts,
            |shortcut| {
                if shortcut == "Command+2" {
                    Err("simulated failure".to_string())
                } else {
                    released.push(shortcut.to_string());
                    Ok(())
                }
            },
            |shortcut| {
                restored.push(shortcut.to_string());
                Ok(())
            },
        )
        .unwrap_err();

        assert!(error.contains("Command+2"));
        assert_eq!(released, vec!["Command+1"]);
        assert_eq!(restored, vec!["Command+1"]);
    }

    #[test]
    fn launcher_registration_failure_reports_restore_failure() {
        let operations = std::cell::RefCell::new(Vec::new());
        let persist_called = std::cell::Cell::new(false);

        let error = replace_shortcut_atomically(
            "Command+Semicolon",
            "Command+Period",
            |shortcut| {
                operations.borrow_mut().push(format!("release:{shortcut}"));
                Ok(())
            },
            |shortcut| {
                operations.borrow_mut().push(format!("register:{shortcut}"));
                if shortcut == "Command+Period" {
                    Err("replacement occupied".to_string())
                } else {
                    Err("restore unavailable".to_string())
                }
            },
            || {
                persist_called.set(true);
                Ok(())
            },
        )
        .unwrap_err();

        assert!(error.contains("replacement occupied"));
        assert!(error.contains("Could not restore Command+Semicolon"));
        assert!(error.contains("restore unavailable"));
        assert!(!persist_called.get());
        assert_eq!(
            operations.into_inner(),
            vec![
                "release:Command+Semicolon",
                "register:Command+Period",
                "register:Command+Semicolon",
            ]
        );
    }

    #[test]
    fn launcher_persistence_failure_reports_every_rollback_failure() {
        let operations = std::cell::RefCell::new(Vec::new());

        let error = replace_shortcut_atomically(
            "Command+Semicolon",
            "Command+Period",
            |shortcut| {
                operations.borrow_mut().push(format!("release:{shortcut}"));
                if shortcut == "Command+Period" {
                    Err("release rollback failed".to_string())
                } else {
                    Ok(())
                }
            },
            |shortcut| {
                operations.borrow_mut().push(format!("register:{shortcut}"));
                if shortcut == "Command+Semicolon" {
                    Err("restore rollback failed".to_string())
                } else {
                    Ok(())
                }
            },
            || Err("settings write failed".to_string()),
        )
        .unwrap_err();

        assert!(error.contains("settings write failed"));
        assert!(error.contains("release rollback failed"));
        assert!(error.contains("Could not restore Command+Semicolon"));
        assert!(error.contains("restore rollback failed"));
        assert_eq!(
            operations.into_inner(),
            vec![
                "release:Command+Semicolon",
                "register:Command+Period",
                "release:Command+Period",
                "register:Command+Semicolon",
            ]
        );
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
    fn menu_action_contract_preserves_paths_and_camel_case() {
        let action = MenuAction {
            id: "7:Account#0|8:Sign Out#1".to_string(),
            title: "Sign Out".to_string(),
            path: vec![
                MenuActionPathSegment {
                    title: "Account".to_string(),
                    occurrence: 0,
                },
                MenuActionPathSegment {
                    title: "Sign Out".to_string(),
                    occurrence: 1,
                },
            ],
            enabled: false,
            shortcut: None,
        };

        let json = serde_json::to_value(MenuActionsResponse {
            actions: vec![action],
            error: None,
        })
        .unwrap();

        assert_eq!(json["actions"][0]["path"][1]["occurrence"], 1);
        assert_eq!(json["actions"][0]["enabled"], false);
        assert!(json["actions"][0].get("shortcut").is_some());
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
