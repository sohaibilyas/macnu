import { Channel, invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./styles.css";

type Appearance = "system" | "light" | "dark";

const APPEARANCE_STORAGE_KEY = "macnu.appearance";
const appIconUrl = new URL("../src-tauri/icons/icon.png", import.meta.url).href;

function storedAppearance(): Appearance {
  try {
    const value = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (value === "light" || value === "dark") return value;
  } catch {
    // Falling back to macOS is safe if WebKit storage is unavailable.
  }
  return "system";
}

function applyAppearance(appearance = storedAppearance()): void {
  if (appearance === "system") {
    delete document.documentElement.dataset.appearance;
  } else {
    document.documentElement.dataset.appearance = appearance;
  }
}

function saveAppearance(appearance: Appearance): void {
  try {
    if (appearance === "system") {
      localStorage.removeItem(APPEARANCE_STORAGE_KEY);
    } else {
      localStorage.setItem(APPEARANCE_STORAGE_KEY, appearance);
    }
  } catch {
    // Still apply the selection for this session if persistence is unavailable.
  }
  applyAppearance(appearance);
}

applyAppearance();
window.addEventListener("storage", ({ key }) => {
  if (key === APPEARANCE_STORAGE_KEY) applyAppearance();
});

type MenuIcon = {
  windowId: number;
  owner: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  image: string;
  isMacnu: boolean;
  activationPid?: number | null;
  activationBundleId?: string | null;
  activationIdentifier?: string | null;
  activationX?: number | null;
  activationY?: number | null;
  activationWidth?: number | null;
  activationHeight?: number | null;
  activationAction?: string | null;
};

type MenuResponse = {
  icons: MenuIcon[];
  displayId: number;
  screenCaptureDenied: boolean;
  accessibilityDenied: boolean;
  error: string | null;
};

type ActiveDisplayCache = {
  displayId: number;
  response: MenuResponse | null;
  stale: boolean;
};

type MenuActionPathSegment = {
  title: string;
  occurrence: number;
};

type MenuAction = {
  id: string;
  title: string;
  path: MenuActionPathSegment[];
  enabled: boolean;
  shortcut: string | null;
};

type MenuActionsResponse = {
  actions: MenuAction[];
  error: string | null;
};

type SettingsResponse = {
  shortcut: string;
  startAtLoginStatus: number;
  onboardingCompleted: boolean;
  accessibilityGranted: boolean;
  screenCaptureGranted: boolean;
};

type PermissionStatus = Pick<
  SettingsResponse,
  "accessibilityGranted" | "screenCaptureGranted"
>;

type LicenseState =
  | "development"
  | "unlicensed"
  | "validating"
  | "licensed"
  | "needsValidation";

type LicenseStatus = {
  state: LicenseState;
  licenseRequired: boolean;
  canUseApp: boolean;
  plan: "personal" | "business" | null;
  offlineGrace: boolean;
  validationDue: boolean;
  lastValidatedAt: number | null;
  graceEndsAt: number | null;
  message: string | null;
};
type SettingsView = "general" | "permissions" | "updates" | "license";

type UpdateCheck = {
  supported: boolean;
  available: boolean;
  currentVersion: string;
  version: string | null;
  notes: string | null;
};

type UpdateInstallEvent =
  | { event: "started"; contentLength: number | null }
  | { event: "progress"; chunkLength: number; downloaded: number }
  | { event: "verifying" }
  | { event: "installing" }
  | { event: "restarting" };


const PERSONAL_CHECKOUT_URL =
  "https://qoest.lemonsqueezy.com/checkout/buy/12e893f2-c4df-423e-b2b1-b6b7f24bd07d?enabled=2046255";
const BUSINESS_CHECKOUT_URL =
  "https://qoest.lemonsqueezy.com/checkout/buy/fc6c40ec-376e-4fc5-806b-830a56ab3790?enabled=2046262";
const RECOVER_LICENSE_URL = "https://app.lemonsqueezy.com/my-orders";

const currentWindow = getCurrentWindow();
const app = document.querySelector<HTMLElement>("#app")!;

function enableWindowDragging(selector: string): void {
  const region = app.querySelector<HTMLElement>(selector);
  region?.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, a, [role='button']")) return;
    event.preventDefault();
    void currentWindow.startDragging();
  });
}

