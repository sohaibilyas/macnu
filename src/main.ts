import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./styles.css";

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
};

type SettingsResponse = {
  shortcut: string;
  startAtLoginStatus: number;
};

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
        <span class="settings-app-icon" aria-hidden="true">M</span>
        <span class="settings-heading">
          <strong>Macnu</strong>
          <small>Settings</small>
        </span>
        <button class="close settings-close" aria-label="Close Settings">×</button>
      </header>
      <div class="divider"></div>
      <div class="settings-layout">
        <aside class="settings-sidebar">
          <button class="settings-nav selected">
            <span aria-hidden="true">⌘</span>
            General
          </button>
          <div class="settings-version">Macnu 0.1.0</div>
        </aside>
        <main class="settings-content">
          <div class="settings-copy">
            <h1>General</h1>
            <p>Choose how Macnu launches and how you bring it forward.</p>
          </div>
          <section class="settings-group">
            <div class="setting-row">
              <div class="setting-label">
                <strong>Start at Login</strong>
                <small>Keep Macnu ready in the menu bar after signing in.</small>
              </div>
              <label class="switch">
                <input class="login-toggle" type="checkbox" />
                <span></span>
              </label>
            </div>
            <div class="setting-row shortcut-row">
              <div class="setting-label">
                <strong>Open Macnu</strong>
                <small>Click the shortcut, then press a new key combination.</small>
              </div>
              <div class="shortcut-actions">
                <button class="shortcut-recorder" aria-label="Change shortcut"></button>
                <button class="shortcut-reset" title="Reset shortcut">Reset</button>
              </div>
            </div>
          </section>
          <div class="settings-message" role="status"></div>
        </main>
      </div>
    </section>
  `;

  enableWindowDragging(".settings-titlebar");

  const toggle = app.querySelector<HTMLInputElement>(".login-toggle")!;
  const recorder = app.querySelector<HTMLButtonElement>(".shortcut-recorder")!;
  const reset = app.querySelector<HTMLButtonElement>(".shortcut-reset")!;
  const message = app.querySelector<HTMLElement>(".settings-message")!;
  let settings: SettingsResponse | null = null;
  let recording = false;

  function setMessage(text = "", kind: "info" | "error" = "info"): void {
    message.className = `settings-message ${kind}`;
    message.innerHTML = text;
  }

  function applySettings(next: SettingsResponse): void {
    settings = next;
    toggle.checked = [1, 2].includes(next.startAtLoginStatus);
    recorder.innerHTML = shortcutMarkup(next.shortcut);
    recorder.classList.remove("recording");
    recording = false;
    if (next.startAtLoginStatus === 2) {
      setMessage(
        `Start at Login needs approval. <button class="login-settings-link">Open Login Items</button>`,
      );
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
      setMessage(String(error), "error");
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
    if ((event.target as HTMLElement).closest(".login-settings-link")) {
      void invoke("open_login_items_settings");
    }
  });

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
  void currentWindow.listen("settings-opened", () => void refreshSettings());
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
      <button class="close" aria-label="Close">×</button>
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
    results.innerHTML = "";
    return;
  }

  if (response.screenCaptureDenied) {
    results.innerHTML = `
      <div class="permission-state">
        <span class="permission-icon">◉</span>
        <strong>Screen Recording is required</strong>
        <p>Enable Macnu in System Settings, then reopen it.</p>
        <button class="primary-action permission-button">Open System Settings</button>
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
    if (promptPermissions && next?.screenCaptureDenied) {
      window.setTimeout(() => void openScreenPermission(), 200);
    } else if (promptPermissions && next?.accessibilityDenied) {
      window.setTimeout(() => void openAccessibilityPermission(), 200);
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
    applyResponse(snapshot.response);
    if (snapshot.response) updateSelection(0);
    if (!snapshot.response) void refreshIcons(true);
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
  } else if (event.key === "Escape") {
    void currentWindow.hide();
  }
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
app.querySelector<HTMLButtonElement>(".close")!.addEventListener("click", () => {
  void currentWindow.hide();
});

void currentWindow.listen("palette-opened", () => {
  const generation = ++blurDismissGeneration;
  blurDismissArmed = false;
  pendingBlur = false;
  input.value = "";
  selectedIndex = 0;
  pointerSelectionArmed = false;
  lastArrowNavigationAt = 0;
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

void currentWindow.onFocusChanged(({ payload: focused }) => {
  if (focused) {
    pendingBlur = false;
    return;
  }
  if (!blurDismissArmed) {
    pendingBlur = true;
    return;
  }
  void currentWindow.hide();
});

}
