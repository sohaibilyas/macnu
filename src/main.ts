import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
            <div class="settings-version">Macnu 0.1.0</div>
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
                  <img src="${appIconUrl}" alt="" draggable="false" />
                  <div class="permission-setting-copy">
                    <span class="permission-title-line">
                      <strong>Accessibility</strong>
                      <span class="permission-badge" data-permission-badge="accessibility">Checking…</span>
                    </span>
                    <small>Required to read item names and open their original menus.</small>
                  </div>
                  <button class="secondary-action permission-settings-action" data-open-permission="accessibility">Open Settings</button>
                </article>
                <article class="permission-setting-card">
                  <span class="permission-preview-icon" aria-hidden="true">◎</span>
                  <div class="permission-setting-copy">
                    <span class="permission-title-line">
                      <strong>Screen Recording</strong>
                      <span class="permission-badge optional" data-permission-badge="screen">Optional</span>
                    </span>
                    <small>Adds exact menu-bar artwork. Search and opening still work without it.</small>
                  </div>
                  <button class="secondary-action permission-settings-action" data-open-permission="screen">Open Settings</button>
                </article>
              </div>
              <div class="permission-settings-footer">
                <button class="permission-recheck" data-recheck-permissions>Recheck permissions</button>
                <button class="permission-recheck" data-run-onboarding>Run setup again</button>
              </div>
            </section>

            <div class="settings-message-row">
              <div class="settings-message" role="status" aria-live="polite"></div>
              <button class="login-settings-link" hidden>Open Login Items</button>
            </div>
          </main>
        </div>

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
  const onboarding = app.querySelector<HTMLElement>(".onboarding")!;
  let settings: SettingsResponse | null = null;
  let permissionStatus: PermissionStatus | null = null;
  let recording = false;
  let permissionGuardVisible = false;
  let permissionSettingsOpened = false;

  function setMessage(text = "", kind: "info" | "error" = "info"): void {
    message.className = `settings-message ${kind}`;
    message.textContent = text;
  }

  function showActionError(error: unknown): void {
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

  function showSettingsView(view: "general" | "permissions"): void {
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

  function syncPermissionGuard(): void {
    settingsLayout.hidden = permissionGuardVisible;
    onboarding.hidden = !permissionGuardVisible;
    app.querySelector<HTMLElement>(".settings-heading small")!.textContent = permissionGuardVisible
      ? "Setup"
      : "Settings";
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
      syncPermissionGuard();
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
    settingsLoading.hidden = true;
    permissionGuardVisible = !next.onboardingCompleted || !next.accessibilityGranted;
    syncPermissionGuard();
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
      settingsLoading.hidden = true;
      settingsLayout.hidden = false;
      setMessage(String(error), "error");
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
    if (target.closest(".login-settings-link")) {
      void invoke("open_login_items_settings");
      return;
    }
    const nav = target.closest<HTMLButtonElement>("[data-settings-view]");
    if (nav) {
      showSettingsView(nav.dataset.settingsView as "general" | "permissions");
      return;
    }
    const appearance = target.closest<HTMLButtonElement>("[data-appearance]");
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
          void currentWindow.hide();
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
      );
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
      void currentWindow.hide();
    }
  });

  app.querySelector<HTMLButtonElement>(".settings-close")!.addEventListener(
    "click",
    () => void currentWindow.hide(),
  );
  void currentWindow.onCloseRequested((event) => {
    event.preventDefault();
    void currentWindow.hide();
  });
  void currentWindow.listen("settings-opened", () => {
    applyAppearance();
    void refreshSettings();
  });
  void currentWindow.listen<PermissionStatus>("permission-status-changed", ({ payload }) => {
    updatePermissionStatus(payload);
    if (settings) settings = { ...settings, ...payload };
  });
  updateAppearanceControls();
  await refreshSettings();
}

if (currentWindow.label === "settings") {
  void initSettings();
} else {

app.innerHTML = `
  <section class="palette" aria-label="Macnu menu search">
    <header class="search-row">
      <span class="search-icon" aria-hidden="true"></span>
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
      <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
      <span><kbd>↵</kbd> open</span>
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

function visibleIcons(): MenuIcon[] {
  const query = input.value.trim().toLocaleLowerCase();
  const icons = response?.icons ?? [];
  if (!query) return icons;
  return icons.filter((icon) =>
    `${icon.label} ${icon.owner}`.toLocaleLowerCase().includes(query),
  );
}

function render(): void {
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
            <strong>${escapeHtml(icon.label)}</strong>
            <small>${escapeHtml(icon.owner)}</small>
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
  const icons = visibleIcons();
  if (!icons.length) return;
  selectedIndex = (next + icons.length) % icons.length;
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
    const icon = visibleIcons()[Number(item.dataset.index)];
    if (icon) void activate(icon);
    return;
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
app.querySelector<HTMLButtonElement>(".settings-button")!.addEventListener(
  "click",
  () => void invoke("open_settings"),
);

void currentWindow.listen("palette-opened", () => {
  applyAppearance();
  const generation = ++blurDismissGeneration;
  blurDismissArmed = false;
  pendingBlur = false;
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

// The release binary's private live-test flag keeps the palette inspectable
// while the Computer Use helper briefly becomes the frontmost process. Normal
// launches retain the click-away behavior below.
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
  if (!blurDismissArmed) {
    pendingBlur = true;
    return;
  }
  void currentWindow.hide();
});

}