const keyLabels: Record<string, string> = {
  Period: ".",
  Comma: ",",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "−",
  Equal: "=",
  Backquote: "`",
  Space: "Space",
  Enter: "↵",
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

function shortcutParts(shortcut: string): string[] {
  return shortcut.split("+").map((part) => {
    const normalized = part.toLocaleLowerCase();
    if (["command", "cmd", "super"].includes(normalized)) return "⌘";
    if (["control", "ctrl"].includes(normalized)) return "⌃";
    if (["option", "alt"].includes(normalized)) return "⌥";
    if (normalized === "shift") return "⇧";
    if (part.startsWith("Key")) return part.slice(3).toLocaleUpperCase();
    if (part.startsWith("Digit")) return part.slice(5);
    return keyLabels[part] ?? part.replace(/^Numpad/, "Num ");
  });
}

function shortcutMarkup(shortcut: string): string {
  return shortcutParts(shortcut)
    .map((part) => `<kbd>${part}</kbd>`)
    .join("");
}

function eventShortcut(event: KeyboardEvent): string | null {
  if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return null;
  const modifiers: string[] = [];
  if (event.metaKey) modifiers.push("Command");
  if (event.ctrlKey) modifiers.push("Control");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (!modifiers.length) return null;
  return [...modifiers, event.code].join("+");
}

async function initSettings(): Promise<void> {
  app.innerHTML = `
    <section class="settings-window" aria-label="Macnu Settings">
      <header class="settings-titlebar">
        <img class="settings-app-icon" src="${appIconUrl}" alt="" draggable="false" />
        <span class="settings-heading">
          <strong>Macnu</strong>
          <small>Settings</small>
        </span>
        <button class="close settings-close" aria-label="Close Settings">×</button>
      </header>
      <div class="divider"></div>
      <div class="settings-body">
        <div class="settings-loading" role="status">
          <span class="loader" aria-hidden="true"></span>
          <span>Preparing Macnu…</span>
        </div>
        <div class="settings-layout" hidden>
          <aside class="settings-sidebar" role="tablist" aria-label="Settings sections">
            <button
              class="settings-nav selected"
              data-settings-view="general"
              role="tab"
              aria-controls="general-panel"
              aria-selected="true"
            >
              <span aria-hidden="true">⌘</span>
              General
            </button>
            <button
              class="settings-nav"
              data-settings-view="permissions"
              role="tab"
              aria-controls="permissions-panel"
              aria-selected="false"
            >
              <span aria-hidden="true">✓</span>
              Permissions
            </button>
            <button
              class="settings-nav"
              data-settings-view="updates"
              role="tab"
              aria-controls="updates-panel"
              aria-selected="false"
              hidden
            >
              <span aria-hidden="true">↑</span>
              Updates
            </button>
            <button
              class="settings-nav"
              data-settings-view="license"
              role="tab"
              aria-controls="license-panel"
              aria-selected="false"
              hidden
            >
              <span aria-hidden="true">◇</span>
              License
            </button>
            <div class="settings-version">Macnu</div>
          </aside>
          <main class="settings-content">
            <section
              class="settings-panel"
              id="general-panel"
              data-settings-panel="general"
              role="tabpanel"
            >
              <div class="settings-copy">
                <h1>General</h1>
                <p>Choose how Macnu looks, launches, and comes forward.</p>
              </div>
              <section class="settings-group">
                <div class="setting-row compact-setting-row">
                  <div class="setting-label">
                    <strong>Start at Login</strong>
                    <small>Keep Macnu ready after signing in.</small>
                  </div>
                  <label class="switch">
                    <input class="login-toggle" type="checkbox" aria-label="Start Macnu at login" />
                    <span></span>
                  </label>
                </div>
                <div class="setting-row compact-setting-row">
                  <div class="setting-label">
                    <strong>Appearance</strong>
                    <small>System follows your Mac automatically.</small>
                  </div>
                  <div class="appearance-picker" role="group" aria-label="Appearance">
                    <button data-appearance="system" aria-pressed="true">System</button>
                    <button data-appearance="light" aria-pressed="false">Light</button>
                    <button data-appearance="dark" aria-pressed="false">Dark</button>
                  </div>
                </div>
                <div class="setting-row compact-setting-row shortcut-row">
                  <div class="setting-label">
                    <strong>Open Macnu</strong>
                    <small>Click the shortcut, then press a new combination.</small>
                  </div>
                  <div class="shortcut-actions">
                    <button class="shortcut-recorder" aria-label="Change shortcut"></button>
                    <button class="shortcut-reset" title="Reset shortcut">Reset</button>
                  </div>
                </div>
              </section>
              <div class="source-build-notice" data-source-build-notice role="note" hidden>
                Source build — no paid license or signed Macnu releases are included.
              </div>
            </section>

            <section
              class="settings-panel"
              id="permissions-panel"
              data-settings-panel="permissions"
              role="tabpanel"
              hidden
            >
              <div class="settings-copy">
                <h1>Permissions</h1>
                <p>Macnu keeps menu-bar information on this Mac.</p>
              </div>
              <div class="permission-settings-list">
                <article class="permission-setting-card">
                  <span class="permission-preview-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="4.75" r="1.75" fill="currentColor" />
                      <path d="M5 8.25c2.1.8 4.45 1.2 7 1.2s4.9-.4 7-1.2M12 9.5v4.1m0 0-3.4 6m3.4-6 3.4 6" />
                    </svg>
                  </span>
                  <div class="permission-setting-copy">
                    <span class="permission-title-line">
                      <strong>Accessibility</strong>
                      <span class="permission-badge" data-permission-badge="accessibility">Checking…</span>
                    </span>
                    <small>Finds menu-bar items by name and opens the menu you choose.</small>
                  </div>
                  <button class="secondary-action permission-settings-action" data-open-permission="accessibility">Open Settings</button>
                </article>
                <article class="permission-setting-card">
                  <span class="permission-preview-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none">
                      <rect x="3" y="4.5" width="18" height="13" rx="2.5" />
                      <path d="M8.5 20h7M12 17.5V20" />
                      <circle cx="12" cy="11" r="2.5" />
                    </svg>
                  </span>
                  <div class="permission-setting-copy">
                    <span class="permission-title-line">
                      <strong>Screen Recording</strong>
                      <span class="permission-badge optional" data-permission-badge="screen">Optional</span>
                    </span>
                    <small>Captures only menu-bar icon images locally. Search and opening work without it.</small>
                  </div>
                  <button class="secondary-action permission-settings-action" data-open-permission="screen">Open Settings</button>
                </article>
              </div>
              <div class="permission-settings-footer">
                <button class="permission-recheck" data-recheck-permissions>Recheck permissions</button>
                <button class="permission-recheck" data-run-onboarding>Run setup again</button>
              </div>
            </section>
            <section
              class="settings-panel"
              id="updates-panel"
              data-settings-panel="updates"
              role="tabpanel"
              hidden
            >
              <div class="settings-copy">
                <h1>Updates</h1>
                <p>Macnu checks quietly and installs only signed official releases.</p>
              </div>
              <article class="update-card" data-update-card>
                <span class="update-state-mark" data-update-mark aria-hidden="true">↻</span>
                <div class="update-state-copy">
                  <strong data-update-title>Ready to check</strong>
                  <small data-update-summary>Macnu</small>
                </div>
                <button class="secondary-action update-check" data-check-updates>Check Now</button>
              </article>
              <div class="update-progress" data-update-progress hidden>
                <progress max="1" value="0" aria-label="Update download progress"></progress>
                <span data-update-progress-label>Preparing update…</span>
              </div>
              <div class="update-notes" data-update-notes-container hidden>
                <strong>What’s new</strong>
                <p data-update-notes></p>
              </div>
              <div class="update-actions">
                <button class="primary-action update-install" data-install-update hidden>
                  Download and Restart
                </button>
                <span class="update-panel-status" data-update-status role="status" aria-live="polite" aria-atomic="true"></span>
              </div>
            </section>


            <section
              class="settings-panel"
              id="license-panel"
              data-settings-panel="license"
              role="tabpanel"
              hidden
            >
              <div class="settings-copy">
                <h1>License</h1>
                <p>Manage the license activated on this Mac.</p>
              </div>
              <section class="license-summary" aria-label="License details">
                <div class="license-summary-heading">
                  <span class="license-state-mark" aria-hidden="true">✓</span>
                  <div>
                    <strong data-license-plan>Macnu license</strong>
                    <small data-license-summary>Activated on this Mac</small>
                  </div>
                </div>
                <dl class="license-facts">
                  <div>
                    <dt>License key</dt>
                    <dd>Stored securely in Keychain</dd>
                  </div>
                </dl>
              </section>
              <div class="license-settings-actions">
                <button class="secondary-action license-refresh" data-refresh-license>Check Again</button>
                <button class="danger-action license-deactivate" data-request-deactivation>Deactivate This Mac</button>
              </div>
              <div class="license-panel-status" role="status" aria-live="polite" aria-atomic="true"></div>
              <div class="license-deactivate-confirmation" role="group" aria-label="Confirm license deactivation" hidden>
                <span>This Mac will return to the activation screen.</span>
                <div>
                  <button class="secondary-action" data-cancel-deactivation>Cancel</button>
                  <button class="danger-action" data-confirm-deactivation>Deactivate</button>
                </div>
              </div>
            </section>

            <div class="settings-message-row">
              <div class="settings-message" role="status" aria-live="polite"></div>
              <button class="login-settings-link" hidden>Open Login Items</button>
            </div>
          </main>
        </div>

        <main class="license-gate" aria-labelledby="license-gate-title" hidden>
          <div class="license-gate-simple">
            <img src="${appIconUrl}" alt="" draggable="false" />
            <div class="gate-copy">
              <h1 id="license-gate-title">Activate Macnu</h1>
              <p>Enter the license key from your purchase email.</p>
            </div>
            <form class="license-activation-form" novalidate>
              <label for="license-key">License key</label>
              <div class="license-key-control">
                <input
                  id="license-key"
                  name="license-key"
                  type="text"
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck="false"
                  aria-describedby="license-gate-status license-gate-error"
                  placeholder="XXXX-XXXX-XXXX-XXXX"
                />
                <button class="primary-action" type="submit">Activate</button>
              </div>
            </form>
            <div id="license-gate-status" class="license-gate-status" role="status" aria-live="polite" aria-atomic="true"></div>
            <div id="license-gate-error" class="license-gate-error" role="alert" aria-live="assertive"></div>
            <nav class="license-help-links" aria-label="License help">
              <a data-license-link="personal" role="link" aria-disabled="true">Personal — $9.99</a>
              <button
                type="button"
                data-show-business-checkout
                aria-expanded="false"
                aria-controls="business-seat-picker"
              >Business — $9.99/seat</button>
              <a data-license-link="recover" role="link" aria-disabled="true">Recover license</a>
            </nav>
            <form id="business-seat-picker" class="business-seat-picker" hidden>
              <label for="business-seats">Business seats</label>
              <input id="business-seats" name="business-seats" type="number" min="1" max="999" step="1" value="1" inputmode="numeric" />
              <button class="secondary-action" type="submit">Continue</button>
              <small>2 Macs per seat</small>
            </form>
          </div>
        </main>

        <main class="onboarding permission-gate" aria-labelledby="permission-gate-title" hidden>
          <div class="gate-simple">
            <div class="gate-success-icon" aria-hidden="true">✓</div>
            <div class="gate-copy">
              <h1 id="permission-gate-title" data-gate-title>Allow Accessibility</h1>
              <p data-gate-description>Macnu needs this permission to find and open menu-bar items.</p>
            </div>

            <button class="primary-action gate-open-settings" data-open-permission="accessibility">Open System Settings</button>
            <button class="primary-action finish-onboarding" hidden>Start Macnu</button>

            <div class="gate-live-status" role="status" aria-live="polite" aria-atomic="true">
              <span class="gate-live-icon" aria-hidden="true"></span>
              <span data-gate-status>Checking permission…</span>
            </div>

            <button class="gate-fallback-link" data-reveal-app hidden>Macnu not listed? <span>Show in Finder</span></button>
            <div class="onboarding-error" role="alert"></div>
          </div>
        </main>
      </div>
    </section>
  `;

  enableWindowDragging(".settings-titlebar");

  const toggle = app.querySelector<HTMLInputElement>(".login-toggle")!;
  const recorder = app.querySelector<HTMLButtonElement>(".shortcut-recorder")!;
  const reset = app.querySelector<HTMLButtonElement>(".shortcut-reset")!;
  const message = app.querySelector<HTMLElement>(".settings-message")!;
  const loginSettingsLink = app.querySelector<HTMLButtonElement>(".login-settings-link")!;
  const settingsLayout = app.querySelector<HTMLElement>(".settings-layout")!;
  const settingsLoading = app.querySelector<HTMLElement>(".settings-loading")!;
  const licenseGate = app.querySelector<HTMLElement>(".license-gate")!;
  const licenseForm = app.querySelector<HTMLFormElement>(".license-activation-form")!;
  const licenseInput = app.querySelector<HTMLInputElement>("#license-key")!;
  const licenseActivateButton = licenseForm.querySelector<HTMLButtonElement>("button[type='submit']")!;
  const licenseGateStatus = app.querySelector<HTMLElement>(".license-gate-status")!;
  const licenseGateError = app.querySelector<HTMLElement>(".license-gate-error")!;
  const businessCheckoutButton = app.querySelector<HTMLButtonElement>("[data-show-business-checkout]")!;
  const businessSeatForm = app.querySelector<HTMLFormElement>(".business-seat-picker")!;
  const businessSeatInput = app.querySelector<HTMLInputElement>("#business-seats")!;
  const licensePanelStatus = app.querySelector<HTMLElement>(".license-panel-status")!;
  const deactivationConfirmation = app.querySelector<HTMLElement>(".license-deactivate-confirmation")!;
  const onboarding = app.querySelector<HTMLElement>(".onboarding")!;
  const settingsVersion = app.querySelector<HTMLElement>(".settings-version")!;
  const updatesNav = app.querySelector<HTMLButtonElement>("[data-settings-view='updates']")!;
  const updateCard = app.querySelector<HTMLElement>("[data-update-card]")!;
  const updateMark = app.querySelector<HTMLElement>("[data-update-mark]")!;
  const updateTitle = app.querySelector<HTMLElement>("[data-update-title]")!;
  const updateSummary = app.querySelector<HTMLElement>("[data-update-summary]")!;
  const updateCheckButton = app.querySelector<HTMLButtonElement>("[data-check-updates]")!;
  const updateInstallButton = app.querySelector<HTMLButtonElement>("[data-install-update]")!;
  const updateProgress = app.querySelector<HTMLElement>("[data-update-progress]")!;
  const updateProgressBar = updateProgress.querySelector<HTMLProgressElement>("progress")!;
  const updateProgressLabel = app.querySelector<HTMLElement>("[data-update-progress-label]")!;
  const updateNotesContainer = app.querySelector<HTMLElement>("[data-update-notes-container]")!;
  const updateNotes = app.querySelector<HTMLElement>("[data-update-notes]")!;
  const updateStatus = app.querySelector<HTMLElement>("[data-update-status]")!;
  let appVersion = "";
  let pendingUpdateVersion: string | null = null;
  let automaticUpdateCheckStarted = false;
  let updateBusy = false;
  let updateContentLength: number | null = null;
  let settings: SettingsResponse | null = null;
  let permissionStatus: PermissionStatus | null = null;
  let recording = false;
  let licenseStatusLoaded = false;
  let settingsResolved = false;
  let licenseGuardVisible = true;
  let permissionGuardVisible = false;
  let permissionSettingsOpened = false;

  function setMessage(text = "", kind: "info" | "error" = "info"): void {
    message.className = `settings-message ${kind}`;
    message.textContent = text;
  }

  function showActionError(error: unknown): void {
    if (!licenseGate.hidden) {
      licenseGateStatus.textContent = "";
      licenseGateError.textContent = String(error);
      return;
    }
    if (!onboarding.hidden) {
      const errorTarget = app.querySelector<HTMLElement>(".onboarding-error");
      if (errorTarget) {
        errorTarget.textContent = String(error);
        return;
      }
    }
    setMessage(String(error), "error");
  }

  function updateAppearanceControls(): void {
    const appearance = storedAppearance();
    app.querySelectorAll<HTMLButtonElement>("[data-appearance]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.appearance === appearance));
    });
  }

  function setUpdateBusy(busy: boolean): void {
    updateBusy = busy;
    updateCheckButton.disabled = busy;
    updateInstallButton.disabled = busy;
    updateCard.setAttribute("aria-busy", String(busy));
  }

  function setUpdateStatus(text = "", error = false): void {
    updateStatus.classList.toggle("error", error);
    updateStatus.textContent = text;
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1_024) return `${bytes} B`;
    if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
    return `${(bytes / 1_048_576).toFixed(1)} MB`;
  }

  function setDisplayedVersion(version: string): void {
    appVersion = version;
    settingsVersion.textContent = `Macnu ${version}`;
  }

  function applyUpdateCheck(result: UpdateCheck): void {
    setDisplayedVersion(result.currentVersion);
    pendingUpdateVersion = result.available ? result.version : null;
    updateContentLength = null;
    updateProgress.hidden = true;
    updateProgressBar.max = 1;
    updateProgressBar.value = 0;
    updateCard.classList.remove("available", "current", "error", "checking");
    updateCheckButton.textContent = "Check Again";

    if (!result.supported) {
      updateMark.textContent = "—";
      updateTitle.textContent = "Updates aren’t included in this build";
      updateSummary.textContent = `Macnu ${result.currentVersion}`;
      updateInstallButton.hidden = true;
      updateNotesContainer.hidden = true;
      setUpdateStatus();
      return;
    }

    if (result.available && result.version) {
      updateCard.classList.add("available");
      updateMark.textContent = "↑";
      updateTitle.textContent = `Macnu ${result.version} is available`;
      updateSummary.textContent = `Installed version ${result.currentVersion}`;
      updateInstallButton.hidden = false;
      updateNotes.textContent = result.notes ?? "";
      updateNotesContainer.hidden = !result.notes;
      setUpdateStatus("Signed official release ready.");
      return;
    }

    updateCard.classList.add("current");
    updateMark.textContent = "✓";
    updateTitle.textContent = "Macnu is up to date";
    updateSummary.textContent = `Version ${result.currentVersion}`;
    updateInstallButton.hidden = true;
    updateNotesContainer.hidden = true;
    updateNotes.textContent = "";
    setUpdateStatus("Checked just now.");
  }

  async function checkForUpdates(manual = false): Promise<void> {
    if (updateBusy) return;
    setUpdateBusy(true);
    pendingUpdateVersion = null;
    updateInstallButton.hidden = true;
    updateNotesContainer.hidden = true;
    updateProgress.hidden = true;
    updateCard.classList.remove("available", "current", "error");
    updateCard.classList.add("checking");
    updateMark.textContent = "↻";
    updateTitle.textContent = "Checking for updates…";
    updateSummary.textContent = appVersion ? `Macnu ${appVersion}` : "Macnu";
    setUpdateStatus(manual ? "Contacting the official release feed…" : "");

    try {
      applyUpdateCheck(await invoke<UpdateCheck>("check_for_updates"));
    } catch (error) {
      updateCard.classList.remove("checking");
      updateCard.classList.add("error");
      updateMark.textContent = "!";
      updateTitle.textContent = "Couldn’t check for updates";
      updateSummary.textContent = appVersion ? `Macnu ${appVersion}` : "Your current app is unchanged.";
      updateInstallButton.hidden = true;
      setUpdateStatus(String(error), true);
    } finally {
      setUpdateBusy(false);
    }
  }

  async function installAvailableUpdate(): Promise<void> {
    if (updateBusy || !pendingUpdateVersion) return;
    const expectedVersion = pendingUpdateVersion;
    setUpdateBusy(true);
    setUpdateStatus("Downloading signed update…");
    updateProgress.hidden = false;
    updateProgressBar.max = 1;
    updateProgressBar.value = 0;
    updateProgressLabel.textContent = "Starting download…";

    const onEvent = new Channel<UpdateInstallEvent>();
    onEvent.onmessage = (event) => {
      switch (event.event) {
        case "started":
          updateContentLength = event.contentLength;
          updateProgressBar.max = event.contentLength && event.contentLength > 0
            ? event.contentLength
            : 1;
          updateProgressBar.value = 0;
          updateProgressLabel.textContent = event.contentLength
            ? `Downloading ${formatBytes(event.contentLength)}…`
            : "Downloading update…";
          break;
        case "progress": {
          if (updateContentLength && updateContentLength > 0) {
            updateProgressBar.max = updateContentLength;
            updateProgressBar.value = Math.min(event.downloaded, updateContentLength);
            const percentage = Math.min(
              100,
              Math.round((event.downloaded / updateContentLength) * 100),
            );
            updateProgressLabel.textContent = `Downloading… ${percentage}%`;
          } else {
            updateProgressLabel.textContent = `Downloaded ${formatBytes(event.downloaded)}…`;
          }
          break;
        }
        case "verifying":
          updateProgressBar.removeAttribute("value");
          updateProgressLabel.textContent = "Verifying signature and app identity…";
          setUpdateStatus("Checking the signed app before installation.");
          break;
        case "installing":
          updateProgressLabel.textContent = "Installing update…";
          setUpdateStatus("Your current copy stays safe until installation succeeds.");
          break;
        case "restarting":
          updateProgressLabel.textContent = "Restarting Macnu…";
          setUpdateStatus("Update installed.");
          break;
      }
    };

    try {
      await invoke("install_update", { expectedVersion, onEvent });
    } catch (error) {
      updateProgress.hidden = true;
      setUpdateStatus(String(error), true);
    } finally {
      setUpdateBusy(false);
    }
  }

  void getVersion()
    .then((version) => {
      setDisplayedVersion(version);
      if (!pendingUpdateVersion) updateSummary.textContent = `Macnu ${version}`;
    })
    .catch(() => {
      settingsVersion.textContent = "Macnu";
    });

  function showSettingsView(view: SettingsView): void {
    app.querySelectorAll<HTMLButtonElement>("[data-settings-view]").forEach((button) => {
      const selected = button.dataset.settingsView === view;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    app.querySelectorAll<HTMLElement>("[data-settings-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.settingsPanel !== view;
    });
  }

  function syncVisibleSurface(): void {
    const waitingForLicense = !licenseStatusLoaded;
    const waitingForSettings = !licenseGuardVisible && !settingsResolved;
    const loading = waitingForLicense || waitingForSettings;

    settingsLoading.hidden = !loading;
    settingsLayout.hidden = loading || licenseGuardVisible || permissionGuardVisible;
    licenseGate.hidden = loading || !licenseGuardVisible;
    onboarding.hidden = loading || licenseGuardVisible || !permissionGuardVisible;
    app.querySelector<HTMLElement>(".settings-heading small")!.textContent = licenseGuardVisible
      ? "Activation"
      : permissionGuardVisible
        ? "Setup"
        : "Settings";
  }

  function readablePlan(plan: LicenseStatus["plan"]): string {
    if (plan === "business") return "Business license";
    if (plan === "personal") return "Personal license";
    return "Macnu license";
  }

  function formatLicenseDate(timestamp: number | null): string | null {
    if (timestamp === null) return null;
    const date = new Date(timestamp * 1_000);
    if (Number.isNaN(date.getTime())) return null;
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  }

  function applyLicenseStatus(next: LicenseStatus): void {
    licenseStatusLoaded = true;
    licenseGuardVisible = next.licenseRequired && !next.canUseApp;
    app.querySelector<HTMLElement>("[data-source-build-notice]")!.hidden =
      next.state !== "development" || next.licenseRequired;

    const licenseNav = app.querySelector<HTMLButtonElement>("[data-settings-view='license']")!;
    const showLicenseSettings = next.licenseRequired && next.canUseApp && next.plan !== null;
    licenseNav.hidden = !showLicenseSettings;
    if (!showLicenseSettings && licenseNav.classList.contains("selected")) {
      showSettingsView("general");
    }

    updatesNav.hidden = !next.licenseRequired;
    if (!next.licenseRequired && updatesNav.classList.contains("selected")) {
      showSettingsView("general");
    }
    if (next.licenseRequired && !automaticUpdateCheckStarted) {
      automaticUpdateCheckStarted = true;
      window.setTimeout(() => {
        void checkForUpdates();
      }, 900);
    }

    app.querySelector<HTMLElement>("[data-license-plan]")!.textContent = readablePlan(next.plan);
    const summary = app.querySelector<HTMLElement>("[data-license-summary]")!;
    if (next.offlineGrace) {
      const graceEnd = formatLicenseDate(next.graceEndsAt);
      summary.textContent = graceEnd
        ? `Offline access until ${graceEnd}`
        : "Using temporary offline access";
    } else if (next.validationDue) {
      summary.textContent = "License check recommended";
    } else {
      const lastChecked = formatLicenseDate(next.lastValidatedAt);
      summary.textContent = lastChecked ? `Checked ${lastChecked}` : "Activated on this Mac";
    }

    licenseGateError.textContent = "";
    licenseGateStatus.textContent = next.state === "validating"
      ? "Checking license…"
      : licenseGuardVisible
        ? next.message ?? "A license is required to use Macnu."
        : "";
    setLicensePanelMessage(next.canUseApp ? next.message ?? "" : "");
    deactivationConfirmation.hidden = true;
    syncVisibleSurface();

    if (licenseGuardVisible) {
      window.setTimeout(() => licenseInput.focus());
    }
  }

  function setLicensePanelMessage(text = "", error = false): void {
    licensePanelStatus.classList.toggle("error", error);
    licensePanelStatus.textContent = text;
  }

  function resetBusinessCheckout(): void {
    businessSeatForm.hidden = true;
    businessSeatInput.value = "1";
    businessCheckoutButton.setAttribute("aria-expanded", "false");
  }

  function hideSettingsWindow(): void {
    licenseInput.value = "";
    licenseGateError.textContent = "";
    deactivationConfirmation.hidden = true;
    resetBusinessCheckout();
    void invoke("close_settings").catch(() => currentWindow.hide());
  }

  function updatePermissionStatus(next: PermissionStatus): void {
    const previouslyGranted = permissionStatus?.accessibilityGranted;
    permissionStatus = next;
    const accessibilityLabel = next.accessibilityGranted ? "Allowed" : "Not allowed";
    const screenLabel = next.screenCaptureGranted ? "Allowed" : "Optional";

    app.querySelectorAll<HTMLElement>("[data-permission-badge='accessibility']").forEach((badge) => {
      badge.textContent = accessibilityLabel;
      badge.classList.toggle("granted", next.accessibilityGranted);
    });
    app.querySelectorAll<HTMLElement>("[data-permission-badge='screen']").forEach((badge) => {
      badge.textContent = screenLabel;
      badge.classList.toggle("granted", next.screenCaptureGranted);
    });

    onboarding.classList.toggle("granted", next.accessibilityGranted);
    onboarding.classList.toggle("settings-opened", permissionSettingsOpened);
    app.querySelector<HTMLElement>("[data-gate-title]")!.textContent = next.accessibilityGranted
      ? "Macnu is ready"
      : "Allow Accessibility";
    app.querySelector<HTMLElement>("[data-gate-description]")!.textContent = next.accessibilityGranted
      ? "Accessibility is on."
      : "Macnu needs this permission to find and open menu-bar items.";
    app.querySelector<HTMLElement>("[data-gate-status]")!.textContent = next.accessibilityGranted
      ? "Accessibility allowed"
      : permissionSettingsOpened
        ? "Waiting for you to turn on Macnu…"
        : "Turn on Macnu in the list. We’ll detect it automatically.";
    app.querySelector<HTMLElement>(".gate-live-icon")!.textContent = next.accessibilityGranted ? "✓" : "";
    app.querySelector<HTMLButtonElement>(".gate-open-settings")!.hidden = next.accessibilityGranted;
    app.querySelector<HTMLButtonElement>(".finish-onboarding")!.hidden = !next.accessibilityGranted;
    app.querySelector<HTMLButtonElement>(".gate-fallback-link")!.hidden = !permissionSettingsOpened || next.accessibilityGranted;

    app.querySelectorAll<HTMLButtonElement>(".permission-settings-action").forEach((button) => {
      const granted = button.dataset.openPermission === "accessibility"
        ? next.accessibilityGranted
        : next.screenCaptureGranted;
      button.textContent = granted ? "Review" : "Open Settings";
    });

    if (!next.accessibilityGranted) {
      permissionGuardVisible = true;
      syncVisibleSurface();
    } else if (previouslyGranted === false && permissionGuardVisible) {
      window.setTimeout(() => app.querySelector<HTMLButtonElement>(".finish-onboarding")?.focus());
    }
  }

  function applySettings(next: SettingsResponse): void {
    settings = next;
    updatePermissionStatus(next);
    toggle.checked = [1, 2].includes(next.startAtLoginStatus);
    recorder.innerHTML = shortcutMarkup(next.shortcut);
    recorder.classList.remove("recording");
    recording = false;
    settingsResolved = true;
    permissionGuardVisible = !next.onboardingCompleted || !next.accessibilityGranted;
    syncVisibleSurface();
    if (permissionGuardVisible) {
      window.setTimeout(() => {
        app.querySelector<HTMLButtonElement>(".finish-onboarding:not([hidden]), .gate-open-settings:not([hidden])")?.focus();
      });
    }

    loginSettingsLink.hidden = true;
    if (next.startAtLoginStatus === 2) {
      setMessage("Start at Login needs approval.");
      loginSettingsLink.hidden = false;
    } else if (next.startAtLoginStatus === 3) {
      setMessage("Move Macnu into Applications to enable Start at Login.", "error");
    } else {
      setMessage();
    }
  }

  async function refreshSettings(): Promise<void> {
    try {
      applySettings(await invoke<SettingsResponse>("get_settings"));
    } catch (error) {
      settingsResolved = true;
      syncVisibleSurface();
      setMessage(String(error), "error");
    }
  }

  async function refreshLicenseStatus(force = false): Promise<LicenseStatus> {
    const next = force
      ? await invoke<LicenseStatus>("refresh_license", { force: true })
      : await invoke<LicenseStatus>("get_license_status");
    applyLicenseStatus(next);
    return next;
  }

  async function refreshAppState(): Promise<void> {
    try {
      const next = await refreshLicenseStatus();
      if (next.canUseApp) await refreshSettings();
    } catch (error) {
      licenseStatusLoaded = true;
      licenseGuardVisible = true;
      syncVisibleSurface();
      licenseGateStatus.textContent = "";
      licenseGateError.textContent = String(error);
    }
  }

  async function refreshPermissionStatus(): Promise<void> {
    const buttons = app.querySelectorAll<HTMLButtonElement>("[data-recheck-permissions]");
    buttons.forEach((button) => (button.disabled = true));
    try {
      updatePermissionStatus(await invoke<PermissionStatus>("get_permission_status"));
    } catch (error) {
      showActionError(error);
    } finally {
      buttons.forEach((button) => (button.disabled = false));
    }
  }

  licenseForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    licenseGateError.textContent = "";
    if (!licenseInput.value.trim()) {
      licenseGateError.textContent = "Enter your license key.";
      licenseInput.focus();
      return;
    }

    licenseActivateButton.disabled = true;
    licenseForm.setAttribute("aria-busy", "true");
    licenseGateStatus.textContent = "Checking license…";

    // Start the native invocation before clearing the field. No raw key is
    // copied into frontend state, storage, logs, or the returned status.
    const activation = invoke<LicenseStatus>("activate_license", {
      licenseKey: licenseInput.value.trim(),
    });
    licenseInput.value = "";

    try {
      const next = await activation;
      applyLicenseStatus(next);
      if (!next.canUseApp) {
        licenseGateStatus.textContent = "";
        licenseGateError.textContent = next.message ?? "That license could not be activated.";
        licenseInput.focus();
      } else {
        await refreshSettings();
      }
    } catch (error) {
      licenseGateStatus.textContent = "";
      licenseGateError.textContent = String(error);
      licenseInput.focus();
    } finally {
      licenseActivateButton.disabled = false;
      licenseForm.removeAttribute("aria-busy");
    }
  });

  licenseInput.addEventListener("input", () => {
    licenseGateError.textContent = "";
  });

  async function openLicenseUrl(url: string): Promise<void> {
    licenseGateError.textContent = "";
    try {
      await openUrl(url);
    } catch (error) {
      licenseGateStatus.textContent = "";
      licenseGateError.textContent = `Could not open your browser: ${String(error)}`;
    }
  }

  const licenseUrls: Record<string, string> = {
    personal: PERSONAL_CHECKOUT_URL,
    recover: RECOVER_LICENSE_URL,
  };

  app.querySelectorAll<HTMLAnchorElement>("[data-license-link]").forEach((link) => {
    const url = licenseUrls[link.dataset.licenseLink ?? ""];
    if (url) {
      link.href = url;
      link.removeAttribute("aria-disabled");
      link.addEventListener("click", (event) => {
        event.preventDefault();
        resetBusinessCheckout();
        void openLicenseUrl(url);
      });
    } else {
      link.tabIndex = 0;
      link.title = "Link coming soon";
    }
  });

  businessCheckoutButton.addEventListener("click", () => {
    const willOpen = businessSeatForm.hidden;
    businessSeatForm.hidden = !willOpen;
    businessCheckoutButton.setAttribute("aria-expanded", String(willOpen));
    licenseGateStatus.textContent = "";
    licenseGateError.textContent = "";
    if (willOpen) {
      businessSeatInput.focus();
      businessSeatInput.select();
    }
  });

  businessSeatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const seats = Number(businessSeatInput.value);
    if (!Number.isSafeInteger(seats) || seats < 1 || seats > 999) {
      licenseGateError.textContent = "Enter a seat count from 1 to 999.";
      businessSeatInput.focus();
      return;
    }

    const checkoutUrl = new URL(BUSINESS_CHECKOUT_URL);
    checkoutUrl.searchParams.set("quantity", String(seats));
    void openLicenseUrl(checkoutUrl.toString());
  });

  async function openPermission(kind: "accessibility" | "screen"): Promise<void> {
    if (kind === "accessibility" && permissionGuardVisible) {
      permissionSettingsOpened = true;
      if (permissionStatus) updatePermissionStatus(permissionStatus);
    }
    const buttons = app.querySelectorAll<HTMLButtonElement>(`[data-open-permission="${kind}"]`);
    buttons.forEach((button) => (button.disabled = true));
    try {
      const granted = await invoke<boolean>("request_permission", { kind });
      if (!granted) await invoke("open_privacy_settings", { kind });
      await refreshPermissionStatus();
    } catch (error) {
      showActionError(error);
    } finally {
      buttons.forEach((button) => (button.disabled = false));
    }
  }

  async function saveShortcut(shortcut: string): Promise<void> {
    recorder.disabled = true;
    try {
      applySettings(
        await invoke<SettingsResponse>("update_shortcut", { shortcut }),
      );
      setMessage("Shortcut updated.");
      window.setTimeout(() => {
        if (message.textContent === "Shortcut updated.") setMessage();
      }, 1_500);
    } catch (error) {
      if (settings) applySettings(settings);
      setMessage(String(error), "error");
    } finally {
      recorder.disabled = false;
    }
  }

  recorder.addEventListener("click", () => {
    recording = true;
    recorder.classList.add("recording");
    recorder.textContent = "Press shortcut";
    setMessage("Use Command, Control, Option, or Shift with another key.");
  });

  reset.addEventListener("click", () => void saveShortcut("Command+Semicolon"));

  toggle.addEventListener("change", async () => {
    toggle.disabled = true;
    try {
      applySettings(
        await invoke<SettingsResponse>("set_start_at_login", {
          enabled: toggle.checked,
        }),
      );
    } catch (error) {
      if (settings) applySettings(settings);
      setMessage(String(error), "error");
    } finally {
      toggle.disabled = false;
    }
  });

  app.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const disabledLicenseLink = target.closest<HTMLAnchorElement>("[data-license-link][aria-disabled='true']");
    if (disabledLicenseLink) {
      event.preventDefault();
      licenseGateStatus.textContent = "Purchasing will be available in the release build.";
      return;
    }
    if (target.closest(".login-settings-link")) {
      void invoke("open_login_items_settings");
      return;
    }
    const nav = target.closest<HTMLButtonElement>("[data-settings-view]");
    if (nav) {
      showSettingsView(nav.dataset.settingsView as SettingsView);
      return;
    }
    if (target.closest("[data-check-updates]")) {
      void checkForUpdates(true);
      return;
    }
    if (target.closest("[data-install-update]")) {
      void installAvailableUpdate();
      return;
    }
    const refreshLicenseButton = target.closest<HTMLButtonElement>("[data-refresh-license]");
    if (refreshLicenseButton) {
      refreshLicenseButton.disabled = true;
      setLicensePanelMessage("Checking license…");
      void refreshLicenseStatus(true)
        .then((next) => {
          if (next.canUseApp) {
            setLicensePanelMessage(next.message ?? "License is up to date.");
          }
        })
        .catch((error) => setLicensePanelMessage(String(error), true))
        .finally(() => (refreshLicenseButton.disabled = false));
      return;
    }
    if (target.closest("[data-request-deactivation]")) {
      deactivationConfirmation.hidden = false;
      app.querySelector<HTMLButtonElement>("[data-cancel-deactivation]")!.focus();
      return;
    }
    if (target.closest("[data-cancel-deactivation]")) {
      deactivationConfirmation.hidden = true;
      app.querySelector<HTMLButtonElement>("[data-request-deactivation]")!.focus();
      return;
    }
    const confirmDeactivationButton = target.closest<HTMLButtonElement>("[data-confirm-deactivation]");
    if (confirmDeactivationButton) {
      confirmDeactivationButton.disabled = true;
      setLicensePanelMessage("Deactivating…");
      void invoke<LicenseStatus>("deactivate_license")
        .then((next) => {
          applyLicenseStatus(next);
          licenseGateStatus.textContent = "License deactivated on this Mac.";
        })
        .catch((error) => {
          deactivationConfirmation.hidden = false;
          setLicensePanelMessage(String(error), true);
        })
        .finally(() => (confirmDeactivationButton.disabled = false));
      return;
    }
    // The selected theme also lives on <html data-appearance="…">. Keep
    // delegated clicks scoped to the picker buttons so a click elsewhere in
    // Settings cannot mistake the document root for an appearance control.
    const appearance = target.closest<HTMLButtonElement>("button[data-appearance]");
    if (appearance) {
      saveAppearance(appearance.dataset.appearance as Appearance);
      updateAppearanceControls();
      setMessage(
        appearance.dataset.appearance === "system"
          ? "Appearance now follows macOS."
          : `${appearance.textContent?.trim()} appearance selected.`,
      );
      return;
    }
    const permission = target.closest<HTMLButtonElement>("[data-open-permission]");
    if (permission) {
      void openPermission(permission.dataset.openPermission as "accessibility" | "screen");
      return;
    }
    if (target.closest("[data-recheck-permissions]")) {
      void refreshPermissionStatus();
      return;
    }
    if (target.closest("[data-run-onboarding]")) {
      permissionSettingsOpened = false;
      void invoke<SettingsResponse>("reset_onboarding")
        .then(applySettings)
        .catch(showActionError);
      return;
    }
    if (target.closest("[data-reveal-app]")) {
      void invoke("reveal_app_in_finder").catch(showActionError);
      return;
    }
    if (target.closest(".finish-onboarding")) {
      if (!permissionStatus?.accessibilityGranted) return;
      const button = target.closest<HTMLButtonElement>(".finish-onboarding")!;
      button.disabled = true;
      void invoke<SettingsResponse>("complete_onboarding")
        .then((next) => {
          applySettings(next);
          showSettingsView("general");
          hideSettingsWindow();
        })
        .catch(showActionError)
        .finally(() => (button.disabled = false));
    }
  });

  app.querySelector<HTMLElement>(".settings-sidebar")!.addEventListener(
    "keydown",
    (event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(keyboardEvent.key)) return;

      const tabs = Array.from(
        app.querySelectorAll<HTMLButtonElement>("[data-settings-view]"),
      ).filter((tab) => !tab.hidden);
      const currentIndex = tabs.indexOf(document.activeElement as HTMLButtonElement);
      if (currentIndex < 0) return;

      keyboardEvent.preventDefault();
      const nextIndex = keyboardEvent.key === "Home"
        ? 0
        : keyboardEvent.key === "End"
          ? tabs.length - 1
          : (currentIndex + (keyboardEvent.key === "ArrowDown" ? 1 : -1) + tabs.length) % tabs.length;
      tabs[nextIndex].click();
      tabs[nextIndex].focus();
    },
  );

  window.addEventListener("keydown", (event) => {
    if (recording) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        if (settings) applySettings(settings);
        return;
      }
      const shortcut = eventShortcut(event);
      if (shortcut) void saveShortcut(shortcut);
      return;
    }
    if (event.key === "Escape" || (event.metaKey && event.key === "w")) {
      event.preventDefault();
      if (event.key === "Escape" && !deactivationConfirmation.hidden) {
        deactivationConfirmation.hidden = true;
        app.querySelector<HTMLButtonElement>("[data-request-deactivation]")?.focus();
        return;
      }
      hideSettingsWindow();
    }
  });

  app.querySelector<HTMLButtonElement>(".settings-close")!.addEventListener(
    "click",
    hideSettingsWindow,
  );
  void currentWindow.onCloseRequested((event) => {
    event.preventDefault();
    hideSettingsWindow();
  });
  void currentWindow.listen("settings-opened", () => {
    applyAppearance();
    licenseInput.value = "";
    licenseGateError.textContent = "";
    void refreshAppState();
  });
  void currentWindow.listen<LicenseStatus>("license-status-changed", ({ payload }) => {
    applyLicenseStatus(payload);
    if (payload.canUseApp && !settingsResolved) void refreshSettings();
  });
  void currentWindow.listen<PermissionStatus>("permission-status-changed", ({ payload }) => {
    updatePermissionStatus(payload);
    if (settings) settings = { ...settings, ...payload };
  });
  updateAppearanceControls();
  await refreshAppState();
}

