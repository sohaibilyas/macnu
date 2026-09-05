import { Channel, invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type RankingMode,
} from "./personalization";
import {
  itemShortcutErrorKeyAction,
  isPinShortcut,
  paletteResultLabel,
  pinnedFirstWhenIdle,
  pointerPositionChanged,
  type PointerPosition,
} from "./palette-behavior";
import {
  buildPaletteResults,
  type PaletteResult,
  type SavedActionView,
} from "./instant-commands";
import { friendlyPinActionError } from "./saved-command-errors";
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
  itemId?: string | null;
  displayKey?: string | null;
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
  displayKey: string;
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
  rankingMode: RankingMode;
  personalizePerDisplay: boolean;
};

type ItemCustomization = {
  alias: string | null;
  shortcut: string | null;
  favorite: boolean;
  usageCount: number;
  lastUsedAt: number | null;
  hidden: boolean;
};

type CatalogCustomizationsResponse = {
  rankingMode: RankingMode;
  personalizePerDisplay: boolean;
  displayKey: string;
  items: Record<string, ItemCustomization | undefined>;
  savedActions: Record<string, SavedActionView | undefined>;
};

type PaletteMenuIcon = MenuIcon & {
  alias: string | null;
  hidden: boolean;
  favorite: boolean;
  usageCount: number;
  lastUsedAt: number | null;
  nativeOrder: number;
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
type SettingsView =
  | "general"
  | "personalization"
  | "permissions"
  | "updates"
  | "license";

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
    .map((part) => `<kbd>${escapeHtml(part)}</kbd>`)
    .join("");
}


