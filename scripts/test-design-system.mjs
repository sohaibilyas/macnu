import assert from "node:assert/strict";

export async function verifyPaletteDesign(page) {
  await page.setViewportSize({ width: 620, height: 420 });
  const search = page.locator(".search-input");
  await search.fill("Tailscale");
  for (const layout of ["list", "grid"]) {
    await page.evaluate(layout => {
      localStorage.setItem("macnu.layout", layout);
      window.dispatchEvent(new StorageEvent("storage", { key: "macnu.layout" }));
    }, layout);
    await page.locator("[data-customize-item]").first().click();
    const editor = page.locator("[data-item-customization]");
    await editor.waitFor();
    await page.locator("[data-record-item-shortcut]").click();
    await page.keyboard.press("k");
    await page.locator(".item-customization-message.error").waitFor();
    assert.equal(await page.locator(".item-customization-message.error").textContent(), "Use a modifier with another key.");
    const violations = await editor.evaluate(el => {
      const problems = [];
      if (el.scrollWidth > el.clientWidth + 1) problems.push("editor horizontal overflow");
      for (const button of el.querySelectorAll("button")) {
        if (!button.getClientRects().length) continue;
        const style = getComputedStyle(button);
        if (style.minHeight !== "32px" || style.borderRadius !== "10px" ||
            style.fontSize !== "11px" || style.paddingLeft !== "12px")
          problems.push("editor control mismatch " + button.className);
      }
      if (getComputedStyle(el.querySelector(".item-customization-heading small")).fontSize !== "11px")
        problems.push("editor helper mismatch");
      return problems;
    });
    assert.deepEqual(violations, [], layout);
    await editor.locator('[type="submit"]').scrollIntoViewIfNeeded();
    const button = await editor.locator('[type="submit"]').boundingBox();
    assert.ok(button.y >= 68 && button.y + button.height < 380, "Save remains reachable inside the scrolling results");
    await page.screenshot({ path: "/tmp/macnu-design-editor-" + layout + ".png", scale: "css" });
    await page.locator("[data-cancel-item-customization]").click();
    for (const control of [".settings-button", ".refresh"]) {
      const metrics = await page.locator(control).evaluate(el => ({
        whiteSpace: getComputedStyle(el).whiteSpace,
        height: el.getBoundingClientRect().height,
        clipped: el.scrollWidth > el.clientWidth + 1,
      }));
      assert.equal(metrics.whiteSpace, "nowrap", control);
      assert.equal(metrics.height, 28, control);
      assert.equal(metrics.clipped, false, control);
    }
    const footerOverlaps = await page.locator("footer").evaluate(el => {
      const nodes = [...el.children].filter(n => n.getClientRects().length);
      const rectangles = nodes.map(n => n.getBoundingClientRect());
      return rectangles.some((r, i) => i > 0 && r.left < rectangles[i - 1].right - 1);
    });
    assert.equal(footerOverlaps, false, layout + " footer groups overlap");
  }
  await search.focus();
  await search.press("Tab");
  await page.locator(".action-result").first().waitFor();
  await page.locator(".pin-action").click();
  await page.locator(".action-pin-error").waitFor(); // unsupported save in the IPC fixture
  assert.equal(await page.locator(".action-pin-error").evaluate(el => getComputedStyle(el).fontSize), "11px");
  assert.equal(await page.locator(".results").evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
  await page.screenshot({ path: "/tmp/macnu-design-action-error.png", scale: "css" });
}


// Uses the same IPC mocks as test-menu-hub; never activates licenses,
// installs updates, or changes real macOS permissions.
export async function verifyDesignSystem(page) {
  const panels = ["general", "personalization", "permissions", "updates", "license"];
  const helperSelectors = [".settings-copy p", ".setting-label small",
    ".permission-setting-copy small", ".update-state-copy small", ".license-summary-heading small"];
  for (const theme of ["dark", "light"]) {
    for (const size of [{ width: 650, height: 450 }, { width: 560, height: 400 }]) {
      await page.setViewportSize(size);
      await page.evaluate(theme => { document.documentElement.dataset.appearance = theme; }, theme);
      for (const panel of panels) {
        await page.locator('[data-settings-view="' + panel + '"]').click();
        const surface = page.locator("#" + panel + "-panel");
        const issues = await surface.evaluate((el, helperSelectors) => {
          const issues = [];
          const visible = node => node.getClientRects().length > 0;
          if (el.scrollWidth > el.clientWidth + 1) issues.push("horizontal panel overflow");
          for (const node of el.querySelectorAll(helperSelectors.join(","))) {
            if (!visible(node)) continue;
            const css = getComputedStyle(node);
            if (css.fontSize !== "11px" || Math.abs(parseFloat(css.lineHeight) - 15.95) > 0.1)
              issues.push("inconsistent helper: " + node.className + " " + css.fontSize + "/" + css.lineHeight);
          }
          for (const node of el.querySelectorAll(".primary-action, .secondary-action, .danger-action, .permission-recheck, .shortcut-reset, .shortcut-recorder")) {
            if (!visible(node)) continue;
            const css = getComputedStyle(node);
            if (css.minHeight !== "32px" || css.borderRadius !== "10px" || css.fontSize !== "11px" ||
                css.paddingLeft !== "12px" || css.paddingRight !== "12px")
              issues.push("inconsistent button: " + node.className + " " + [css.minHeight, css.borderRadius, css.fontSize, css.paddingLeft, css.paddingRight].join("/"));
            if (node.scrollWidth > node.clientWidth + 1) issues.push("clipped button: " + node.textContent);
          }
          for (const node of el.querySelectorAll(".setting-label, .permission-setting-copy, .update-state-copy")) {
            if (!visible(node)) continue;
            if (getComputedStyle(node).gap !== "6px") issues.push("inconsistent title/helper gap");
          }
          const pane = el.getBoundingClientRect();
          for (const node of el.querySelectorAll("button, .setting-label, .permission-setting-copy, input:not([type=checkbox])")) {
            if (!visible(node)) continue;
            const rect = node.getBoundingClientRect();
            if (rect.left < pane.left - 1 || rect.right > pane.right + 1)
              issues.push("control outside pane: " + node.className);
          }
          return issues;
        }, helperSelectors);
        assert.deepEqual(issues, [], theme + " " + size.width + " " + panel);
        if (size.width === 650) await page.screenshot({ path: "/tmp/macnu-design-" + theme + "-" + panel + ".png", scale: "css" });
      }
    }
  }

  // Failures and subsequent success messages use the same status renderer.
  await page.locator('[data-settings-view="personalization"]').click();
  await page.locator("[data-reset-personalization-history]").click();
  await page.locator(".personalization-status.error").waitFor();
  await page.evaluate(() => window.testEvents["personalization-history-reset"]({}));
  assert.equal(await page.locator(".personalization-status").evaluate(el => el.classList.contains("error")), false);

  // Long, unbroken error details must wrap without pushing actions off-screen.
  await page.setViewportSize({ width: 650, height: 450 });
  await page.locator('[data-settings-view="updates"]').click();
  await page.evaluate(() => {
    document.documentElement.dataset.appearance = "dark";
    const status = document.querySelector("[data-automatic-update-status]");
    status.textContent = "Could not save this setting. " + "LongDiagnosticValue".repeat(20);
    document.querySelector("[data-update-status]").textContent = "Unable to check right now. " + "Connection unavailable. ".repeat(12);
    document.querySelector("[data-update-status]").classList.add("error");
  });
  const errorLayout = await page.locator("#updates-panel").evaluate(el => {
    const error = el.querySelector("[data-automatic-update-status]");
    const card = el.querySelector(".update-card");
    return {
      overflow: el.scrollWidth > el.clientWidth + 1,
      errorWraps: error.getBoundingClientRect().height > 32,
      gap: card.getBoundingClientRect().top - error.getBoundingClientRect().bottom,
      sameColor: getComputedStyle(error).color === getComputedStyle(el.querySelector("[data-update-status]")).color,
    };
  });
  assert.equal(errorLayout.overflow, false);
  assert.equal(errorLayout.errorWraps, true);
  assert.equal(errorLayout.gap, 16);
  assert.equal(errorLayout.sameColor, true);
  await page.locator("[data-install-update]").scrollIntoViewIfNeeded();
  assert.equal(await page.locator("[data-install-update]").isVisible(), true);
  await page.screenshot({ path: "/tmp/macnu-design-errors.png", scale: "css" });

  // The tile never rotates, even while the inner update glyph does.
  await page.evaluate(() => document.querySelector(".update-card").classList.add("checking"));
  assert.equal(await page.locator(".update-state-mark").evaluate(el => getComputedStyle(el).transform), "none");
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.locator(".update-state-glyph").evaluate(el => getComputedStyle(el).animationName), "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => {
    document.querySelector(".update-card").classList.remove("checking");
    document.querySelector("[data-automatic-update-status]").textContent = "";
  });
  assert.equal(await page.locator("[data-automatic-update-status]").evaluate(el => el.getBoundingClientRect().height), 0);

  // Disabled actions keep their geometry and don't use an indefinite busy cursor.
  const check = page.locator("[data-check-updates]");
  await check.evaluate(el => { el.disabled = false; });
  const before = await check.boundingBox();
  await check.evaluate(el => { el.disabled = true; });
  assert.deepEqual(await check.boundingBox(), before);
  assert.equal(await check.evaluate(el => getComputedStyle(el).cursor), "default");
  await check.evaluate(el => { el.disabled = false; });
  await page.keyboard.press("Tab");
  await check.focus();
  assert.equal(await check.evaluate(el => getComputedStyle(el).outlineStyle), "solid");

  // At increased text size, the panels still scroll and controls stay inside.
  await page.evaluate(() => { document.documentElement.style.zoom = "1.25"; });
  for (const panel of panels) {
    await page.locator('[data-settings-view="' + panel + '"]').click();
    assert.equal(await page.locator("#" + panel + "-panel").evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, "Zoom overflow: " + panel);
  }
  await page.evaluate(() => { document.documentElement.style.zoom = ""; });

  // License and permissions gates use real markup, with synthetic visible states.
  // No command is invoked by these fixtures.
  for (const gate of [".license-gate", ".onboarding.permission-gate"]) {
    await page.setViewportSize({ width: 650, height: 360 });
    await page.evaluate(gate => {
      document.querySelector(".settings-layout").hidden = true;
      document.querySelector(".license-gate").hidden = gate !== ".license-gate";
      document.querySelector(".onboarding").hidden = gate === ".license-gate";
      if (gate === ".license-gate") {
        document.querySelector(".business-seat-picker").hidden = false;
        document.querySelector(".license-gate-error").textContent = "Please check your license key. " + "LongError".repeat(25);
      } else {
        document.querySelector(".onboarding-error").textContent = "Unable to open Settings. " + "LongError".repeat(25);
      }
    }, gate);
    const surface = page.locator(gate);
    assert.equal(await surface.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, gate);
    const lastAction = surface.locator("button:visible").last();
    await lastAction.scrollIntoViewIfNeeded();
    const rect = await lastAction.boundingBox();
    assert.ok(rect.y >= 0 && rect.y + rect.height <= 360, "Gate action must remain reachable");
    await page.screenshot({ path: "/tmp/macnu-design-" + (gate === ".license-gate" ? "license-gate" : "permission-gate") + ".png", scale: "css" });
  }
  console.log("Design checks passed: five panels, both themes, compact windows, zoom, helpers, button geometry, long errors, disabled/focus states, reduced motion, and scrollable setup gates.");
}