if (currentWindow.label === "settings") {
  void initSettings();
} else {

app.innerHTML = `
  <section class="palette" aria-label="Macnu menu search">
    <header class="search-row">
      <button
        class="search-leading"
        type="button"
        tabindex="-1"
        aria-label="Back to menu bar icons"
        disabled
      >
        <span class="search-icon"></span>
        <span class="back-icon">‹</span>
      </button>
      <input
        class="search-input"
        type="search"
        placeholder="Search menu bar icons…"
        autocomplete="off"
        spellcheck="false"
        aria-label="Search menu bar icons"
      />
      <span class="current-shortcut"><kbd>⌘</kbd><kbd>;</kbd></span>
    </header>
    <div class="divider"></div>
    <main class="results" role="listbox"></main>
    <footer>
      <span class="footer-navigation"><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
      <span class="footer-primary"><kbd>↵</kbd> open</span>
      <span class="footer-secondary"><kbd>tab</kbd> actions</span>
      <span><kbd>esc</kbd> close</span>
      <button class="settings-button">Settings</button>
      <button class="refresh">Refresh</button>
    </footer>
  </section>
`;

enableWindowDragging(".search-row");

const input = app.querySelector<HTMLInputElement>(".search-input")!;
const results = app.querySelector<HTMLElement>(".results")!;
const refresh = app.querySelector<HTMLButtonElement>(".refresh")!;
const shortcutDisplay = app.querySelector<HTMLElement>(".current-shortcut")!;
const searchRow = app.querySelector<HTMLElement>(".search-row")!;
const searchLeading = app.querySelector<HTMLButtonElement>(".search-leading")!;
const footerPrimary = app.querySelector<HTMLElement>(".footer-primary")!;
const footerSecondary = app.querySelector<HTMLElement>(".footer-secondary")!;

let response: MenuResponse | null = null;
let activeDisplayId: number | null = null;
let refreshing = false;
let queuedRefresh = false;
let queuedPermissionPrompt = false;
let queuedForceRefresh = false;
let selectedIndex = 0;
let permissionFlowStarted = false;
let accessibilityFlowStarted = false;
let blurDismissGeneration = 0;
let blurDismissArmed = false;
let pendingBlur = false;
let pointerSelectionArmed = false;
let lastArrowNavigationAt = 0;
let paletteTestMode = false;
let actionScope: MenuIcon | null = null;
let actionResponse: MenuActionsResponse | null = null;
let actionLoading = false;
let actionDiscoveryCount = 0;
let actionRunError: string | null = null;
const actionCache = new Map<
  string,
  { expiresAt: number; response: MenuActionsResponse }
>();
const ACTION_CACHE_LIFETIME = 45_000;

void invoke<boolean>("palette_test_mode")
  .then((enabled) => {
    paletteTestMode = enabled;
  })
  .catch(() => {});

window.addEventListener("macnu-palette-test-mode", () => {
  paletteTestMode = true;
});

function applyShortcutDisplay(shortcut: string): void {
  shortcutDisplay.innerHTML = shortcutMarkup(shortcut);
}

void invoke<SettingsResponse>("get_settings")
  .then((settings) => applyShortcutDisplay(settings.shortcut))
  .catch(() => {});
void currentWindow.listen<string>("shortcut-changed", ({ payload }) => {
  applyShortcutDisplay(payload);
});

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[character]!,
  );
}