function bookmarkIconMarkup(): string {
  return `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4.25 2.25h7.5v11L8 10.85l-3.75 2.4v-11Z"></path></svg>`;
}
function footerKeyGroup(key: string, label: string): string {
  return `<span class="footer-key-group"><kbd>${escapeHtml(key)}</kbd><span class="footer-key-label">${escapeHtml(label)}</span></span>`;
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
              tabindex="0"
            >
              <span aria-hidden="true">⌘</span>
              General
            </button>
            <button
              class="settings-nav"
              data-settings-view="personalization"
              role="tab"
              aria-controls="personalization-panel"
              aria-selected="false"
              tabindex="-1"
            >
              <span aria-hidden="true">★</span>
              Personalization
            </button>
            <button
              class="settings-nav"
              data-settings-view="permissions"
              role="tab"
              aria-controls="permissions-panel"
              aria-selected="false"
              tabindex="-1"
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
              tabindex="-1"
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
              tabindex="-1"
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
              id="personalization-panel"
              data-settings-panel="personalization"
              role="tabpanel"
              hidden
            >
              <div class="settings-copy">
                <h1>Personalization</h1>
                <p>Put the menu-bar items you need most within easy reach.</p>
              </div>
              <section class="settings-group personalization-settings-group">
                <div class="setting-row compact-setting-row">
                  <div class="setting-label">
                    <strong>Search order</strong>
                    <small>Smart orders the empty palette from the items you open.</small>
                  </div>
                  <div class="appearance-picker personalization-ranking" role="group" aria-label="Search order">
                    <button data-ranking-mode="smart" aria-pressed="true">Smart</button>
                    <button data-ranking-mode="menuBar" aria-pressed="false">Menu bar</button>
                    <button data-ranking-mode="alphabetical" aria-pressed="false">A–Z</button>
                  </div>
                </div>
                <div class="setting-row compact-setting-row">
                  <div class="setting-label">
                    <strong>Learn per display</strong>
                    <small>Keep pins and smart ordering separate on each display.</small>
                  </div>
                  <label class="switch">
                    <input class="display-learning-toggle" type="checkbox" aria-label="Learn separately on each display" />
                    <span></span>
                  </label>
                </div>
                <div class="setting-row compact-setting-row personalization-reset-row">
                  <div class="setting-label">
                    <strong>Smart ordering history</strong>
                    <small>Clear usage history without removing pins, aliases, or shortcuts.</small>
                  </div>
                  <button class="secondary-action personalization-reset" data-reset-personalization-history>Reset History</button>
                </div>
                <div class="setting-row compact-setting-row personalization-shortcuts-row">
                  <div class="setting-label">
                    <strong>Direct shortcuts</strong>
                    <small>Remove shortcuts from menu items and pinned actions. Pins and aliases stay unchanged.</small>
                  </div>
                  <button class="secondary-action personalization-clear-shortcuts" data-clear-all-item-shortcuts>Clear All</button>
                </div>
              </section>
              <section class="settings-group personalization-manager-group" aria-labelledby="instant-commands-heading">
                <div class="personalization-manager-heading">
                  <div class="setting-label">
                    <strong id="instant-commands-heading">Pinned actions</strong>
                    <small>Actions pinned inside their app’s Actions view.</small>
                  </div>
                </div>
                <div class="personalization-manager-list" data-saved-actions-manager>
                  <div class="personalization-manager-empty">Open this panel to load pinned actions.</div>
                </div>
              </section>
              <section class="settings-group personalization-manager-group" aria-labelledby="hidden-items-heading">
                <div class="personalization-manager-heading">
                  <div class="setting-label">
                    <strong id="hidden-items-heading">Hidden from search</strong>
                    <small>Items hidden from the main Macnu results on this Mac.</small>
                  </div>
                  <button class="secondary-action" type="button" data-restore-all-hidden hidden>Restore All</button>
                </div>
                <div class="personalization-manager-list" data-hidden-items-manager>
                  <div class="personalization-manager-empty">Open this panel to load hidden items.</div>
                </div>
              </section>
              <p class="personalization-help">Tip: pin menu-bar icons directly from search. Use ••• for aliases, shortcuts, visibility, and per-display pin settings.</p>
              <div class="personalization-status" data-personalization-status role="status" aria-live="polite"></div>
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
                <span class="update-state-mark" aria-hidden="true">
                  <span class="update-state-glyph" data-update-mark>↻</span>
                </span>
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
  const displayLearningToggle =
    app.querySelector<HTMLInputElement>(".display-learning-toggle")!;
  const personalizationStatus =
    app.querySelector<HTMLElement>("[data-personalization-status]")!;
  const personalizationResetButton =
    app.querySelector<HTMLButtonElement>("[data-reset-personalization-history]")!;
  const personalizationClearShortcutsButton =
    app.querySelector<HTMLButtonElement>("[data-clear-all-item-shortcuts]")!;
  const rankingButtons = Array.from(
    app.querySelectorAll<HTMLButtonElement>("[data-ranking-mode]"),
  );
  const savedActionsManager =
    app.querySelector<HTMLElement>("[data-saved-actions-manager]")!;
  const hiddenItemsManager =
    app.querySelector<HTMLElement>("[data-hidden-items-manager]")!;
  const restoreAllHiddenButton =
    app.querySelector<HTMLButtonElement>("[data-restore-all-hidden]")!;
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
  let clearItemShortcutsArmed = false;
  let personalizationCatalog: CatalogCustomizationsResponse | null = null;
  let personalizationIcons: MenuIcon[] = [];
  let personalizationManagersLoading = false;
  let personalizationManagerRequest = 0;
  let pendingSettingsSavedActionRemoval: string | null = null;
  let settingsSavedActionRemovalBusy: string | null = null;

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

  function renderPersonalizationManagers(): void {
    if (personalizationManagersLoading) {
      if (!settingsSavedActionRemovalBusy) pendingSettingsSavedActionRemoval = null;
      savedActionsManager.innerHTML =
        '<div class="personalization-manager-empty">Loading pinned actions…</div>';
      hiddenItemsManager.innerHTML =
        '<div class="personalization-manager-empty">Loading hidden items…</div>';
      restoreAllHiddenButton.hidden = true;
      return;
    }

    if (
      pendingSettingsSavedActionRemoval &&
      !personalizationCatalog?.savedActions[pendingSettingsSavedActionRemoval]
    ) {
      pendingSettingsSavedActionRemoval = null;
    }
    const savedActions = Object.values(personalizationCatalog?.savedActions ?? {})
      .filter((action): action is SavedActionView => Boolean(action))
      .sort((left, right) =>
        (left.alias?.trim() || left.action.title).localeCompare(
          right.alias?.trim() || right.action.title,
          undefined,
          { sensitivity: "base" },
        ),
      );
    savedActionsManager.innerHTML = savedActions.length
      ? savedActions
          .map((action) => {
            const label = action.alias?.trim() || action.action.title;
            const confirmingRemoval =
              pendingSettingsSavedActionRemoval === action.id &&
              Boolean(action.shortcut);
            const removalBusy = settingsSavedActionRemovalBusy === action.id;
            const context = [action.parentLabel, action.owner]
              .filter((value, index, values) =>
                value.trim() && values.indexOf(value) === index && value !== label,
              )
              .join(" · ");
            return `
              <div class="personalization-manager-row">
                <span class="personalization-manager-copy">
                  <strong>${escapeHtml(label)}</strong>
                  <small>${escapeHtml(context)}</small>
                </span>
                ${
                  confirmingRemoval
                    ? `
                      <span class="manager-removal-warning" role="alert">
                        Unpin this action and remove its ${shortcutMarkup(action.shortcut!)} shortcut?
                      </span>
                      <span class="manager-confirm-actions">
                        <button
                          type="button"
                          class="secondary-action"
                          data-settings-cancel-remove-action="${escapeHtml(action.id)}"
                          ${removalBusy ? "disabled" : ""}
                        >Keep</button>
                        <button
                          type="button"
                          class="danger-action"
                          data-settings-confirm-remove-action="${escapeHtml(action.id)}"
                          ${removalBusy ? "disabled" : ""}
                        >${removalBusy ? "Unpinning…" : "Unpin"}</button>
                      </span>
                    `
                    : action.shortcut
                    ? `<span class="manager-shortcut" aria-label="Shortcut ${escapeHtml(action.shortcut)}">${shortcutMarkup(action.shortcut)}</span>`
                    : ""
                }
                ${
                  confirmingRemoval
                    ? ""
                    : `
                      <button
                        type="button"
                        class="secondary-action manager-row-action"
                        data-settings-remove-action="${escapeHtml(action.id)}"
                        aria-label="Unpin action ${escapeHtml(label)}"
                      >Unpin</button>
                    `
                }
              </div>
            `;
          })
          .join("")
      : '<div class="personalization-manager-empty">No pinned actions yet. Pin one from an app’s Actions view.</div>';

    const liveById = new Map(
      personalizationIcons.flatMap((icon) => {
        const itemId = !icon.isMacnu && typeof icon.itemId === "string"
          ? icon.itemId.trim()
          : "";
        return itemId ? [[itemId, icon] as const] : [];
      }),
    );
    const hiddenItems = Object.entries(personalizationCatalog?.items ?? {})
      .flatMap(([itemId, customization]) => {
        const icon = liveById.get(itemId);
        return customization?.hidden && icon ? [{ itemId, customization, icon }] : [];
      })
      .sort((left, right) =>
        (left.customization.alias?.trim() || left.icon.label).localeCompare(
          right.customization.alias?.trim() || right.icon.label,
          undefined,
          { sensitivity: "base" },
        ),
      );
    const hiddenCustomizationCount = Object.values(
      personalizationCatalog?.items ?? {},
    ).filter((customization) => customization?.hidden).length;
    restoreAllHiddenButton.hidden = hiddenCustomizationCount === 0;
    hiddenItemsManager.innerHTML = hiddenItems.length
      ? hiddenItems
          .map(({ itemId, customization, icon }) => {
            const label = customization.alias?.trim() || icon.label;
            return `
              <div class="personalization-manager-row">
                <span class="personalization-manager-copy">
                  <strong>${escapeHtml(label)}</strong>
                  <small>${escapeHtml(icon.owner)}</small>
                </span>
                <button
                  type="button"
                  class="secondary-action manager-row-action"
                  data-settings-unhide-item="${escapeHtml(itemId)}"
                  aria-label="Show ${escapeHtml(label)} in search"
                >Show</button>
              </div>
            `;
          })
          .join("")
      : hiddenCustomizationCount > 0
        ? '<div class="personalization-manager-empty">Hidden items aren’t available right now. Restore All will show them the next time they appear.</div>'
        : '<div class="personalization-manager-empty">No items are hidden.</div>';
  }

  async function refreshPersonalizationManagers(): Promise<void> {
    const request = ++personalizationManagerRequest;
    if (!settingsSavedActionRemovalBusy) pendingSettingsSavedActionRemoval = null;
    personalizationManagersLoading = true;
    renderPersonalizationManagers();
    try {
      const menu = await invoke<MenuResponse>("list_menu_icons", { force: false });
      const catalog = await invoke<CatalogCustomizationsResponse>(
        "get_catalog_customizations",
        { displayKey: menu.displayKey },
      );
      if (request !== personalizationManagerRequest) return;
      personalizationIcons = menu.icons;
      personalizationCatalog = catalog;
      personalizationStatus.textContent = "";
    } catch (error) {
      if (request !== personalizationManagerRequest) return;
      personalizationStatus.textContent = String(error);
    } finally {
      if (request === personalizationManagerRequest) {
        personalizationManagersLoading = false;
        renderPersonalizationManagers();
      }
    }
  }

  function showSettingsView(view: SettingsView): void {
    resetClearItemShortcutsConfirmation();
    app.querySelectorAll<HTMLButtonElement>("[data-settings-view]").forEach((button) => {
      const selected = button.dataset.settingsView === view;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    app.querySelectorAll<HTMLElement>("[data-settings-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.settingsPanel !== view;
    });
    if (view === "personalization") {
      void refreshPersonalizationManagers();
    }
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
    displayLearningToggle.checked = next.personalizePerDisplay;
    rankingButtons.forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.rankingMode === next.rankingMode));
    });
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

  function resetClearItemShortcutsConfirmation(): void {
    const wasArmed = clearItemShortcutsArmed;
    clearItemShortcutsArmed = false;
    personalizationClearShortcutsButton.textContent = "Clear All";
    personalizationClearShortcutsButton.classList.remove("armed");
    if (wasArmed) personalizationStatus.textContent = "";
  }

  function setPersonalizationBusy(busy: boolean): void {
    displayLearningToggle.disabled = busy;
    personalizationResetButton.disabled = busy;
    personalizationClearShortcutsButton.disabled = busy;
    rankingButtons.forEach((button) => (button.disabled = busy));
  }

  async function savePersonalizationSettings(
    rankingMode: RankingMode,
    personalizePerDisplay: boolean,
  ): Promise<void> {
    setPersonalizationBusy(true);
    personalizationStatus.textContent = "Saving…";
    try {
      applySettings(
        await invoke<SettingsResponse>("update_personalization_settings", {
          rankingMode,
          personalizePerDisplay,
        }),
      );
      personalizationStatus.textContent = "Saved locally on this Mac.";
    } catch (error) {
      if (settings) applySettings(settings);
      personalizationStatus.textContent = String(error);
    } finally {
      setPersonalizationBusy(false);
    }
  }

  displayLearningToggle.addEventListener("change", () => {
    const rankingMode = settings?.rankingMode ?? "smart";
    void savePersonalizationSettings(rankingMode, displayLearningToggle.checked);
  });

  function focusSettingsRemovalControl(
    savedActionId: string,
    confirmation = false,
  ): void {
    window.setTimeout(() => {
      const selector = confirmation
        ? "[data-settings-cancel-remove-action]"
        : "[data-settings-remove-action]";
      Array.from(savedActionsManager.querySelectorAll<HTMLButtonElement>(selector))
        .find((button) =>
          confirmation
            ? button.dataset.settingsCancelRemoveAction === savedActionId
            : button.dataset.settingsRemoveAction === savedActionId,
        )
        ?.focus();
    });
  }

  async function removeSettingsSavedAction(
    savedActionId: string,
    trigger: HTMLButtonElement,
  ): Promise<void> {
    const catalog = personalizationCatalog;
    const savedAction = catalog?.savedActions[savedActionId];
    if (!catalog || !savedAction || settingsSavedActionRemovalBusy) return;
    settingsSavedActionRemovalBusy = savedActionId;
    if (savedAction.shortcut) {
      pendingSettingsSavedActionRemoval = savedActionId;
      renderPersonalizationManagers();
    } else {
      trigger.disabled = true;
    }
    personalizationStatus.textContent = "Unpinning action…";
    try {
      const next = await invoke<CatalogCustomizationsResponse>(
        "remove_saved_action",
        {
          displayKey: catalog.displayKey,
          savedActionId,
        },
      );
      if (personalizationCatalog?.displayKey !== catalog.displayKey) return;
      settingsSavedActionRemovalBusy = null;
      pendingSettingsSavedActionRemoval = null;
      personalizationCatalog = next;
      personalizationStatus.textContent = "Action unpinned.";
      renderPersonalizationManagers();
    } catch (error) {
      if (personalizationCatalog?.displayKey !== catalog.displayKey) return;
      settingsSavedActionRemovalBusy = null;
      pendingSettingsSavedActionRemoval = null;
      personalizationStatus.textContent =
        "Macnu couldn’t unpin that action. Nothing was changed; please try again.";
      console.error("Could not unpin action from Settings.", error);
      renderPersonalizationManagers();
      focusSettingsRemovalControl(savedActionId);
    } finally {
      if (settingsSavedActionRemovalBusy === savedActionId) {
        settingsSavedActionRemovalBusy = null;
      }
    }
  }

  app.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (clearItemShortcutsArmed && !target.closest("[data-clear-all-item-shortcuts]")) {
      resetClearItemShortcutsConfirmation();
    }
    if (
      !settingsSavedActionRemovalBusy &&
      pendingSettingsSavedActionRemoval &&
      !target.closest(
        "[data-settings-remove-action], [data-settings-confirm-remove-action], [data-settings-cancel-remove-action]",
      )
    ) {
      pendingSettingsSavedActionRemoval = null;
      renderPersonalizationManagers();
    }
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
    const ranking = target.closest<HTMLButtonElement>("[data-ranking-mode]");
    if (ranking) {
      void savePersonalizationSettings(
        ranking.dataset.rankingMode as RankingMode,
        settings?.personalizePerDisplay ?? true,
      );
      return;
    }
    const cancelSavedActionRemoval = target.closest<HTMLButtonElement>(
      "[data-settings-cancel-remove-action]",
    );
    if (cancelSavedActionRemoval) {
      if (settingsSavedActionRemovalBusy) return;
      const savedActionId =
        cancelSavedActionRemoval.dataset.settingsCancelRemoveAction;
      pendingSettingsSavedActionRemoval = null;
      personalizationStatus.textContent = "Pinned action kept.";
      renderPersonalizationManagers();
      if (savedActionId) focusSettingsRemovalControl(savedActionId);
      return;
    }
    const confirmSavedActionRemoval = target.closest<HTMLButtonElement>(
      "[data-settings-confirm-remove-action]",
    );
    if (confirmSavedActionRemoval && personalizationCatalog) {
      if (settingsSavedActionRemovalBusy) return;
      const savedActionId =
        confirmSavedActionRemoval.dataset.settingsConfirmRemoveAction;
      if (!savedActionId) return;
      void removeSettingsSavedAction(savedActionId, confirmSavedActionRemoval);
      return;
    }
    const removeSavedActionButton = target.closest<HTMLButtonElement>(
      "[data-settings-remove-action]",
    );
    if (removeSavedActionButton && personalizationCatalog) {
      const savedActionId = removeSavedActionButton.dataset.settingsRemoveAction;
      if (!savedActionId) return;
      const savedAction = personalizationCatalog.savedActions[savedActionId];
      if (!savedAction) return;
      if (savedAction.shortcut) {
        pendingSettingsSavedActionRemoval = savedActionId;
        personalizationStatus.textContent =
          "Confirm removal. Its direct shortcut will be removed too.";
        renderPersonalizationManagers();
        focusSettingsRemovalControl(savedActionId, true);
      } else {
        void removeSettingsSavedAction(savedActionId, removeSavedActionButton);
      }
      return;
    }
    const unhideItemButton = target.closest<HTMLButtonElement>(
      "[data-settings-unhide-item]",
    );
    if (unhideItemButton && personalizationCatalog) {
      const itemId = unhideItemButton.dataset.settingsUnhideItem;
      const current = itemId ? personalizationCatalog.items[itemId] : undefined;
      if (!itemId || !current) return;
      unhideItemButton.disabled = true;
      personalizationStatus.textContent = "Restoring item…";
      void invoke<CatalogCustomizationsResponse>("set_item_customization", {
        displayKey: personalizationCatalog.displayKey,
        itemId,
        alias: current.alias,
        favorite: current.favorite,
        shortcut: current.shortcut,
        hidden: false,
      })
        .then((next) => {
          personalizationCatalog = next;
          personalizationStatus.textContent = "Item restored to search.";
          renderPersonalizationManagers();
        })
        .catch((error) => {
          personalizationStatus.textContent = String(error);
          unhideItemButton.disabled = false;
        });
      return;
    }
    if (target.closest("[data-restore-all-hidden]")) {
      restoreAllHiddenButton.disabled = true;
      personalizationStatus.textContent = "Restoring hidden items…";
      void invoke<number>("clear_hidden_items")
        .then(async (restored) => {
          await refreshPersonalizationManagers();
          personalizationStatus.textContent = restored === 0
            ? "No hidden items needed restoring."
            : restored === 1
              ? "1 item restored to search."
              : `${restored} items restored to search.`;
        })
        .catch((error) => {
          personalizationStatus.textContent = String(error);
        })
        .finally(() => {
          restoreAllHiddenButton.disabled = false;
        });
      return;
    }
    if (target.closest("[data-reset-personalization-history]")) {
      setPersonalizationBusy(true);
      personalizationStatus.textContent = "Clearing smart ordering history…";
      void invoke("reset_personalization_history")
        .then(() => {
          personalizationStatus.textContent =
            "History cleared. Pins, aliases, and shortcuts were kept.";
        })
        .catch((error) => {
          personalizationStatus.textContent = String(error);
        })
        .finally(() => setPersonalizationBusy(false));
      return;
    }
    if (target.closest("[data-clear-all-item-shortcuts]")) {
      if (!clearItemShortcutsArmed) {
        clearItemShortcutsArmed = true;
        personalizationClearShortcutsButton.textContent = "Confirm Clear All";
        personalizationClearShortcutsButton.classList.add("armed");
        personalizationStatus.textContent =
          "Click Confirm Clear All to remove every direct shortcut.";
        return;
      }

      resetClearItemShortcutsConfirmation();
      setPersonalizationBusy(true);
      personalizationStatus.textContent = "Removing direct shortcuts…";
      void invoke<number>("clear_all_item_shortcuts")
        .then(async (cleared) => {
          await refreshPersonalizationManagers();
          personalizationStatus.textContent = cleared === 0
            ? "No direct shortcuts were set."
            : cleared === 1
              ? "1 direct shortcut was removed. Saved items and aliases were kept."
              : `${cleared} direct shortcuts were removed. Saved items and aliases were kept.`;
        })
        .catch((error) => {
          personalizationStatus.textContent = String(error);
        })
        .finally(() => setPersonalizationBusy(false));
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
    if (event.key === "Escape" || (event.metaKey && event.key === "w")) {
      resetClearItemShortcutsConfirmation();
    }
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
    () => {
      resetClearItemShortcutsConfirmation();
      hideSettingsWindow();
    },
  );
  void currentWindow.onCloseRequested((event) => {
    event.preventDefault();
    resetClearItemShortcutsConfirmation();
    hideSettingsWindow();
  });
  void currentWindow.listen("settings-opened", () => {
    applyAppearance();
    resetClearItemShortcutsConfirmation();
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
  void currentWindow.listen<SettingsResponse>(
    "personalization-settings-changed",
    ({ payload }) => applySettings(payload),
  );
  void currentWindow.listen<CatalogCustomizationsResponse>(
    "catalog-customizations-changed",
    ({ payload }) => {
      if (payload.displayKey === personalizationCatalog?.displayKey) {
        personalizationCatalog = payload;
        renderPersonalizationManagers();
      } else if (
        app.querySelector("[data-settings-view='personalization'].selected")
      ) {
        void refreshPersonalizationManagers();
      }
    },
  );
  void currentWindow.listen("catalog-customizations-invalidated", () => {
    void refreshPersonalizationManagers();
  });
  void currentWindow.listen("personalization-history-reset", () => {
    personalizationStatus.textContent =
      "History cleared. Pins, aliases, and shortcuts were kept.";
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
    <main class="results"></main>
    <div class="visually-hidden" data-selection-announcer role="status" aria-live="polite" aria-atomic="true"></div>
    <footer>
      <span class="footer-navigation footer-key-group"><span class="footer-key-cluster"><kbd>↑</kbd><kbd>↓</kbd></span><span class="footer-key-label">navigate</span></span>
      <span class="footer-primary footer-key-group"><kbd>↵</kbd><span class="footer-key-label">open</span></span>
      <span class="footer-secondary footer-key-groups">${footerKeyGroup("tab", "actions")}</span>
      <span class="footer-close footer-key-group"><kbd>esc</kbd><span class="footer-key-label">close</span></span>
      <button class="settings-button">Settings</button>
      <button class="refresh">Refresh</button>
    </footer>
  </section>
`;

enableWindowDragging(".search-row");

const input = app.querySelector<HTMLInputElement>(".search-input")!;
const results = app.querySelector<HTMLElement>(".results")!;
const selectionAnnouncer =
  app.querySelector<HTMLElement>("[data-selection-announcer]")!;
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
let lastPointerPosition: PointerPosition | null = null;
let lastArrowNavigationAt = 0;
let paletteTestMode = false;
let actionScope: MenuIcon | null = null;
let actionResponse: MenuActionsResponse | null = null;
let actionLoading = false;
let actionDiscoveryCount = 0;
let actionRunError: string | null = null;
let actionPinError: string | null = null;
let actionPinSaving = false;
let itemPinSavingId: string | null = null;
let itemPinError: string | null = null;
let pendingActionUnpinId: string | null = null;
let paletteRankingMode: RankingMode = "smart";
let palettePersonalizePerDisplay = true;
let customizations: CatalogCustomizationsResponse | null = null;
let customizationRequest = 0;
let rankingNow = Date.now();
let selectedItemIdentity: string | null = null;
let customizationDraft: {
  session: number;
  displayKey: string;
  itemId: string;
  alias: string;
  favorite: boolean;
  shortcut: string;
  hidden: boolean;
} | null = null;
let customizationEditSession = 0;
let itemShortcutRecording = false;
let customizationMessage = "";
let customizationSaving = false;
let itemShortcutError: string | null = null;
let savedActionDraft: {
  session: number;
  displayKey: string;
  savedActionId: string;
  alias: string;
  shortcut: string;
} | null = null;
let savedActionEditSession = 0;
let savedActionShortcutRecording = false;
let savedActionSaving = false;
let savedActionMessage = "";
let savedActionError: string | null = null;
let savedActionErrorTitle = "That pinned action isn’t available right now";
let savedActionErrorTarget: SavedActionView | null = null;
let savedActionErrorOpenSettings = false;
let savedActionErrorOpeningSettings = false;
let savedActionRemoveArmed = false;
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
  .then((settings) => {
    applyShortcutDisplay(settings.shortcut);
    paletteRankingMode = settings.rankingMode;
    palettePersonalizePerDisplay = settings.personalizePerDisplay;
    render();
  })
  .catch(() => {});
void currentWindow.listen<string>("shortcut-changed", ({ payload }) => {
  applyShortcutDisplay(payload);
});

const DIRECT_SHORTCUT_ITEM_PREFIX = "v1.item-identifier.";

function stableItemId(icon: MenuIcon): string | null {
  if (icon.isMacnu || typeof icon.itemId !== "string") return null;
  const itemId = icon.itemId.trim();
  return itemId ? itemId : null;
}

function supportsDirectShortcut(itemId: string): boolean {
  return (
    itemId.startsWith(DIRECT_SHORTCUT_ITEM_PREFIX) &&
    itemId.length > DIRECT_SHORTCUT_ITEM_PREFIX.length
  );
}

function responseContainsItem(
  current: MenuResponse | null,
  itemId: string,
): boolean {
  return Boolean(
    current &&
    current.icons.some(
      (icon) => stableItemId(icon) === itemId,
    ),
  );
}

function resetCustomizationState(): void {
  customizationEditSession += 1;
  customizationDraft = null;
  itemShortcutRecording = false;
  customizationMessage = "";
  customizationSaving = false;
  savedActionEditSession += 1;
  savedActionDraft = null;
  savedActionShortcutRecording = false;
  savedActionSaving = false;
  savedActionMessage = "";
  savedActionRemoveArmed = false;
}

function iconIdentity(icon: MenuIcon): string {
  return stableItemId(icon) ?? [
    "session",
    icon.owner,
    icon.label,
    actionCacheKey(icon),
  ].join("|");
}

function customizationFor(icon: MenuIcon): ItemCustomization | undefined {
  const itemId = stableItemId(icon);
  if (
    !itemId ||
    !customizations ||
    customizations.displayKey !== response?.displayKey
  ) {
    return undefined;
  }
  return customizations.items[itemId];
}

function displayLabel(icon: MenuIcon): string {
  if (icon.isMacnu) return "Macnu";
  return customizationFor(icon)?.alias?.trim() || icon.label;
}

function paletteLiveItems(): PaletteMenuIcon[] {
  const catalogReady = customizations?.displayKey === response?.displayKey;
  return (response?.icons ?? []).map((icon, nativeOrder) => {
    const customization = catalogReady ? customizationFor(icon) : undefined;
    return {
      ...icon,
      alias: customization?.alias ?? null,
      hidden: icon.isMacnu ? false : customization?.hidden ?? false,
      favorite: customization?.favorite ?? false,
      usageCount: customization?.usageCount ?? 0,
      lastUsedAt: customization?.lastUsedAt ?? null,
      nativeOrder,
    };
  });
}

function visiblePaletteResults(): PaletteResult<PaletteMenuIcon>[] {
  const activeCatalog = customizations?.displayKey === response?.displayKey
    ? customizations
    : null;
  return buildPaletteResults(
    paletteLiveItems(),
    activeCatalog?.savedActions ?? {},
    {
      query: input.value,
      mode: activeCatalog?.rankingMode ?? paletteRankingMode,
      now: rankingNow,
    },
  );
}

function selectedPaletteResult(): PaletteResult<PaletteMenuIcon> | null {
  return visiblePaletteResults()[selectedIndex] ?? null;
}

function resultParent(result: PaletteResult<PaletteMenuIcon>): MenuIcon {
  return result.kind === "item" ? result.item : result.parent;
}

function savedActionFor(action: MenuAction): SavedActionView | null {
  const parentItemId = actionScope ? stableItemId(actionScope) : null;
  if (!parentItemId || !customizations) return null;
  return Object.values(customizations.savedActions).find(
    (saved): saved is SavedActionView =>
      Boolean(
        saved &&
          saved.parentItemId === parentItemId &&
          saved.action.id === action.id,
      ),
  ) ?? null;
}

function preserveSelectedIdentity(): void {
  if (actionScope) return;
  const selected = visiblePaletteResults()[selectedIndex];
  if (selected) selectedItemIdentity = selected.id;
}

function renderPreservingScroll(): void {
  const scrollTop = results.scrollTop;
  render();
  results.scrollTop = scrollTop;
}

function applyCustomizations(
  next: CatalogCustomizationsResponse,
  preferredSelection: string | null = null,
): void {
  if (!response || next.displayKey !== response.displayKey) return;
  preserveSelectedIdentity();
  if (preferredSelection) selectedItemIdentity = preferredSelection;
  customizations = next;
  paletteRankingMode = next.rankingMode;
  palettePersonalizePerDisplay = next.personalizePerDisplay;
  rankingNow = Date.now();
  renderPreservingScroll();
}

async function loadCustomizations(displayKey: string): Promise<void> {
  if (!displayKey) {
    customizations = null;
    render();
    return;
  }
  const request = ++customizationRequest;
  try {
    const next = await invoke<CatalogCustomizationsResponse>(
      "get_catalog_customizations",
      { displayKey },
    );
    if (request !== customizationRequest) return;
    applyCustomizations(next);
  } catch (error) {
    if (request !== customizationRequest) return;
    customizations = null;
    console.error("Could not load local personalization.", error);
    render();
  }
}

function openCustomization(icon: MenuIcon): void {
  const itemId = stableItemId(icon);
  const displayKey = response?.displayKey;
  if (
    !itemId ||
    !displayKey ||
    customizations?.displayKey !== displayKey ||
    !responseContainsItem(response, itemId)
  ) {
    return;
  }
  const current = customizationFor(icon);
  const session = ++customizationEditSession;
  selectedItemIdentity = iconIdentity(icon);
  customizationDraft = {
    session,
    displayKey,
    itemId,
    alias: current?.alias ?? "",
    favorite: current?.favorite ?? false,
    shortcut: current?.shortcut ?? "",
    hidden: current?.hidden ?? false,
  };
  itemShortcutRecording = false;
  customizationMessage = "";
  render();
  window.setTimeout(() => {
    if (customizationDraft?.session === session) {
      results.querySelector<HTMLInputElement>("[data-customization-alias]")?.focus();
    }
  });
}

function closeCustomization(): void {
  resetCustomizationState();
  render();
  window.setTimeout(() => input.focus());
}

function dismissItemShortcutError(): void {
  if (!itemShortcutError) return;
  const generation = ++blurDismissGeneration;
  blurDismissArmed = false;
  pendingBlur = false;
  itemShortcutError = null;
  activeDisplayId = null;
  selectedIndex = 0;
  selectedItemIdentity = null;
  input.value = "";
  applyResponse(null);
  render();
  input.focus();
  void openPalette(generation);
  armBlurDismissAfterDelay(generation);
}

function dismissSavedActionError(): void {
  if (!savedActionError) return;
  const generation = ++blurDismissGeneration;
  blurDismissArmed = false;
  pendingBlur = false;
  savedActionError = null;
  savedActionErrorTitle = "That pinned action isn’t available right now";
  savedActionErrorTarget = null;
  savedActionErrorOpenSettings = false;
  savedActionErrorOpeningSettings = false;
  selectedIndex = 0;
  selectedItemIdentity = null;
  input.value = "";
  activeDisplayId = null;
  applyResponse(null);
  render();
  input.focus();
  void openPalette(generation);
  armBlurDismissAfterDelay(generation);
}

async function toggleItemPin(icon: MenuIcon): Promise<void> {
  const itemId = stableItemId(icon);
  const displayKey = response?.displayKey?.trim();
  if (
    !itemId ||
    !displayKey ||
    customizations?.displayKey !== displayKey ||
    !responseContainsItem(response, itemId) ||
    itemPinSavingId
  ) {
    return;
  }

  const current = customizationFor(icon);
  const nextPinned = !(current?.favorite ?? false);
  itemPinSavingId = itemId;
  itemPinError = null;
  const pinnedItemIdentity = visiblePaletteResults().find(
    (entry) => entry.kind === "item" && entry.itemId === itemId,
  )?.id ?? null;
  selectedItemIdentity = pinnedItemIdentity;
  pointerSelectionArmed = false;
  renderPreservingScroll();

  try {
    const next = await invoke<CatalogCustomizationsResponse>(
      "set_item_customization",
      {
        displayKey,
        itemId,
        alias: current?.alias ?? null,
        favorite: nextPinned,
        shortcut: current?.shortcut ?? null,
        hidden: current?.hidden ?? false,
      },
    );
    if (
      response?.displayKey !== displayKey ||
      !responseContainsItem(response, itemId)
    ) {
      return;
    }
    itemPinSavingId = null;
    pointerSelectionArmed = false;
    applyCustomizations(next, pinnedItemIdentity);
    const nextIndex = visiblePaletteResults().findIndex(
      (entry) => entry.kind === "item" && entry.itemId === itemId,
    );
    if (nextIndex >= 0) updateSelection(nextIndex);
  } catch (error) {
    if (response?.displayKey !== displayKey) return;
    itemPinError = nextPinned
      ? "Macnu couldn’t pin that icon. Nothing was changed; please try again."
      : "Macnu couldn’t unpin that icon. Nothing was changed; please try again.";
    console.error(
      nextPinned ? "Could not pin menu-bar icon." : "Could not unpin menu-bar icon.",
      error,
    );
    renderPreservingScroll();
  } finally {
    if (itemPinSavingId === itemId) {
      itemPinSavingId = null;
      renderPreservingScroll();
    }
    window.setTimeout(() => input.focus({ preventScroll: true }));
  }
}

async function saveCustomization(): Promise<void> {
  if (!customizationDraft || customizationSaving) return;
  const draft = { ...customizationDraft };
  if (
    draft.session !== customizationEditSession ||
    !response ||
    response.displayKey !== draft.displayKey ||
    !responseContainsItem(response, draft.itemId)
  ) {
    resetCustomizationState();
    render();
    return;
  }

  customizationSaving = true;
  customizationMessage = "Saving…";
  render();
  try {
    const next = await invoke<CatalogCustomizationsResponse>(
      "set_item_customization",
      {
        displayKey: draft.displayKey,
        itemId: draft.itemId,
        alias: draft.alias.trim() || null,
        favorite: draft.favorite,
        shortcut: supportsDirectShortcut(draft.itemId)
          ? draft.shortcut || null
          : null,
        hidden: draft.hidden,
      },
    );
    if (
      customizationEditSession !== draft.session ||
      customizationDraft?.session !== draft.session ||
      response?.displayKey !== draft.displayKey ||
      !responseContainsItem(response, draft.itemId)
    ) {
      return;
    }
    resetCustomizationState();
    applyCustomizations(next);
    window.setTimeout(() => input.focus());
  } catch (error) {
    if (
      customizationEditSession !== draft.session ||
      customizationDraft?.session !== draft.session ||
      response?.displayKey !== draft.displayKey ||
      !responseContainsItem(response, draft.itemId)
    ) {
      return;
    }
    customizationSaving = false;
    customizationMessage = String(error);
    render();
    window.setTimeout(() => {
      if (customizationDraft?.session === draft.session) {
        results.querySelector<HTMLInputElement>("[data-customization-alias]")?.focus();
      }
    });
  }
}

function describeSavedActionError(
  error: unknown,
  savedAction: SavedActionView | null = null,
): { title: string; message: string; openSettings?: boolean } {
  const detail = String(error).toLocaleLowerCase();
  const owner =
    savedAction?.owner.trim() || savedAction?.parentLabel.trim() || "the app";
  if (
    detail.includes("valid macnu license") ||
    detail.includes("license is required")
  ) {
    return {
      title: "A Macnu license is required",
      message: "Open Settings to activate or review your license.",
      openSettings: true,
    };
  }
  if (detail.includes("complete macnu setup")) {
    return {
      title: "Finish setting up Macnu",
      message: "Open Settings to complete permissions and setup.",
      openSettings: true,
    };
  }
  if (
    detail.includes("shortcut") ||
    detail.includes("already in use") ||
    detail.includes("key combination")
  ) {
    return {
      title: "That shortcut can’t be used",
      message: "Try a different key combination.",
    };
  }
  if (detail.includes("saved action no longer exists")) {
    return {
      title: "This pinned action was removed",
      message: "Return to search to refresh your pinned actions.",
    };
  }
  if (detail.includes("action changed") || detail.includes("invalid or has changed")) {
    return {
      title: "This pinned action changed",
      message: `Review ${owner}’s current Actions, then pin the action you want.`,
    };
  }
  if (detail.includes("currently unavailable")) {
    return {
      title: "This command is disabled right now",
      message: `Change its state in ${owner}, then try again.`,
    };
  }
  if (
    detail.includes("personalization") ||
    detail.includes("menu cache") ||
    detail.includes("settings are unavailable")
  ) {
    return {
      title: "Macnu couldn’t load pinned actions",
      message: "Nothing was changed. Please try again.",
    };
  }
  if (
    detail.includes("menu-bar item") ||
    detail.includes("menu item") ||
    detail.includes("display is no longer") ||
    detail.includes("not running") ||
    detail.includes("not available")
  ) {
    return {
      title: `${owner} isn’t available on this display`,
      message: "Restore its menu-bar item, then try again.",
    };
  }
  if (detail.includes("accessibility")) {
    return {
      title: "Accessibility permission is required",
      message: "Review Macnu’s Permissions, then try the pinned action again.",
      openSettings: true,
    };
  }
  return {
    title: "Macnu couldn’t run that pinned action",
    message: "The command was not changed. Please try again.",
  };
}

function friendlySavedActionError(error: unknown): string {
  return describeSavedActionError(error).message;
}

function openSavedActionCustomization(savedAction: SavedActionView): void {
  const displayKey = response?.displayKey;
  if (!displayKey || customizations?.displayKey !== displayKey) return;
  const session = ++savedActionEditSession;
  customizationDraft = null;
  itemShortcutRecording = false;
  selectedItemIdentity = `action:${encodeURIComponent(savedAction.parentItemId)}:${encodeURIComponent(savedAction.id)}`;
  savedActionDraft = {
    session,
    displayKey,
    savedActionId: savedAction.id,
    alias: savedAction.alias ?? "",
    shortcut: savedAction.shortcut ?? "",
  };
  savedActionShortcutRecording = false;
  savedActionSaving = false;
  savedActionMessage = "";
  savedActionRemoveArmed = false;
  render();
  window.setTimeout(() => {
    if (savedActionDraft?.session === session) {
      results.querySelector<HTMLInputElement>("[data-saved-action-alias]")?.focus();
    }
  });
}

async function saveSavedActionCustomization(): Promise<void> {
  if (!savedActionDraft || savedActionSaving) return;
  const draft = { ...savedActionDraft };
  if (
    draft.session !== savedActionEditSession ||
    customizations?.displayKey !== draft.displayKey ||
    !customizations.savedActions[draft.savedActionId]
  ) {
    resetCustomizationState();
    render();
    return;
  }
  savedActionSaving = true;
  savedActionMessage = "Saving…";
  render();
  try {
    const next = await invoke<CatalogCustomizationsResponse>(
      "update_saved_action",
      {
        displayKey: draft.displayKey,
        savedActionId: draft.savedActionId,
        alias: draft.alias.trim() || null,
        shortcut: draft.shortcut || null,
      },
    );
    if (
      savedActionEditSession !== draft.session ||
      savedActionDraft?.session !== draft.session ||
      response?.displayKey !== draft.displayKey
    ) {
      return;
    }
    resetCustomizationState();
    applyCustomizations(next);
    window.setTimeout(() => input.focus());
  } catch (error) {
    if (savedActionEditSession !== draft.session) return;
    savedActionSaving = false;
    savedActionMessage = friendlySavedActionError(error);
    render();
    window.setTimeout(() => {
      if (savedActionDraft?.session === draft.session) {
        results.querySelector<HTMLInputElement>("[data-saved-action-alias]")?.focus();
      }
    });
  }
}

async function removeSavedAction(savedActionId: string): Promise<void> {
  const draft = savedActionDraft ? { ...savedActionDraft } : null;
  if (
    !draft ||
    draft.savedActionId !== savedActionId ||
    savedActionSaving ||
    response?.displayKey !== draft.displayKey ||
    !customizations?.savedActions[savedActionId]
  ) {
    return;
  }
  savedActionRemoveArmed = false;
  savedActionShortcutRecording = false;
  savedActionSaving = true;
  savedActionMessage = "Unpinning…";
  render();
  try {
    const next = await invoke<CatalogCustomizationsResponse>(
      "remove_saved_action",
      { displayKey: draft.displayKey, savedActionId },
    );
    const sameEditor =
      savedActionEditSession === draft.session &&
      savedActionDraft?.session === draft.session &&
      savedActionDraft.savedActionId === savedActionId &&
      response?.displayKey === draft.displayKey;
    if (response?.displayKey === draft.displayKey) {
      applyCustomizations(next);
    }
    if (!sameEditor) return;
    resetCustomizationState();
    render();
    window.setTimeout(() => input.focus());
  } catch (error) {
    if (
      savedActionEditSession !== draft.session ||
      savedActionDraft?.session !== draft.session ||
      savedActionDraft.savedActionId !== savedActionId ||
      response?.displayKey !== draft.displayKey
    ) {
      return;
    }
    savedActionSaving = false;
    savedActionMessage = "Macnu couldn’t unpin that action. Nothing was changed; please try again.";
    console.error("Could not unpin action.", error);
    render();
    window.setTimeout(() => {
      if (savedActionDraft?.session === draft.session) {
        results.querySelector<HTMLButtonElement>("[data-remove-saved-action]")?.focus();
      }
    });
  }
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
  if (!query) {
    return pinnedFirstWhenIdle(
      actions,
      (action) => Boolean(savedActionFor(action)),
      false,
    );
  }
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
  const selectedRoot = scoped ? null : selectedPaletteResult();
  const selectedAction = scoped ? visibleActions()[selectedIndex] : null;
  const selectedRootPinnable = Boolean(
    selectedRoot?.kind === "item" &&
      selectedRoot.itemId &&
      !selectedRoot.item.isMacnu,
  );
  const selectedRootPinned =
    selectedRoot?.kind === "item" && selectedRoot.favorite;
  const selectedSavedAction = selectedAction
    ? savedActionFor(selectedAction)
    : null;
  const selectedActionPinned = Boolean(selectedSavedAction);
  const confirmingSelectedUnpin = Boolean(
    selectedSavedAction?.id === pendingActionUnpinId,
  );
  searchRow.classList.toggle("actions-mode", scoped);
  searchLeading.disabled = !scoped;
  input.placeholder = scoped
    ? `Search ${displayLabel(actionScope!)} actions…`
    : "Search menu bar icons…";
  input.setAttribute(
    "aria-label",
    scoped
      ? `Search ${displayLabel(actionScope!)} actions`
      : "Search menu bar icons",
  );
  const primaryMarkup = scoped
    ? selectedAction
      ? '<kbd>↵</kbd><span class="footer-key-label">run</span>'
      : ""
    : selectedRoot
      ? `<kbd>↵</kbd><span class="footer-key-label">${selectedRoot.kind === "action" ? "run" : "open"}</span>`
      : "";
  footerPrimary.innerHTML = primaryMarkup;
  footerPrimary.hidden = !primaryMarkup;

  const secondaryGroups: string[] = [];
  if (scoped) {
    if (selectedAction && confirmingSelectedUnpin) {
      secondaryGroups.push(footerKeyGroup("tab", "choose"));
      secondaryGroups.push(footerKeyGroup("esc", "keep"));
    } else {
      if (selectedAction) {
        secondaryGroups.push(
          footerKeyGroup("⌘P", selectedActionPinned ? "unpin" : "pin"),
        );
      }
      secondaryGroups.push(footerKeyGroup("←", "back"));
    }
  } else if (selectedRoot) {
    if (selectedRootPinnable) {
      secondaryGroups.push(
        footerKeyGroup("⌘P", selectedRootPinned ? "unpin" : "pin"),
      );
    }
    secondaryGroups.push(footerKeyGroup("tab", "actions"));
    if (selectedRoot.kind === "item" && selectedRoot.itemId) {
      secondaryGroups.push(footerKeyGroup("⌘E", "edit"));
    }
  }
  footerSecondary.innerHTML = secondaryGroups.join("");
  footerSecondary.hidden = secondaryGroups.length === 0;
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

  const pinErrorMarkup = actionPinError
    ? `
        <div class="action-pin-error" role="alert">
          <span>${escapeHtml(actionPinError)}</span>
          <button type="button" data-dismiss-action-pin-error aria-label="Dismiss pin error">×</button>
        </div>
      `
    : "";
  const pendingSavedAction = pendingActionUnpinId
    ? customizations?.savedActions[pendingActionUnpinId]
    : undefined;
  const pendingAction = pendingSavedAction
    ? actions.find((action) => savedActionFor(action)?.id === pendingSavedAction.id)
    : undefined;
  if (
    pendingActionUnpinId &&
    (!pendingSavedAction?.shortcut || !pendingAction)
  ) {
    pendingActionUnpinId = null;
  }
  const unpinConfirmationMarkup = pendingSavedAction?.shortcut && pendingAction
    ? `
        <div
          class="action-unpin-confirmation"
          role="alertdialog"
          aria-label="Confirm unpinning action"
        >
          <span>
            Unpin <strong>${escapeHtml(pendingSavedAction.alias?.trim() || pendingAction.title)}</strong>
            and remove its ${shortcutMarkup(pendingSavedAction.shortcut)} shortcut?
          </span>
          <span class="action-unpin-confirmation-controls">
            <button type="button" class="secondary-action" data-cancel-action-unpin ${actionPinSaving ? "disabled" : ""}>Keep</button>
            <button type="button" class="danger-action" data-confirm-action-unpin ${actionPinSaving ? "disabled" : ""}>${actionPinSaving ? "Unpinning…" : "Unpin"}</button>
          </span>
        </div>
      `
    : "";
  results.innerHTML = pinErrorMarkup + unpinConfirmationMarkup + actions
    .map(
      (action, index) => {
        const savedAction = savedActionFor(action);
        const pinned = Boolean(savedAction);
        const actionShortcut = action.shortcut?.trim() ?? "";
        return `
        <div
          class="action-result-row ${index === selectedIndex ? "selected" : ""}"
          data-result-row
          data-index="${index}"
        >
          <button
            type="button"
            class="result action-result ${actionShortcut ? "has-tail" : ""} ${index === selectedIndex ? "selected" : ""} ${
              action.enabled ? "" : "disabled"
            }"
            data-index="${index}"
            tabindex="-1"
            aria-disabled="${!action.enabled}"
            aria-label="${escapeHtml(`${action.title}${pinned ? ", pinned" : ""}`)}"
          >
            <span class="icon-frame">
              <img src="${actionScope!.image}" alt="" draggable="false" />
            </span>
            <span class="result-copy">
              <strong>${escapeHtml(action.title)}</strong>
              <small>${escapeHtml(actionContext(action))}</small>
            </span>
            ${actionShortcut ? `<span class="action-tail">${escapeHtml(actionShortcut)}</span>` : ""}
          </button>
          <button
            type="button"
            class="pin-action ${pinned ? "pinned" : ""}"
            data-pin-action="${escapeHtml(action.id)}"
            data-index="${index}"
            aria-pressed="${pinned}"
            aria-keyshortcuts="Meta+P"
            aria-label="${pinned ? "Unpin" : "Pin"} ${escapeHtml(action.title)}"
            title="${pinned ? "Unpin action" : "Pin action"} (⌘P)"
          >
            ${bookmarkIconMarkup()}
          </button>
        </div>
      `;
      },
    )
    .join("");
}

async function toggleSavedAction(action: MenuAction): Promise<void> {
  const icon = actionScope;
  const displayKey = icon?.displayKey?.trim();
  if (!icon || !displayKey || actionPinSaving) return;
  actionPinError = null;
  const existing = savedActionFor(action);
  if (existing?.shortcut && pendingActionUnpinId !== existing.id) {
    pendingActionUnpinId = existing.id;
    render();
    window.setTimeout(() => {
      results.querySelector<HTMLButtonElement>("[data-cancel-action-unpin]")?.focus();
    });
    return;
  }
  actionPinSaving = true;
  input.readOnly = true;
  if (existing?.shortcut) {
    pendingActionUnpinId = existing.id;
    render();
  } else {
    pendingActionUnpinId = null;
  }
  try {
    const next = existing
      ? await invoke<CatalogCustomizationsResponse>("remove_saved_action", {
          displayKey,
          savedActionId: existing.id,
        })
      : await invoke<CatalogCustomizationsResponse>("save_saved_action", {
          displayKey,
          icon,
          action,
          alias: null,
          shortcut: null,
        });
    actionPinSaving = false;
    pendingActionUnpinId = null;
    applyCustomizations(next);
    const nextIndex = visibleActions().findIndex(
      (candidate) => candidate.id === action.id,
    );
    if (nextIndex >= 0) selectedIndex = nextIndex;
    window.setTimeout(() => input.focus());
    render();
  } catch (error) {
    actionPinSaving = false;
    pendingActionUnpinId = null;
    console.error(
      existing ? "Could not unpin action." : "Could not pin action.",
      error,
    );
    actionPinError = existing
      ? "Macnu couldn’t unpin that action. Nothing was changed; please try again."
      : friendlyPinActionError(error, displayLabel(icon));
    render();
    window.setTimeout(() => input.focus());
  } finally {
    input.readOnly = false;
    actionPinSaving = false;
  }
}

function customizationEditorMarkup(
  entry: Extract<
    PaletteResult<PaletteMenuIcon>,
    { kind: "item" }
  >,
): string {
  if (!customizationDraft || customizationDraft.itemId !== entry.itemId) return "";
  const shortcutAvailable = Boolean(
    entry.itemId && supportsDirectShortcut(entry.itemId),
  );
  const shortcutLabel = itemShortcutRecording
    ? "Press a shortcut"
    : customizationDraft.shortcut
      ? shortcutMarkup(customizationDraft.shortcut)
      : "Set shortcut";
  const favoriteLabel = palettePersonalizePerDisplay
    ? "Pin on this display"
    : "Pin on every display";
  const disabled = customizationSaving ? "disabled" : "";
  const shortcutControl = shortcutAvailable
    ? `
        <div class="item-shortcut-field">
          <span>Direct shortcut</span>
          <button
            type="button"
            class="item-shortcut-recorder ${itemShortcutRecording ? "recording" : ""}"
            data-record-item-shortcut
            aria-pressed="${itemShortcutRecording}"
            ${disabled}
          >${shortcutLabel}</button>
          <button type="button" class="item-shortcut-clear" data-clear-item-shortcut ${customizationDraft.shortcut ? "" : "hidden"} ${disabled}>Clear</button>
        </div>
      `
    : `
        <div class="item-shortcut-field unavailable">
          <span>Direct shortcut</span>
          <small>Unavailable because macOS does not provide a permanent identity for this menu-bar item.</small>
        </div>
      `;

  return `
    <form
      class="item-customization-editor"
      data-item-customization
      aria-label="Customize ${escapeHtml(entry.originalLabel)}"
    >
      <div class="item-customization-heading">
        <strong>Customize ${escapeHtml(entry.originalLabel)}</strong>
        <small>Saved locally on this Mac.</small>
      </div>
      <label class="item-alias-field">
        <span>Alias</span>
        <input
          type="text"
          maxlength="48"
          value="${escapeHtml(customizationDraft.alias)}"
          placeholder="${escapeHtml(entry.originalLabel)}"
          data-customization-alias
          ${disabled}
        />
      </label>
      <label class="item-favorite-field">
        <input
          type="checkbox"
          data-customization-favorite
          ${customizationDraft.favorite ? "checked" : ""}
          ${disabled}
        />
        <span>${favoriteLabel}</span>
      </label>
      <label class="item-favorite-field item-visibility-field">
        <input
          type="checkbox"
          data-customization-visible
          ${customizationDraft.hidden ? "" : "checked"}
          ${disabled}
        />
        <span>Show in search</span>
      </label>
      ${shortcutControl}
      <div class="item-customization-actions">
        <span class="item-customization-message" role="status">${escapeHtml(customizationMessage)}</span>
        <button type="button" class="secondary-action" data-cancel-item-customization ${disabled}>Cancel</button>
        <button type="submit" class="primary-action" ${disabled}>Save</button>
      </div>
    </form>
  `;
}

function savedActionEditorMarkup(
  entry: Extract<
    PaletteResult<PaletteMenuIcon>,
    { kind: "action" }
  >,
): string {
  if (
    !savedActionDraft ||
    savedActionDraft.savedActionId !== entry.savedAction.id
  ) {
    return "";
  }
  const disabled = savedActionSaving ? "disabled" : "";
  const shortcutAvailable = supportsDirectShortcut(entry.parentItemId);
  const shortcutLabel = savedActionShortcutRecording
    ? "Press a shortcut"
    : savedActionDraft.shortcut
      ? shortcutMarkup(savedActionDraft.shortcut)
      : "Set shortcut";
  const shortcutControl = shortcutAvailable
    ? `
        <div class="item-shortcut-field">
          <span>Direct shortcut</span>
          <button
            type="button"
            class="item-shortcut-recorder ${savedActionShortcutRecording ? "recording" : ""}"
            data-record-saved-action-shortcut
            aria-pressed="${savedActionShortcutRecording}"
            ${disabled}
          >${shortcutLabel}</button>
          <button
            type="button"
            class="item-shortcut-clear"
            data-clear-saved-action-shortcut
            ${savedActionDraft.shortcut ? "" : "hidden"}
            ${disabled}
          >Clear</button>
        </div>
      `
    : `
        <div class="item-shortcut-field unavailable">
          <span>Direct shortcut</span>
          <small>This app does not provide a permanent identity for this command.</small>
        </div>
      `;
  return `
    <form
      class="item-customization-editor saved-action-editor"
      data-saved-action-customization
      aria-label="Customize pinned action ${escapeHtml(entry.originalLabel)}"
    >
      <div class="item-customization-heading">
        <strong>Customize ${escapeHtml(entry.originalLabel)}</strong>
        <small>${escapeHtml(entry.parent.label)} · Saved locally on this Mac.</small>
      </div>
      <label class="item-alias-field">
        <span>Alias</span>
        <input
          type="text"
          maxlength="48"
          value="${escapeHtml(savedActionDraft.alias)}"
          placeholder="${escapeHtml(entry.originalLabel)}"
          data-saved-action-alias
          ${disabled}
        />
      </label>
      ${shortcutControl}
      <div class="item-customization-actions">
        ${
          savedActionRemoveArmed && entry.savedAction.shortcut
            ? `
              <span class="item-customization-message saved-action-removal-warning" role="alert">
                Unpin this action and remove its ${shortcutMarkup(entry.savedAction.shortcut)} shortcut?
              </span>
              <button type="button" class="secondary-action" data-cancel-saved-action-removal ${disabled}>Keep</button>
              <button type="button" class="danger-action" data-confirm-saved-action-removal ${disabled}>${savedActionSaving ? "Unpinning…" : "Unpin"}</button>
            `
            : `
              <span class="item-customization-message" role="status">${escapeHtml(savedActionMessage)}</span>
              <button type="button" class="danger-action saved-action-remove" data-remove-saved-action ${disabled}>Unpin</button>
              <button type="button" class="secondary-action" data-cancel-saved-action-customization ${disabled}>Cancel</button>
              <button type="submit" class="primary-action" ${disabled}>Save</button>
            `
        }
      </div>
    </form>
  `;
}

function render(): void {
  updatePaletteChrome();
  if (actionScope) {
    renderActions();
    return;
  }

  if (itemShortcutError) {
    results.innerHTML = `
      <div class="state item-shortcut-error-state" role="alert">
        <span class="empty-symbol" aria-hidden="true">⌁</span>
        <strong>That menu-bar item isn’t available right now</strong>
        <small>Make sure its app is running on this display, then try the shortcut again.</small>
        <button type="button" class="secondary-action dismiss-item-shortcut-error">Back to search</button>
      </div>
    `;
    return;
  }

  if (savedActionError) {
    const canReviewSavedAction = Boolean(
      savedActionErrorTarget &&
      responseContainsItem(response, savedActionErrorTarget.parentItemId),
    );
    results.innerHTML = `
      <div class="state saved-action-error-state" role="alert">
        <span class="empty-symbol" aria-hidden="true">⌁</span>
        <strong>${escapeHtml(savedActionErrorTitle)}</strong>
        <small>${escapeHtml(savedActionError)}</small>
        <div class="state-actions">
          ${
            canReviewSavedAction
              ? '<button type="button" class="primary-action review-saved-action-error">Review Actions</button>'
              : ""
          }
          ${
            savedActionErrorOpenSettings
              ? `<button
                  type="button"
                  class="secondary-action open-saved-action-error-settings"
                  ${savedActionErrorOpeningSettings ? "disabled" : ""}
                >${savedActionErrorOpeningSettings ? "Opening…" : "Open Settings"}</button>`
              : ""
          }
          <button type="button" class="secondary-action dismiss-saved-action-error">Back to search</button>
        </div>
      </div>
    `;
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

  const paletteResults = visiblePaletteResults();
  if (selectedItemIdentity) {
    const identityIndex = paletteResults.findIndex(
      ({ id }) => id === selectedItemIdentity,
    );
    if (identityIndex >= 0) selectedIndex = identityIndex;
  }
  selectedIndex = Math.max(
    0,
    Math.min(selectedIndex, paletteResults.length - 1),
  );
  if (paletteResults[selectedIndex]) {
    selectedItemIdentity = paletteResults[selectedIndex].id;
  }
  updatePaletteChrome();

  if (!paletteResults.length) {
    results.innerHTML = `
      <div class="state">
        <span class="empty-symbol">⌕</span>
        <strong>No matching menu bar icons</strong>
      </div>
    `;
    return;
  }

  const itemPinErrorMarkup = itemPinError
    ? `
        <div class="action-pin-error" role="alert">
          <span>${escapeHtml(itemPinError)}</span>
          <button type="button" data-dismiss-item-pin-error aria-label="Dismiss pin error">×</button>
        </div>
      `
    : "";
  results.innerHTML = itemPinErrorMarkup + paletteResults
    .map(
      (entry, index) => {
        const icon = resultParent(entry);
        const itemId = entry.kind === "item" ? entry.itemId : null;
        const customization = entry.kind === "item"
          ? customizationFor(icon)
          : undefined;
        const directShortcut = entry.kind === "action"
          ? entry.savedAction.shortcut
          : itemId && supportsDirectShortcut(itemId)
            ? customization?.shortcut
            : null;
        const personalizationTail = directShortcut
          ? `<span class="item-shortcut-mark">${shortcutMarkup(directShortcut)}</span>`
          : "";
        const customizeButton = entry.kind === "action"
          ? `
              <button
                type="button"
                class="customize-item customize-saved-action"
                data-index="${index}"
                data-customize-saved-action="${escapeHtml(entry.savedAction.id)}"
                aria-label="Customize pinned action ${escapeHtml(entry.originalLabel)}"
                aria-keyshortcuts="Meta+E"
                title="Customize pinned action"
              >•••</button>
            `
          : itemId
            ? `
              <button
                type="button"
                class="customize-item"
                data-index="${index}"
                data-customize-item="${escapeHtml(itemId)}"
                aria-label="Customize ${escapeHtml(entry.originalLabel)}"
                aria-keyshortcuts="Meta+E"
                title="Customize ${escapeHtml(entry.originalLabel)}"
              >•••</button>
            `
            : "";
        const resultLabel = entry.kind === "item"
          ? paletteResultLabel(icon.isMacnu, entry.label)
          : entry.label;
        const context = icon.isMacnu ? null : entry.context;
        const itemPinButton =
          entry.kind === "item" && itemId && !icon.isMacnu
            ? `
              <button
                type="button"
                class="pin-action item-pin-action ${entry.favorite ? "pinned" : ""}"
                data-pin-item="${escapeHtml(itemId)}"
                data-index="${index}"
                aria-pressed="${entry.favorite}"
                aria-keyshortcuts="Meta+P"
                aria-label="${entry.favorite ? "Unpin" : "Pin"} ${escapeHtml(resultLabel)}"
                title="${entry.favorite ? "Unpin" : "Pin"} ${escapeHtml(resultLabel)} (⌘P)"
                ${itemPinSavingId === itemId ? 'disabled aria-busy="true"' : ""}
              >${bookmarkIconMarkup()}</button>
            `
            : "";
        return `
        <div
          class="result-row ${entry.kind === "action" ? "saved-action-result-row" : ""} ${index === selectedIndex ? "selected" : ""} ${itemId || entry.kind === "action" ? "" : "no-customization"} ${itemPinButton ? "has-pin" : ""}"
          data-result-row
          data-index="${index}"
          data-result-id="${escapeHtml(entry.id)}"
        >
          <button
            type="button"
            class="result menu-result ${personalizationTail ? "has-tail" : ""} ${entry.kind === "action" ? "saved-action-result" : ""} ${index === selectedIndex ? "selected" : ""}"
            data-index="${index}"
            tabindex="-1"
            aria-label="${escapeHtml(
              icon.isMacnu
                ? "Macnu, open settings"
                : `${resultLabel}${entry.kind === "action" ? ", pinned action" : ""}${context ? `, ${context}` : ""}${entry.kind === "item" && entry.favorite ? ", pinned" : ""}`,
            )}"
          >
            <span class="icon-frame">
              <img src="${icon.image}" alt="" draggable="false" />
            </span>
            <span class="result-copy">
              <strong>${escapeHtml(resultLabel)}</strong>
              ${!context ? "" : `<small>${escapeHtml(context)}</small>`}
            </span>
            ${personalizationTail ? `<span class="result-tail" aria-hidden="true">${personalizationTail}</span>` : ""}
          </button>
          ${itemPinButton}
          ${customizeButton}
        </div>
        ${
          entry.kind === "action"
            ? savedActionEditorMarkup(entry)
            : customizationEditorMarkup(entry)
        }
      `;
      },
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
    left.displayKey !== right.displayKey ||
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
      icon.itemId === other.itemId &&
      icon.displayKey === other.displayKey &&
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
  if (responsesEqual(response, next)) {
    if (
      next?.displayKey &&
      customizations?.displayKey !== next.displayKey
    ) {
      void loadCustomizations(next.displayKey);
    }
    return;
  }
  itemPinError = null;
  preserveSelectedIdentity();
  response = next;
  if (!next) {
    customizationRequest += 1;
    customizations = null;
    resetCustomizationState();
  } else if (customizations?.displayKey !== next.displayKey) {
    customizations = null;
    resetCustomizationState();
    void loadCustomizations(next.displayKey);
  } else if (
    customizationDraft &&
    !responseContainsItem(next, customizationDraft.itemId)
  ) {
    resetCustomizationState();
  }
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
      displayKey: response?.displayKey ?? "",
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

function updateSelection(next: number, announce = false, scroll = true): void {
  const itemCount = actionScope ? visibleActions().length : visiblePaletteResults().length;
  if (!itemCount) return;
  selectedIndex = (next + itemCount) % itemCount;
  if (!actionScope) {
    const selected = visiblePaletteResults()[selectedIndex];
    selectedItemIdentity = selected?.id ?? null;
  }
  const items = results.querySelectorAll<HTMLElement>(".result");
  items.forEach((item, index) => {
    const selected = index === selectedIndex;
    item.classList.toggle("selected", selected);
    item.closest<HTMLElement>("[data-result-row]")?.classList.toggle(
      "selected",
      selected,
    );
  });
  const selectedItem = items[selectedIndex];
  if (scroll) {
    (selectedItem?.closest<HTMLElement>("[data-result-row]") ?? selectedItem)
      ?.scrollIntoView({
        block: "nearest",
      });
  }
  if (announce) {
    const announcement = selectedItem?.getAttribute("aria-label")?.trim();
    if (announcement) {
      selectionAnnouncer.textContent = announcement;
    }
  }
  updatePaletteChrome();
}

async function restorePaletteFocus(generation: number): Promise<void> {
  if (generation !== blurDismissGeneration) return;
  await currentWindow.show();
  await currentWindow.setFocus();
  window.setTimeout(() => {
    if (generation === blurDismissGeneration) input.focus();
  }, 20);
}

function armBlurDismissAfterDelay(generation: number): void {
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
}

function leaveActionScope(): void {
  const previousScope = actionScope;
  actionScope = null;
  actionResponse = null;
  actionLoading = false;
  actionRunError = null;
  actionPinError = null;
  pendingActionUnpinId = null;
  input.value = "";
  const paletteResults = visiblePaletteResults();
  const exactOriginIndex = selectedItemIdentity
    ? paletteResults.findIndex(({ id }) => id === selectedItemIdentity)
    : -1;
  const parentItemIndex = previousScope
    ? paletteResults.findIndex(
        (entry) =>
          entry.kind === "item" &&
          actionCacheKey(entry.item) === actionCacheKey(previousScope),
      )
    : -1;
  const parentResultIndex = previousScope
    ? paletteResults.findIndex(
        (entry) =>
          actionCacheKey(resultParent(entry)) === actionCacheKey(previousScope),
      )
    : -1;
  selectedIndex = Math.max(
    0,
    exactOriginIndex >= 0
      ? exactOriginIndex
      : parentItemIndex >= 0
        ? parentItemIndex
        : parentResultIndex,
  );
  selectedItemIdentity = paletteResults[selectedIndex]?.id ?? null;
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
  itemPinError = null;
  actionRunError = null;
  actionPinError = null;
  pendingActionUnpinId = null;
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

async function activateSavedAction(savedAction: SavedActionView): Promise<void> {
  savedActionError = null;
  savedActionErrorTitle = "That pinned action isn’t available right now";
  savedActionErrorTarget = null;
  savedActionErrorOpenSettings = false;
  savedActionErrorOpeningSettings = false;
  await currentWindow.hide();
  try {
    await invoke("activate_saved_action", {
      savedActionId: savedAction.id,
    });
  } catch (error) {
    const description = describeSavedActionError(error, savedAction);
    savedActionErrorTitle = description.title;
    savedActionError = description.message;
    savedActionErrorTarget = savedAction;
    savedActionErrorOpenSettings = Boolean(description.openSettings);
    render();
    await restorePaletteFocus(blurDismissGeneration);
  }
}

function activateSelected(): void {
  if (actionScope) {
    const action = visibleActions()[selectedIndex];
    if (action) void activateScopedAction(action);
    return;
  }
  const selected = selectedPaletteResult();
  if (!selected) return;
  if (selected.kind === "action") {
    void activateSavedAction(selected.savedAction);
  } else void activate(selected.item);
}

input.addEventListener("input", () => {
  if (itemShortcutError || savedActionError) {
    input.value = "";
    return;
  }
  selectedIndex = 0;
  selectedItemIdentity = null;
  itemShortcutError = null;
  savedActionError = null;
  actionPinError = null;
  pendingActionUnpinId = null;
  resetCustomizationState();
  render();
});

window.addEventListener(
  "keydown",
  (event) => {
    if (itemShortcutRecording && customizationDraft) {
      event.preventDefault();
      event.stopPropagation();
      if (
        !supportsDirectShortcut(customizationDraft.itemId) ||
        customizationDraft.session !== customizationEditSession ||
        response?.displayKey !== customizationDraft.displayKey ||
        !responseContainsItem(response, customizationDraft.itemId)
      ) {
        resetCustomizationState();
        render();
        return;
      }
      if (event.key === "Escape") {
        itemShortcutRecording = false;
        customizationMessage = "";
      } else {
        const shortcut = eventShortcut(event);
        if (!shortcut) return;
        customizationDraft.shortcut = shortcut;
        itemShortcutRecording = false;
        customizationMessage = "";
      }
      render();
      window.setTimeout(() => {
        results.querySelector<HTMLButtonElement>("[data-record-item-shortcut]")?.focus();
      });
      return;
    }
    if (savedActionShortcutRecording && savedActionDraft) {
      event.preventDefault();
      event.stopPropagation();
      if (
        savedActionDraft.session !== savedActionEditSession ||
        response?.displayKey !== savedActionDraft.displayKey ||
        !supportsDirectShortcut(
          customizations?.savedActions[savedActionDraft.savedActionId]
            ?.parentItemId ?? "",
        )
      ) {
        resetCustomizationState();
        render();
        return;
      }
      if (event.key === "Escape") {
        savedActionShortcutRecording = false;
        savedActionMessage = "";
      } else {
        const shortcut = eventShortcut(event);
        if (!shortcut) return;
        savedActionDraft.shortcut = shortcut;
        savedActionShortcutRecording = false;
        savedActionMessage = "";
      }
      render();
      window.setTimeout(() => {
        results.querySelector<HTMLButtonElement>("[data-record-saved-action-shortcut]")?.focus();
      });
      return;
    }
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (savedActionSaving || actionPinSaving) return;
    if (savedActionRemoveArmed) {
      savedActionRemoveArmed = false;
      render();
      window.setTimeout(() => {
        results.querySelector<HTMLButtonElement>("[data-remove-saved-action]")?.focus();
      });
      return;
    }
    if (pendingActionUnpinId) {
      pendingActionUnpinId = null;
      render();
      window.setTimeout(() => input.focus());
      return;
    }
    if (customizationDraft || savedActionDraft) {
      closeCustomization();
      return;
    }
    blurDismissGeneration += 1;
    void currentWindow.hide();
  },
  { capture: true },
);

input.addEventListener("keydown", (event) => {
  if (itemShortcutError || savedActionError) {
    event.preventDefault();
    event.stopPropagation();
    const action = itemShortcutErrorKeyAction(event.key);
    if (action === "dismiss") {
      if (itemShortcutError) dismissItemShortcutError();
      else dismissSavedActionError();
    } else if (action === "focus-dismiss") {
      const recoverySelector = itemShortcutError
        ? ".dismiss-item-shortcut-error"
        : ".saved-action-error-state button:not([disabled])";
      results.querySelector<HTMLButtonElement>(recoverySelector)?.focus();
    }
    return;
  }
  if (isPinShortcut(event.key, event)) {
    if (actionScope) {
      const action = visibleActions()[selectedIndex];
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      void toggleSavedAction(action);
    } else {
      const selected = selectedPaletteResult();
      if (selected?.kind !== "item" || !selected.itemId || selected.item.isMacnu) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void toggleItemPin(selected.item);
    }
  } else if (!actionScope && event.metaKey && event.key.toLocaleLowerCase() === "e") {
    const selected = selectedPaletteResult();
    if (selected?.kind === "action") {
      event.preventDefault();
      event.stopPropagation();
      openSavedActionCustomization(selected.savedAction);
    } else if (selected?.kind === "item" && selected.itemId) {
      event.preventDefault();
      event.stopPropagation();
      openCustomization(selected.item);
    }
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    event.stopPropagation();
    const now = performance.now();
    if (event.repeat && now - lastArrowNavigationAt < 90) return;
    lastArrowNavigationAt = now;
    pointerSelectionArmed = false;
    updateSelection(selectedIndex + 1, true);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    event.stopPropagation();
    const now = performance.now();
    if (event.repeat && now - lastArrowNavigationAt < 90) return;
    lastArrowNavigationAt = now;
    pointerSelectionArmed = false;
    updateSelection(selectedIndex - 1, true);
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
    const selected = selectedPaletteResult();
    if (selected && !actionLoading) void openActionScope(resultParent(selected));
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

function resultIndexFromTarget(target: HTMLElement): number | null {
  const indexed = target.closest<HTMLElement>("[data-result-row], .result");
  const index = Number(indexed?.dataset.index);
  return Number.isInteger(index) ? index : null;
}

results.addEventListener("focusin", (event) => {
  const index = resultIndexFromTarget(event.target as HTMLElement);
  if (index === null) return;
  pointerSelectionArmed = false;
  const pinControl = (event.target as HTMLElement).closest("[data-pin-item]");
  updateSelection(index, false, !pinControl);
});

results.addEventListener("mousemove", (event) => {
  const position = { x: event.clientX, y: event.clientY };
  const moved = pointerPositionChanged(lastPointerPosition, position);
  lastPointerPosition = position;
  // Scrolling or replacing rows can emit mousemove without physical movement.
  if (!moved || itemPinSavingId) return;
  if (!pointerSelectionArmed) {
    pointerSelectionArmed = true;
    return;
  }
  const index = resultIndexFromTarget(event.target as HTMLElement);
  if (index === null || index === selectedIndex) return;
  updateSelection(index);
});

results.addEventListener("input", (event) => {
  const alias = (event.target as HTMLElement).closest<HTMLInputElement>(
    "[data-customization-alias]",
  );
  if (alias && customizationDraft) customizationDraft.alias = alias.value;
  const savedAlias = (event.target as HTMLElement).closest<HTMLInputElement>(
    "[data-saved-action-alias]",
  );
  if (savedAlias && savedActionDraft) savedActionDraft.alias = savedAlias.value;
});

results.addEventListener("change", (event) => {
  const target = event.target as HTMLElement;
  const favorite = (event.target as HTMLElement).closest<HTMLInputElement>(
    "[data-customization-favorite]",
  );
  if (favorite && customizationDraft) customizationDraft.favorite = favorite.checked;
  const visible = target.closest<HTMLInputElement>("[data-customization-visible]");
  if (visible && customizationDraft) customizationDraft.hidden = !visible.checked;
});

results.addEventListener("submit", (event) => {
  const itemForm = (event.target as HTMLElement).closest<HTMLFormElement>(
    "[data-item-customization]",
  );
  if (itemForm) {
    event.preventDefault();
    const alias = itemForm.querySelector<HTMLInputElement>("[data-customization-alias]");
    const favorite = itemForm.querySelector<HTMLInputElement>("[data-customization-favorite]");
    const visible = itemForm.querySelector<HTMLInputElement>("[data-customization-visible]");
    if (customizationDraft) {
      customizationDraft.alias = alias?.value ?? customizationDraft.alias;
      customizationDraft.favorite = favorite?.checked ?? customizationDraft.favorite;
      customizationDraft.hidden = !(visible?.checked ?? !customizationDraft.hidden);
    }
    void saveCustomization();
    return;
  }
  const savedActionForm = (event.target as HTMLElement).closest<HTMLFormElement>(
    "[data-saved-action-customization]",
  );
  if (!savedActionForm) return;
  event.preventDefault();
  const alias = savedActionForm.querySelector<HTMLInputElement>(
    "[data-saved-action-alias]",
  );
  if (savedActionDraft) savedActionDraft.alias = alias?.value ?? savedActionDraft.alias;
  void saveSavedActionCustomization();
});

results.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  if (target.closest(".dismiss-item-shortcut-error")) {
    dismissItemShortcutError();
    return;
  }
  if (target.closest(".review-saved-action-error")) {
    event.preventDefault();
    const failedAction = savedActionErrorTarget;
    const parent = failedAction
      ? response?.icons.find(
          (icon) => stableItemId(icon) === failedAction.parentItemId,
        )
      : undefined;
    savedActionError = null;
    savedActionErrorTitle = "That pinned action isn’t available right now";
    savedActionErrorTarget = null;
    savedActionErrorOpenSettings = false;
    savedActionErrorOpeningSettings = false;
    if (parent) {
      void openActionScope(parent, true);
    } else {
      render();
      input.focus();
    }
    return;
  }
  if (target.closest(".open-saved-action-error-settings")) {
    event.preventDefault();
    if (savedActionErrorOpeningSettings) return;
    savedActionErrorOpeningSettings = true;
    render();
    void invoke("open_settings")
      .then(() => {
        if (!savedActionError) return;
        savedActionErrorOpeningSettings = false;
        render();
      })
      .catch((error) => {
        console.error("Could not open Settings from the pinned action error.", error);
        if (!savedActionError) return;
        savedActionErrorOpeningSettings = false;
        savedActionError =
          "Macnu couldn’t open Settings. Nothing was changed; please try again.";
        render();
        window.setTimeout(() => {
          results
            .querySelector<HTMLButtonElement>(
              ".open-saved-action-error-settings",
            )
            ?.focus();
        });
      });
    return;
  }
  if (target.closest(".dismiss-saved-action-error")) {
    dismissSavedActionError();
    return;
  }
  if (target.closest("[data-dismiss-item-pin-error]")) {
    event.preventDefault();
    itemPinError = null;
    render();
    input.focus();
    return;
  }
  if (target.closest("[data-dismiss-action-pin-error]")) {
    event.preventDefault();
    actionPinError = null;
    render();
    input.focus();
    return;
  }
  if (target.closest("[data-cancel-action-unpin]")) {
    if (actionPinSaving) return;
    event.preventDefault();
    event.stopPropagation();
    pendingActionUnpinId = null;
    render();
    window.setTimeout(() => input.focus());
    return;
  }
  const confirmActionUnpin = target.closest<HTMLButtonElement>(
    "[data-confirm-action-unpin]",
  );
  if (confirmActionUnpin && pendingActionUnpinId) {
    if (actionPinSaving) return;
    event.preventDefault();
    event.stopPropagation();
    const savedActionId = pendingActionUnpinId;
    const action = visibleActions().find(
      (candidate) => savedActionFor(candidate)?.id === savedActionId,
    );
    if (action) {
      confirmActionUnpin.disabled = true;
      void toggleSavedAction(action);
    } else {
      pendingActionUnpinId = null;
      render();
      window.setTimeout(() => input.focus());
    }
    return;
  }
  const pinItem = target.closest<HTMLButtonElement>("[data-pin-item]");
  if (pinItem && !actionScope) {
    event.preventDefault();
    event.stopPropagation();
    lastPointerPosition = { x: event.clientX, y: event.clientY };
    const index = Number(pinItem.dataset.index);
    const itemId = pinItem.dataset.pinItem;
    const selected = visiblePaletteResults()[index];
    if (
      selected?.kind === "item" &&
      selected.itemId === itemId &&
      !selected.item.isMacnu
    ) {
      updateSelection(index, false, false);
      void toggleItemPin(selected.item);
    }
    return;
  }
  const pinAction = target.closest<HTMLButtonElement>("[data-pin-action]");
  if (pinAction && actionScope) {
    event.preventDefault();
    event.stopPropagation();
    const index = Number(pinAction.dataset.index);
    const action = visibleActions()[index];
    if (action) {
      updateSelection(index);
      void toggleSavedAction(action);
    }
    return;
  }
  const customizeSaved = target.closest<HTMLButtonElement>(
    "[data-customize-saved-action]",
  );
  if (customizeSaved) {
    event.preventDefault();
    event.stopPropagation();
    const savedActionId = customizeSaved.dataset.customizeSavedAction;
    const savedAction = savedActionId
      ? customizations?.savedActions[savedActionId]
      : undefined;
    const index = Number(customizeSaved.dataset.index);
    if (savedAction) {
      if (Number.isInteger(index)) updateSelection(index);
      openSavedActionCustomization(savedAction);
    }
    return;
  }
  const customize = target.closest<HTMLElement>("[data-customize-item]");
  if (customize) {
    event.preventDefault();
    event.stopPropagation();
    const itemId = customize.dataset.customizeItem;
    const icon = response?.icons.find((candidate) => stableItemId(candidate) === itemId);
    if (icon) openCustomization(icon);
    return;
  }
  if (target.closest("[data-cancel-item-customization]")) {
    event.preventDefault();
    closeCustomization();
    return;
  }
  if (target.closest("[data-cancel-saved-action-customization]")) {
    if (savedActionSaving) return;
    event.preventDefault();
    closeCustomization();
    return;
  }
  if (target.closest("[data-record-item-shortcut]")) {
    event.preventDefault();
    if (
      !customizationDraft ||
      !supportsDirectShortcut(customizationDraft.itemId) ||
      customizationDraft.session !== customizationEditSession ||
      response?.displayKey !== customizationDraft.displayKey ||
      !responseContainsItem(response, customizationDraft.itemId)
    ) {
      resetCustomizationState();
      render();
      return;
    }
    itemShortcutRecording = true;
    customizationMessage = "Use a modifier with another key.";
    render();
    window.setTimeout(() => {
      results.querySelector<HTMLButtonElement>("[data-record-item-shortcut]")?.focus();
    });
    return;
  }
  if (target.closest("[data-clear-item-shortcut]")) {
    event.preventDefault();
    if (customizationDraft) customizationDraft.shortcut = "";
    itemShortcutRecording = false;
    customizationMessage = "";
    render();
    window.setTimeout(() => {
      results.querySelector<HTMLButtonElement>("[data-record-item-shortcut]")?.focus();
    });
    return;
  }
  if (target.closest("[data-record-saved-action-shortcut]")) {
    event.preventDefault();
    const current = savedActionDraft
      ? customizations?.savedActions[savedActionDraft.savedActionId]
      : undefined;
    if (
      !savedActionDraft ||
      !current ||
      !supportsDirectShortcut(current.parentItemId) ||
      savedActionDraft.session !== savedActionEditSession ||
      response?.displayKey !== savedActionDraft.displayKey
    ) {
      resetCustomizationState();
      render();
      return;
    }
    savedActionShortcutRecording = true;
    savedActionMessage = "Use a modifier with another key.";
    render();
    window.setTimeout(() => {
      results.querySelector<HTMLButtonElement>("[data-record-saved-action-shortcut]")?.focus();
    });
    return;
  }
  if (target.closest("[data-clear-saved-action-shortcut]")) {
    event.preventDefault();
    if (savedActionDraft) savedActionDraft.shortcut = "";
    savedActionShortcutRecording = false;
    savedActionMessage = "";
    render();
    window.setTimeout(() => {
      results.querySelector<HTMLButtonElement>("[data-record-saved-action-shortcut]")?.focus();
    });
    return;
  }
  if (target.closest("[data-cancel-saved-action-removal]")) {
    if (savedActionSaving) return;
    event.preventDefault();
    savedActionRemoveArmed = false;
    render();
    window.setTimeout(() => {
      results.querySelector<HTMLButtonElement>("[data-remove-saved-action]")?.focus();
    });
    return;
  }
  const confirmSavedActionRemoval = target.closest<HTMLButtonElement>(
    "[data-confirm-saved-action-removal]",
  );
  if (confirmSavedActionRemoval) {
    if (savedActionSaving) return;
    event.preventDefault();
    if (savedActionDraft) {
      confirmSavedActionRemoval.disabled = true;
      void removeSavedAction(savedActionDraft.savedActionId);
    }
    return;
  }
  if (target.closest("[data-remove-saved-action]")) {
    event.preventDefault();
    if (!savedActionDraft) return;
    const current = customizations?.savedActions[savedActionDraft.savedActionId];
    if (current?.shortcut) {
      savedActionRemoveArmed = true;
      savedActionMessage = "";
      render();
      window.setTimeout(() => {
        results.querySelector<HTMLButtonElement>("[data-cancel-saved-action-removal]")?.focus();
      });
    } else {
      void removeSavedAction(savedActionDraft.savedActionId);
    }
    return;
  }
  const item = target.closest<HTMLButtonElement>(".result");
  if (item) {
    const index = Number(item.dataset.index);
    if (actionScope) {
      const action = visibleActions()[index];
      if (action) void activateScopedAction(action);
    } else {
      const selected = visiblePaletteResults()[index];
      if (selected?.kind === "action") {
        void activateSavedAction(selected.savedAction);
      } else if (selected?.kind === "item") {
        void activate(selected.item);
      }
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
  itemPinError = null;
  actionPinError = null;
  pendingActionUnpinId = null;
  input.value = "";
  selectedIndex = 0;
  selectedItemIdentity = null;
  resetCustomizationState();
  itemShortcutError = null;
  savedActionError = null;
  savedActionErrorTitle = "That pinned action isn’t available right now";
  savedActionErrorTarget = null;
  savedActionErrorOpenSettings = false;
  savedActionErrorOpeningSettings = false;
  rankingNow = Date.now();
  pointerSelectionArmed = false;
  lastArrowNavigationAt = 0;
  activeDisplayId = null;
  applyResponse(null);
  window.setTimeout(() => input.focus(), 30);
  void openPalette(generation);
  armBlurDismissAfterDelay(generation);
});

void currentWindow.listen<MenuResponse>("menu-cache-updated", ({ payload }) => {
  if (actionScope || itemShortcutError || savedActionError) return;
  applyResponse(payload);
});

void currentWindow.listen<CatalogCustomizationsResponse>(
  "catalog-customizations-changed",
  ({ payload }) => applyCustomizations(payload),
);
void currentWindow.listen("catalog-customizations-invalidated", () => {
  preserveSelectedIdentity();
  customizationRequest += 1;
  customizations = null;
  resetCustomizationState();
  rankingNow = Date.now();
  render();
  if (response?.displayKey) void loadCustomizations(response.displayKey);
});

void currentWindow.listen<SettingsResponse>(
  "personalization-settings-changed",
  ({ payload }) => {
    preserveSelectedIdentity();
    paletteRankingMode = payload.rankingMode;
    palettePersonalizePerDisplay = payload.personalizePerDisplay;
    rankingNow = Date.now();
    if (response?.displayKey) {
      void loadCustomizations(response.displayKey);
    } else {
      render();
    }
  },
);

void currentWindow.listen("personalization-history-reset", () => {
  rankingNow = Date.now();
  if (response?.displayKey) void loadCustomizations(response.displayKey);
});

void currentWindow.listen<string>("item-shortcut-error", ({ payload }) => {
  console.error("A direct item shortcut could not be completed.", payload);
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
  selectedItemIdentity = null;
  resetCustomizationState();
  itemShortcutError = "unavailable";
  activeDisplayId = null;
  response = null;
  customizationRequest += 1;
  customizations = null;
  pointerSelectionArmed = false;
  lastArrowNavigationAt = 0;
  render();
  void restorePaletteFocus(generation)
    .then(() => {
      armBlurDismissAfterDelay(generation);
    })
    .catch((error) => {
      console.error("Could not show the direct shortcut error.", error);
    });
});

void currentWindow.listen<string>("saved-action-shortcut-error", ({ payload }) => {
  console.error("A pinned action shortcut could not be completed.", payload);
  applyAppearance();
  const generation = ++blurDismissGeneration;
  blurDismissArmed = false;
  pendingBlur = false;
  actionScope = null;
  actionResponse = null;
  actionLoading = false;
  actionRunError = null;
  actionPinError = null;
  pendingActionUnpinId = null;
  input.value = "";
  selectedIndex = 0;
  selectedItemIdentity = null;
  resetCustomizationState();
  itemShortcutError = null;
  const description = describeSavedActionError(payload);
  savedActionErrorTitle = description.title;
  savedActionError = description.message;
  savedActionErrorTarget = null;
  savedActionErrorOpenSettings = Boolean(description.openSettings);
  savedActionErrorOpeningSettings = false;
  activeDisplayId = null;
  response = null;
  customizationRequest += 1;
  customizations = null;
  pointerSelectionArmed = false;
  lastArrowNavigationAt = 0;
  render();
  void restorePaletteFocus(generation)
    .then(() => armBlurDismissAfterDelay(generation))
    .catch((error) => {
      console.error("Could not show the pinned action shortcut error.", error);
    });
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
