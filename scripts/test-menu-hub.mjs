// Run against npm run dev. Requires Playwright (set MACNU_PLAYWRIGHT_MODULE if not installed locally).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MACNU_PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.MACNU_CHROME_PATH ? { executablePath: process.env.MACNU_CHROME_PATH } : {}),
});
const page = await browser.newPage({ viewport: { width: 740, height: 580 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route(/\/@tauri-apps_api_(core|window|app)\.js/, async (route) => {
  const name = route.request().url().match(/api_(core|window|app)\.js/)[1];
  const body = name === "core"
    ? 'export const invoke=(cmd,args)=>window.testInvoke(cmd,args); export class Channel {}'
    : name === "app" ? 'export const getVersion=async()=>"0.5.0";'
    : `export const getCurrentWindow=()=>({
      label:new URL(location.href).searchParams.get("window") || "main", listen:async(name,fn)=>{window.testEvents[name]=(...args)=>{if(name==="palette-opened")window.testHidden=false;return fn(...args);};return ()=>{};},
      onCloseRequested:async()=>()=>{},
      onThemeChanged:async()=>()=>{}, onFocusChanged:async()=>()=>{},
      isVisible:async()=>!window.testHidden, isFocused:async()=>true,
      hide:async()=>{window.testHidden=true;},show:async()=>{},setFocus:async()=>{},startDragging:async()=>{}
    });`;
  await route.fulfill({ contentType: "application/javascript", body });
});
await page.addInitScript(() => {
  if (!localStorage.getItem("macnu.layout")) localStorage.setItem("macnu.layout", "grid");
  localStorage.setItem("macnu.appearance", "dark");
  window.testEvents = {};
  window.testCalls = [];
  window.testHidden = false;
  const displayKey = "v1.display-uuid.dGVzdA";
  const image = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect x="2" y="2" width="60" height="60" rx="15" fill="#5264bd"/><circle cx="32" cy="32" r="15" fill="#cad4ff"/></svg>');
  const icon = (name, i) => ({
    owner: name, label: name, itemId: "v1.item-identifier.app." + i, windowId: i,
    x: 0, y: 0, width: 24, height: 24, image, displayKey, isMacnu: false,
  });
  window.testResponse = {
    displayKey, displayId: 1, screenCaptureDenied: true, accessibilityDenied: false, error: null,
    icons: ["Tailscale", "Monitor", "Pretty Timezones", "BetterDisplay", "ChatGPT", "Macnu", "Scroll Reverser", "A Very Long Application Name"].map(icon),
  };
  window.testResponse.icons[1].label = "CPU 28%, Memory 76%, Network ↑6.9 KB/s";
  window.testResponse.icons[0].itemId = "v1.item-label-role.YXBw.bGFiZWw.cm9sZQ";
  window.testResponse.icons[5].isMacnu = true;
  window.testResponse.icons[5].label = "Macnu — Command+Semicolon";
  window.testCatalog = { displayKey, rankingMode: "menuBar", personalizePerDisplay: true, items: {}, savedActions: {}, pinnedApps: {} };
  for (const app of window.testResponse.icons) {
    window.testCatalog.items[app.itemId] = { alias: null, hidden: false, shortcut: null, favorite: false, usageCount: 0, lastUsedAt: null };
  }
  const offline = icon("Saved Utility", 100);
  window.testOffline = offline;
  window.testCatalog.items[offline.itemId] = { alias: null, hidden: false, shortcut: null, favorite: true, usageCount: 0, lastUsedAt: null };
  window.testCatalog.pinnedApps[offline.itemId] = { name: offline.owner, bundleId: "example.utility", image, running: false, installed: true };
  window.testInvoke = async (command, args) => {
    window.testCalls.push({ command, args });
    if (command === "get_settings") return { shortcut: "Command+Semicolon", rankingMode: "menuBar", personalizePerDisplay: true, startAtLoginStatus: 0, onboardingCompleted: true, accessibilityGranted: true, screenCaptureGranted: false };
    if (command === "get_license_status") return { state: "development", licenseRequired: false, canUseApp: true, plan: null, offlineGrace: false, validationDue: false, lastValidatedAt: null, graceEndsAt: null, message: null };
    if (command === "palette_test_mode") return true;
    if (command === "active_display_menu_icons") return { response: window.testResponse, stale: false, displayId: 1 };
    if (command === "list_menu_icons") return structuredClone(window.testResponse);
    if (command === "get_catalog_customizations") return structuredClone(window.testCatalog);
    if (command === "set_item_customization") {
      Object.assign(window.testCatalog.items[args.itemId], args);
      if (!args.favorite) delete window.testCatalog.pinnedApps[args.itemId];
      return structuredClone(window.testCatalog);
    }
    if (command === "list_menu_actions") return { error: null, actions: [{ id: "settings", title: "Settings…", path: [{ title: "Settings…", occurrence: 0 }], enabled: true, shortcut: null }] };
    if (command === "reopen_pinned_app") {
      if (window.testLaunchFails) throw Error("This app is no longer installed. Install it again or unpin it.");
      window.testCatalog.pinnedApps[offline.itemId].running = true;
      window.testResponse.icons.push(offline);
      return;
    }
    if (command === "activate_menu_icon" || command === "open_settings") return;
    throw Error("Unmocked command: " + command);
  };
});
try {
  await page.goto(process.env.MACNU_UI_URL || "http://127.0.0.1:5173/");
  await page.waitForFunction(() => !!window.testEvents["palette-opened"]);
  await page.evaluate(() => window.testEvents["palette-opened"]({}));
  await page.locator(".result-row").nth(8).waitFor();
  const rows = page.locator(".result-row");
  assert.equal(await rows.count(), 9);
  assert.match(await rows.first().innerText(), /Saved Utility/);
  assert.match(await rows.first().innerText(), /Not running/);
  assert.equal(await page.locator(".icon-grid").count(), 1);
  assert.equal(await page.locator(".result-copy strong").allTextContents().then(x => x.includes("Macnu — Command+Semicolon")), false);
  const search = page.locator(".search-input");
  await search.focus();
  const initialIndex = Number(await page.locator(".result-row.selected").getAttribute("data-index"));
  await search.press("ArrowRight");
  assert.equal(await page.locator(".result-row.selected").getAttribute("data-index"), String(initialIndex + 1));
  const columns = await page.locator(".results").evaluate(el => getComputedStyle(el).gridTemplateColumns.split(" ").length);
  await search.press("ArrowDown");
  assert.equal(await page.locator(".result-row.selected").getAttribute("data-index"), String(Math.min(8, initialIndex + 1 + columns)));
  await search.fill("Monitor");
  assert.equal(await rows.count(), 1);
  assert.match(await rows.first().innerText(), /CPU 28%/);
  await search.press("Tab");
  await page.locator(".action-result").first().waitFor();
  assert.equal(await search.getAttribute("placeholder"), "Search Monitor actions…");
  assert.equal(await page.locator(".icon-grid").count(), 0);
  await search.press("ArrowLeft");
  await search.fill("");
  await page.evaluate(() => {
    localStorage.setItem("macnu.layout", "list");
    window.dispatchEvent(new StorageEvent("storage", { key: "macnu.layout" }));
  });
  assert.equal(await page.locator(".icon-grid").count(), 0);
  await page.evaluate(() => {
    localStorage.setItem("macnu.layout", "grid");
    window.dispatchEvent(new StorageEvent("storage", { key: "macnu.layout" }));
  });
  const tailscale = page.locator(".result-row", { has: page.locator("strong", { hasText: /^Tailscale$/ }) });
  await tailscale.locator("[data-pin-item]").click();
  assert.match(await page.locator(".result-row.selected").innerText(), /Tailscale/);
  await tailscale.locator("[data-pin-item]").click();
  assert.match(await page.locator(".result-row.selected").innerText(), /Tailscale/);
  await tailscale.locator("[data-customize-item]").click();
  await page.locator("[data-record-item-shortcut]").click();
  await page.keyboard.press("Meta+Shift+k");
  await page.locator('form[data-item-customization] button[type="submit"]').click();
  await page.waitForFunction(() => window.testCatalog.items["v1.item-label-role.YXBw.bGFiZWw.cm9sZQ"].shortcut);
  assert.equal(await page.evaluate(() => window.testCatalog.items["v1.item-label-role.YXBw.bGFiZWw.cm9sZQ"].shortcut), "Command+Shift+KeyK");
  await tailscale.locator("[data-customize-item]").click();
  assert.match(await page.locator("[data-record-item-shortcut]").innerText(), /K/);
  await page.keyboard.press("Escape");
  // Pin/unpin and catalog refresh must preserve the recorded direct shortcut.
  for (const favorite of [true, false]) {
    await tailscale.locator("[data-pin-item]").click();
    await page.waitForFunction(expected => window.testCatalog.items["v1.item-label-role.YXBw.bGFiZWw.cm9sZQ"].favorite === expected, favorite);
    assert.equal(await page.evaluate(() => window.testCatalog.items["v1.item-label-role.YXBw.bGFiZWw.cm9sZQ"].shortcut), "Command+Shift+KeyK");
  }
  await page.evaluate(() => window.testEvents["palette-opened"]({}));
  await tailscale.locator("[data-customize-item]").click();
  assert.match(await page.locator("[data-record-item-shortcut]").innerText(), /K/);
  await page.keyboard.press("Escape");
  await page.screenshot({ path: "/tmp/macnu-v0.5-grid.png" });
  await page.setViewportSize({ width: 620, height: 420 });
  await page.evaluate(() => {
    document.documentElement.dataset.appearance = "light";
    document.querySelector(".results").scrollTop = 0;
  });
  assert.equal(await page.locator("footer").evaluate(el => el.scrollWidth <= el.clientWidth), true);
  assert.equal(await page.locator(".results").evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await page.screenshot({ path: "/tmp/macnu-v0.5-grid-light.png" });
  await search.fill("Saved Utility");
  await search.press("Tab");
  assert.equal(await page.locator(".action-result").count(), 0);
  await page.evaluate(() => { window.testLaunchFails = true; });
  await search.press("Enter");
  await page.locator(".action-pin-error").waitFor();
  assert.match(await page.locator(".action-pin-error").innerText(), /no longer installed/);
  await page.evaluate(() => { window.testLaunchFails = false; });
  await search.press("Enter");
  await page.waitForFunction(() => window.testCalls.some(c => c.command === "activate_menu_icon" && c.args.icon.itemId === window.testOffline.itemId));
  assert.equal(await page.evaluate(() => window.testCalls.filter(c => c.command === "reopen_pinned_app").length), 2);
  // Reintroduce the stopped app; leaving its selection must cancel menu activation.
  await page.evaluate(() => {
    window.testResponse.icons = window.testResponse.icons.filter(i => i.itemId !== window.testOffline.itemId);
    window.testCatalog.pinnedApps[window.testOffline.itemId].running = false;
    window.testEvents["palette-opened"]({});
  });
  await search.fill("Saved Utility");
  await page.waitForFunction(() => document.querySelector(".result-copy small")?.textContent === "Not running");
  const activationCount = await page.evaluate(() => window.testCalls.filter(c => c.command === "activate_menu_icon").length);
  await search.press("Enter");
  await search.fill("Tailscale");
  await page.waitForTimeout(900);
  assert.equal(await page.evaluate(() => window.testCalls.filter(c => c.command === "activate_menu_icon").length), activationCount);
  // Hiding the palette also cancels a pending menu, even if selection is unchanged.
  await page.evaluate(() => {
    window.testResponse.icons = window.testResponse.icons.filter(i => i.itemId !== window.testOffline.itemId);
    window.testCatalog.pinnedApps[window.testOffline.itemId].running = false;
    window.testEvents["palette-opened"]({});
  });
  await search.fill("Saved Utility");
  await page.waitForFunction(() => document.querySelector(".result-copy small")?.textContent === "Not running");
  await search.press("Enter");
  await page.evaluate(() => { window.testHidden = true; });
  await page.waitForTimeout(900);
  assert.equal(await page.evaluate(() => window.testCalls.filter(c => c.command === "activate_menu_icon").length), activationCount);
  // Unpinning an offline app removes only that saved entry.
  await page.evaluate(() => {
    window.testResponse.icons = window.testResponse.icons.filter(i => i.itemId !== window.testOffline.itemId);
    window.testCatalog.pinnedApps[window.testOffline.itemId].running = false;
    window.testEvents["palette-opened"]({});
  });
  await search.fill("Saved Utility");
  await page.waitForFunction(() => document.querySelector(".result-copy small")?.textContent === "Not running");
  await page.locator("[data-pin-item]").click();
  await page.waitForFunction(() => document.querySelectorAll(".result-row").length === 0);
  await search.fill("");
  assert.equal(await rows.count(), 8);
  // Repeated catalog delivery shares one personalization read. A newer edit
  // event must also win over an older read already in progress.
  await page.evaluate(() => {
    const base = window.testInvoke;
    window.testHydrations = 0;
    window.testInvoke = async (command, args) => {
      if (command === "get_catalog_customizations") {
        window.testHydrations++;
        const old = structuredClone(window.testCatalog);
        return new Promise(resolve => { window.finishHydration = () => resolve(old); });
      }
      return base(command, args);
    };
    window.restoreHydrationInvoke = () => { window.testInvoke = base; };
    window.testEvents["catalog-customizations-invalidated"]({});
    for (let i = 0; i < 5; i++) window.testEvents["menu-cache-updated"]({ payload: structuredClone(window.testResponse) });
  });
  await page.waitForFunction(() => typeof window.finishHydration === "function");
  assert.equal(await page.evaluate(() => window.testHydrations), 1, "Concurrent catalog reads must coalesce");
  await page.evaluate(() => {
    const id = window.testResponse.icons[0].itemId;
    window.testCatalog.items[id].alias = "Latest alias";
    window.testEvents["catalog-customizations-changed"]({ payload: structuredClone(window.testCatalog) });
    window.finishHydration();
  });
  await page.waitForTimeout(50);
  assert.ok((await page.locator(".result-copy strong").allTextContents()).includes("Latest alias"), "Late reads must not overwrite a newer edit");
  await page.evaluate(() => {
    window.restoreHydrationInvoke();
    window.testCatalog.items[window.testResponse.icons[0].itemId].alias = null;
    window.testEvents["catalog-customizations-changed"]({ payload: structuredClone(window.testCatalog) });
    window.testHydrations = 0;
    const base = window.testInvoke;
    window.testInvoke = async (command, args) => {
      if (command === "get_catalog_customizations") window.testHydrations++;
      return base(command, args);
    };
    for (let i = 0; i < 5; i++) {
      const updated = structuredClone(window.testResponse);
      updated.icons[1].label = "CPU " + i + "%";
      updated.icons[1].image += " ";
      window.testEvents["menu-cache-updated"]({ payload: updated });
    }
  });
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.testHydrations), 0, "Live status/artwork changes must not reload personalization");
  // An inactive monitor can supply a provisional catalog before AX follows
  // focus. Keep its icons visible, then accept the local snapshot without
  // clearing the search or selecting a different row.
  await page.evaluate(() => {
    const baseInvoke = window.testInvoke;
    window.testResponse = { ...window.testResponse, displayId: 2, geometryPending: true };
    window.testFreshResponse = { ...window.testResponse, geometryPending: false };
    window.testSwitchScans = 0;
    window.testInvoke = async (command, args) => {
      if (command === "active_display_menu_icons") {
        return { response: window.testResponse, stale: window.testResponse.geometryPending, displayId: 2 };
      }
      if (command === "list_menu_icons") {
        window.testSwitchScans++;
        return new Promise(resolve => { window.finishDisplayScan = () => {
          window.testResponse = window.testFreshResponse;
          resolve(structuredClone(window.testFreshResponse));
        }; });
      }
      return baseInvoke(command, args);
    };
    window.testEvents["palette-opened"]({});
  });
  await page.waitForFunction(() => window.testSwitchScans === 1);
  assert.equal(await rows.count(), 8, "Provisional monitor icons must stay visible");
  await search.fill("Tailscale");
  await page.evaluate(() => window.finishDisplayScan());
  await page.waitForFunction(() => window.testResponse.geometryPending === false);
  await page.evaluate(() => window.testEvents["palette-display-settled"]({}));
  await page.waitForTimeout(100);
  assert.equal(await search.inputValue(), "Tailscale");
  assert.equal(await rows.count(), 1);
  assert.equal(await page.evaluate(() => window.testSwitchScans), 1, "Settled warm catalog must not rescan");
  // Some apps never report destination-local AX geometry. One focus-settle
  // invalidation may refresh, but uncertainty alone must not cause a retry loop.
  await page.evaluate(() => {
    window.testResponse = { ...window.testResponse, geometryPending: true };
    const base = window.testInvoke;
    window.testSwitchScans = 0;
    window.testInvoke = async (command, args) => {
      if (command === "active_display_menu_icons")
        return { response: window.testResponse, stale: true, displayId: 2 };
      if (command === "list_menu_icons") {
        window.testSwitchScans++;
        return structuredClone(window.testResponse);
      }
      return base(command, args);
    };
    window.testEvents["palette-display-settled"]({});
  });
  await page.waitForTimeout(750);
  assert.equal(await page.evaluate(() => window.testSwitchScans), 1, "Persistent AX uncertainty must not trigger a scan loop");
  assert.equal(await search.inputValue(), "Tailscale");
  await page.setViewportSize({ width: 650, height: 450 });
  await page.goto((process.env.MACNU_UI_URL || "http://127.0.0.1:5173/") + "?window=settings");
  await page.locator('[data-layout="list"]').click();
  assert.equal(await page.locator('[data-layout="list"]').getAttribute("aria-pressed"), "true");
  assert.equal(await page.evaluate(() => localStorage.getItem("macnu.layout")), "list");
  await page.reload();
  await page.locator('[data-layout="list"][aria-pressed="true"]').waitFor();
  await page.locator('[data-layout="grid"]').click();
  assert.equal(await page.locator('[data-layout="grid"]').getAttribute("aria-pressed"), "true");
  await page.screenshot({ path: "/tmp/macnu-v0.5-settings.png" });
  assert.deepEqual(errors, []);
  console.log("Browser checks passed: grid/list, navigation, status, Macnu title, Actions, pin identity, unavailable app, reopen-to-menu, provisional monitor cache and focus settling.");
} finally { await browser.close(); }