function displayLabel(icon: MenuIcon): string {
  return icon.isMacnu ? "Macnu" : icon.label;
}

function visibleIcons(): MenuIcon[] {
  const query = input.value.trim().toLocaleLowerCase();
  const icons = response?.icons ?? [];
  if (!query) return icons;
  return icons.filter((icon) =>
    `${displayLabel(icon)} ${icon.owner}`.toLocaleLowerCase().includes(query),
  );
}
function actionCacheKey(icon: MenuIcon): string {
  return [
    icon.activationPid ?? "",
    icon.activationBundleId ?? "",
    icon.activationIdentifier ?? "",
    icon.activationX ?? icon.x,
    icon.activationY ?? icon.y,
    icon.activationWidth ?? icon.width,
    icon.activationHeight ?? icon.height,
  ].join("|");
}

function visibleActions(): MenuAction[] {
  const query = input.value.trim().toLocaleLowerCase();
  const actions = actionResponse?.actions ?? [];
  if (!query) return actions;
  return actions.filter((action) => {
    const path = action.path.map((segment) => segment.title).join(" ");
    return `${action.title} ${path}`.toLocaleLowerCase().includes(query);
  });
}

function actionContext(action: MenuAction): string {
  const parents = action.path.slice(0, -1).map((segment) => segment.title);
  return parents.length ? parents.join(" › ") : actionScope?.owner ?? "";
}

function updatePaletteChrome(): void {
  const scoped = actionScope !== null;
  searchRow.classList.toggle("actions-mode", scoped);
  searchLeading.disabled = !scoped;
  input.placeholder = scoped
    ? `Search ${displayLabel(actionScope!)} actions…`
    : "Search menu bar icons…";
  input.setAttribute(
    "aria-label",
    scoped ? `Search ${displayLabel(actionScope!)} actions` : "Search menu bar icons",
  );
  footerPrimary.innerHTML = scoped
    ? "<kbd>↵</kbd> run"
    : "<kbd>↵</kbd> open";
  footerSecondary.innerHTML = scoped
    ? "<kbd>←</kbd> back"
    : "<kbd>tab</kbd> actions";
  refresh.hidden = scoped;
}

function renderActions(): void {
  if (!actionScope) return;
  if (actionLoading) {
    results.innerHTML = `
      <div class="state fetching-state" role="status" aria-live="polite">
        <span class="loader" aria-hidden="true"></span>
        <strong>Reading ${escapeHtml(displayLabel(actionScope))} actions…</strong>
        <small>Looking for actions Macnu can show here.</small>
      </div>
    `;
    return;
  }

  const actionError = actionRunError ?? actionResponse?.error;
  if (actionError) {
    results.innerHTML = `
      <div class="state">
        <strong>${actionRunError ? "Couldn’t run this action" : "Couldn’t read these actions"}</strong>
        <small>${escapeHtml(actionError)}</small>
        <div class="state-actions">
          <button class="secondary-action retry-actions">Try again</button>
          <button class="secondary-action open-original">Open menu</button>
        </div>
      </div>
    `;
    return;
  }

  const actions = visibleActions();
  selectedIndex = Math.max(0, Math.min(selectedIndex, actions.length - 1));
  if (!actions.length) {
    const hasQuery = input.value.trim().length > 0;
    results.innerHTML = `
      <div class="state">
        <span class="empty-symbol">⌕</span>
        <strong>${hasQuery ? "No matching actions" : "Actions aren’t available here"}</strong>
        <small>${
          hasQuery
            ? "Try another search."
            : "You can still open and use this menu normally."
        }</small>
        ${
          hasQuery
            ? ""
            : '<button class="secondary-action open-original">Open menu</button>'
        }
      </div>
    `;
    return;
  }

  results.innerHTML = actions
    .map(
      (action, index) => `
        <button
          class="result action-result ${index === selectedIndex ? "selected" : ""} ${
            action.enabled ? "" : "disabled"
          }"
          data-index="${index}"
          role="option"
          aria-selected="${index === selectedIndex}"
          aria-disabled="${!action.enabled}"
        >
          <span class="icon-frame">
            <img src="${actionScope!.image}" alt="" draggable="false" />
          </span>
          <span class="result-copy">
            <strong>${escapeHtml(action.title)}</strong>
            <small>${escapeHtml(actionContext(action))}</small>
          </span>
          <span class="action-tail">${escapeHtml(action.shortcut ?? (action.enabled ? "↵" : "—"))}</span>
        </button>
      `,
    )
    .join("");
}

function render(): void {
  updatePaletteChrome();
  if (actionScope) {
    renderActions();
    return;
  }

  if (!response) {
    results.innerHTML = `
      <div class="state fetching-state" role="status" aria-live="polite">
        <span class="loader" aria-hidden="true"></span>
        <strong>Fetching menu bar icons…</strong>
        <small>Checking the active display for the latest names and icons.</small>
      </div>
    `;
    return;
  }

  if (response.accessibilityDenied) {
    results.innerHTML = `
      <div class="permission-state">
        <span class="permission-icon">⌘</span>
        <strong>Accessibility is required</strong>
        <p>Macnu needs it to read real item names and open their original menus.</p>
        <button class="primary-action accessibility-button">Open Accessibility Settings</button>
      </div>
    `;
    return;
  }

  // Screen Recording enriches high-confidence matches with the exact menu-bar
  // artwork. Accessibility remains the authoritative catalog and activation
  // route, so users can still search/open items with app or neutral icons when
  // capture permission is unavailable.
  if (response.screenCaptureDenied && response.icons.length === 0) {
    results.innerHTML = `
      <div class="permission-state">
        <span class="permission-icon">◉</span>
        <strong>Screen Recording improves icon previews</strong>
        <p>Enable Macnu in System Settings to show exact menu-bar artwork.</p>
        <button class="primary-action permission-button">Open System Settings</button>
      </div>
    `;
    return;
  }

  if (response.error) {
    results.innerHTML = `
      <div class="state">
        <strong>Couldn’t read the menu bar</strong>
        <small>${escapeHtml(response.error)}</small>
        <button class="secondary-action retry">Try again</button>
      </div>
    `;
    return;
  }

  const icons = visibleIcons();
  selectedIndex = Math.max(0, Math.min(selectedIndex, icons.length - 1));

  if (!icons.length) {
    results.innerHTML = `
      <div class="state">
        <span class="empty-symbol">⌕</span>
        <strong>No matching menu-bar icons</strong>
      </div>
    `;
    return;
  }

  results.innerHTML = icons
    .map(
      (icon, index) => `
        <button
          class="result ${index === selectedIndex ? "selected" : ""}"
          data-index="${index}"
          role="option"
          aria-selected="${index === selectedIndex}"
        >
          <span class="icon-frame">
            <img src="${icon.image}" alt="" draggable="false" />
          </span>
          <span class="result-copy">
            <strong>${escapeHtml(displayLabel(icon))}</strong>
            ${icon.isMacnu ? "" : `<small>${escapeHtml(icon.owner)}</small>`}
          </span>
          <span class="open-hint">↵</span>
        </button>
      `,
    )
    .join("");
}

render();

async function openScreenPermission(): Promise<void> {
  if (permissionFlowStarted) return;
  permissionFlowStarted = true;
  const granted = await invoke<boolean>("request_permission", { kind: "screen" });
  if (!granted) {
    await invoke("open_privacy_settings", { kind: "screen" });
  } else {
    await refreshIcons(true, true);
  }
}

async function openAccessibilityPermission(): Promise<void> {
  if (accessibilityFlowStarted) return;
  accessibilityFlowStarted = true;
  const granted = await invoke<boolean>("request_permission", {
    kind: "accessibility",
  });
  if (!granted) {
    await invoke("open_privacy_settings", { kind: "accessibility" });
  } else {
    await refreshIcons(true, true);
  }
}

function responsesEqual(
  left: MenuResponse | null,
  right: MenuResponse | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (
    left.displayId !== right.displayId ||
    left.screenCaptureDenied !== right.screenCaptureDenied ||
    left.accessibilityDenied !== right.accessibilityDenied ||
    left.error !== right.error ||
    left.icons.length !== right.icons.length
  ) {
    return false;
  }

  return left.icons.every((icon, index) => {
    const other = right.icons[index];
    return (
      icon.windowId === other.windowId &&
      icon.owner === other.owner &&
      icon.label === other.label &&
      icon.x === other.x &&
      icon.y === other.y &&
      icon.width === other.width &&
      icon.height === other.height &&
      icon.image === other.image &&
      icon.isMacnu === other.isMacnu &&
      icon.activationPid === other.activationPid &&
      icon.activationBundleId === other.activationBundleId &&
      icon.activationIdentifier === other.activationIdentifier &&
      icon.activationX === other.activationX &&
      icon.activationY === other.activationY &&
      icon.activationWidth === other.activationWidth &&
      icon.activationHeight === other.activationHeight &&
      icon.activationAction === other.activationAction
    );
  });
}

function applyResponse(next: MenuResponse | null): void {
  if (
    next &&
    activeDisplayId !== null &&
    next.displayId !== activeDisplayId
  ) {
    return;
  }
  if (responsesEqual(response, next)) return;
  response = next;
  render();
}

async function refreshIcons(
  promptPermissions = false,
  force = false,
): Promise<void> {
  if (force) actionCache.clear();
  if (refreshing) {
    queuedRefresh = true;
    queuedPermissionPrompt ||= promptPermissions;
    queuedForceRefresh ||= force;
    return;
  }
  refreshing = true;
  let next: MenuResponse | null = null;

  try {
    next = await invoke<MenuResponse>("list_menu_icons", { force });
    applyResponse(next);
  } catch (error) {
    next = {
      icons: [],
      displayId: activeDisplayId ?? 0,
      screenCaptureDenied: false,
      accessibilityDenied: false,
      error: String(error),
    };
    applyResponse(next);
  } finally {
    refreshing = false;
    if (promptPermissions && next?.accessibilityDenied) {
      window.setTimeout(() => void openAccessibilityPermission(), 200);
    } else if (promptPermissions && next?.screenCaptureDenied) {
      window.setTimeout(() => void openScreenPermission(), 200);
    }
    if (queuedRefresh) {
      const shouldPrompt = queuedPermissionPrompt;
      const shouldForce = queuedForceRefresh;
      queuedRefresh = false;
      queuedPermissionPrompt = false;
      queuedForceRefresh = false;
      void refreshIcons(shouldPrompt, shouldForce);
    }
  }
}

async function openPalette(generation: number): Promise<void> {
  selectedIndex = 0;

  try {
    const snapshot = await invoke<ActiveDisplayCache>(
      "active_display_menu_icons",
    );
    if (generation !== blurDismissGeneration) return;
    activeDisplayId = snapshot.displayId;
    if (snapshot.response && !snapshot.stale) {
      applyResponse(snapshot.response);
      updateSelection(0);
    } else {
      applyResponse(null);
      void refreshIcons(true);
    }
  } catch {
    if (generation !== blurDismissGeneration) return;
    applyResponse(null);
    void refreshIcons(true);
  }
}

function updateSelection(next: number): void {
  const itemCount = actionScope ? visibleActions().length : visibleIcons().length;
  if (!itemCount) return;
  selectedIndex = (next + itemCount) % itemCount;
  const items = results.querySelectorAll<HTMLElement>(".result");
  items.forEach((item, index) => {
    const selected = index === selectedIndex;
    item.classList.toggle("selected", selected);
    item.setAttribute("aria-selected", String(selected));
  });
  items[selectedIndex]?.scrollIntoView({
    block: "nearest",
  });
}
async function restorePaletteFocus(generation: number): Promise<void> {
  if (generation !== blurDismissGeneration) return;
  await currentWindow.show();
  await currentWindow.setFocus();
  window.setTimeout(() => {
    if (generation === blurDismissGeneration) input.focus();
  }, 20);
}

function leaveActionScope(): void {
  const previousScope = actionScope;
  actionScope = null;
  actionResponse = null;
  actionLoading = false;
  actionRunError = null;
  input.value = "";
  const icons = visibleIcons();
  selectedIndex = Math.max(
    0,
    previousScope
      ? icons.findIndex(
          (icon) => actionCacheKey(icon) === actionCacheKey(previousScope),
        )
      : 0,
  );
  render();
  window.setTimeout(() => input.focus(), 0);
}

async function openActionScope(
  icon: MenuIcon,
  force = false,
): Promise<void> {
  if (icon.isMacnu) {
    await invoke("open_settings");
    return;
  }

  actionScope = icon;
  actionResponse = null;
  actionRunError = null;
  actionLoading = true;
  input.value = "";
  selectedIndex = 0;
  pointerSelectionArmed = false;
  render();

  const key = actionCacheKey(icon);
  const cached = actionCache.get(key);
  if (!force && cached && cached.expiresAt > Date.now()) {
    actionResponse = cached.response;
    actionLoading = false;
    render();
    input.focus();
    return;
  }

  const generation = blurDismissGeneration;
  actionDiscoveryCount += 1;
  pendingBlur = false;
  try {
    const next = await invoke<MenuActionsResponse>("list_menu_actions", {
      icon,
    });
    if (generation !== blurDismissGeneration || actionScope !== icon) return;
    actionResponse = next;
    if (!next.error) {
      actionCache.set(key, {
        expiresAt: Date.now() + ACTION_CACHE_LIFETIME,
        response: next,
      });
    }
  } catch (error) {
    if (generation !== blurDismissGeneration || actionScope !== icon) return;
    actionResponse = {
      actions: [],
      error: String(error),
    };
  } finally {
    actionDiscoveryCount = Math.max(0, actionDiscoveryCount - 1);
    if (generation === blurDismissGeneration && actionScope === icon) {
      actionLoading = false;
      render();
      await restorePaletteFocus(generation);
    }
  }
}

async function activateScopedAction(action: MenuAction): Promise<void> {
  const icon = actionScope;
  if (!icon || !action.enabled) return;
  actionRunError = null;
  await currentWindow.hide();
  try {
    await invoke("activate_menu_action", { icon, action });
  } catch (error) {
    actionRunError = String(error);
    render();
    await restorePaletteFocus(blurDismissGeneration);
  }
}

async function activate(icon: MenuIcon): Promise<void> {
  await currentWindow.hide();
  try {
    await invoke("activate_menu_icon", { icon });
  } catch (error) {
    if (String(error).toLowerCase().includes("accessibility")) {
      await invoke<boolean>("request_permission", { kind: "accessibility" });
      await invoke("open_privacy_settings", { kind: "accessibility" });
    } else {
      console.error(error);
    }
  }
}

function activateSelected(): void {
  if (actionScope) {
    const action = visibleActions()[selectedIndex];
    if (action) void activateScopedAction(action);
    return;
  }
  const icon = visibleIcons()[selectedIndex];
  if (icon) void activate(icon);
}

input.addEventListener("input", () => {
  selectedIndex = 0;
  render();
});

window.addEventListener(
  "keydown",
  (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    blurDismissGeneration += 1;
    void currentWindow.hide();
  },
  { capture: true },
);

input.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    event.stopPropagation();
    const now = performance.now();
    if (event.repeat && now - lastArrowNavigationAt < 90) return;
    lastArrowNavigationAt = now;
    pointerSelectionArmed = false;
    updateSelection(selectedIndex + 1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    event.stopPropagation();
    const now = performance.now();
    if (event.repeat && now - lastArrowNavigationAt < 90) return;
    lastArrowNavigationAt = now;
    pointerSelectionArmed = false;
    updateSelection(selectedIndex - 1);
  } else if (
    actionScope &&
    (event.key === "ArrowLeft" ||
      (event.key === "Backspace" && input.value.length === 0))
  ) {
    event.preventDefault();
    event.stopPropagation();
    leaveActionScope();
  } else if (
    !actionScope &&
    (event.key === "ArrowRight" || event.key === "Tab")
  ) {
    event.preventDefault();
    event.stopPropagation();
    const icon = visibleIcons()[selectedIndex];
    if (icon && !actionLoading) void openActionScope(icon);
  } else if (actionScope && event.key === "Tab") {
    // Keep keyboard focus in the search field while action results are open.
    event.preventDefault();
    event.stopPropagation();
  } else if (event.key === "Enter") {
    event.preventDefault();
    event.stopPropagation();
    activateSelected();
  }
});

results.addEventListener("focusin", (event) => {
  const item = (event.target as HTMLElement).closest<HTMLButtonElement>(".result");
  if (!item) return;
  pointerSelectionArmed = false;
  updateSelection(Number(item.dataset.index));
});

results.addEventListener("mousemove", (event) => {
  if (!pointerSelectionArmed) {
    pointerSelectionArmed = true;
    return;
  }
  const item = (event.target as HTMLElement).closest<HTMLButtonElement>(".result");
  if (!item) return;
  const index = Number(item.dataset.index);
  if (index === selectedIndex) return;
  selectedIndex = index;
  const previous = results.querySelector(".result.selected");
  previous?.classList.remove("selected");
  previous?.setAttribute("aria-selected", "false");
  item.classList.add("selected");
  item.setAttribute("aria-selected", "true");
});

results.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const item = target.closest<HTMLButtonElement>(".result");
  if (item) {
    const index = Number(item.dataset.index);
    if (actionScope) {
      const action = visibleActions()[index];
      if (action) void activateScopedAction(action);
    } else {
      const icon = visibleIcons()[index];
      if (icon) void activate(icon);
    }
    return;
  }
  if (target.closest(".retry-actions") && actionScope) {
    void openActionScope(actionScope, true);
  }
  if (target.closest(".open-original") && actionScope) {
    void activate(actionScope);
  }
  if (target.closest(".permission-button")) {
    permissionFlowStarted = false;
    void openScreenPermission();
  }
  if (target.closest(".accessibility-button")) {
    accessibilityFlowStarted = false;
    void openAccessibilityPermission();
  }
  if (target.closest(".retry")) void refreshIcons(true, true);
});

refresh.addEventListener("click", () => void refreshIcons(true, true));
searchLeading.addEventListener("click", () => {
  if (actionScope) leaveActionScope();
});
app.querySelector<HTMLButtonElement>(".settings-button")!.addEventListener(
  "click",
  () => void invoke("open_settings"),
);

void currentWindow.listen("palette-opened", () => {
  applyAppearance();
  const generation = ++blurDismissGeneration;
  blurDismissArmed = false;
  pendingBlur = false;
  actionScope = null;
  actionResponse = null;
  actionLoading = false;
  actionRunError = null;
  input.value = "";
  selectedIndex = 0;
  pointerSelectionArmed = false;
  lastArrowNavigationAt = 0;
  activeDisplayId = null;
  applyResponse(null);
  window.setTimeout(() => input.focus(), 30);
  void openPalette(generation);

  window.setTimeout(() => {
    if (generation !== blurDismissGeneration) return;
    blurDismissArmed = true;
    if (!pendingBlur) return;

    void Promise.all([
      currentWindow.isVisible(),
      currentWindow.isFocused(),
    ]).then(([visible, focused]) => {
      if (
        generation === blurDismissGeneration &&
        visible &&
        !focused
      ) {
        void currentWindow.hide();
      }
    });
  }, 350);
});

void currentWindow.listen<MenuResponse>("menu-cache-updated", ({ payload }) => {
  applyResponse(payload);
});

// UI automation test mode keeps the palette inspectable while the test runner
// briefly becomes the frontmost process. Normal launches retain the
// click-away behavior below.
void currentWindow.listen("palette-test-mode", () => {
  paletteTestMode = true;
});

// CSS follows macOS immediately. A forced native refresh is also required
// because template menu-bar pixels invert with system appearance and must not
// be reused from the previous light/dark icon cache.
void currentWindow.onThemeChanged(() => {
  void refreshIcons(false, true);
});

void currentWindow.onFocusChanged(({ payload: focused }) => {
  if (focused) {
    pendingBlur = false;
    return;
  }
  if (paletteTestMode) return;
  if (actionDiscoveryCount > 0) return;
  if (!blurDismissArmed) {
    pendingBlur = true;
    return;
  }
  void currentWindow.hide();
});

}
