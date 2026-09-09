import { describe, expect, it, vi } from "vitest";
import { createSettingsPreview } from "./settings-preview";

type Invoke = typeof import("@tauri-apps/api/core").invoke;
const version = async () => "0.5.2";

describe("local settings preview", () => {
  it("leaves normal builds untouched", async () => {
    const native = vi.fn();
    const preview = await createSettingsPreview(native as Invoke, false, version);
    expect(preview).toEqual({ invoke: native, preview: false });
    expect(native).not.toHaveBeenCalled();
  });

  it.each([
    { state: "unlicensed", licenseRequired: true },
    { state: "licensed", licenseRequired: true },
    { state: "development", licenseRequired: true },
  ])("never substitutes official license status: %j", async status => {
    const native = vi.fn().mockResolvedValue(status);
    const preview = await createSettingsPreview(native as Invoke, true, version);
    expect(preview).toEqual({ invoke: native, preview: false });
  });

  it("shows sample panels without sending license or update actions to native services", async () => {
    const native = vi.fn().mockResolvedValue({ state: "development", licenseRequired: false });
    const preview = await createSettingsPreview(native as Invoke, true, version);
    expect(preview.preview).toBe(true);
    expect(await preview.invoke("get_license_status")).toMatchObject({ canUseApp: true, plan: "personal" });
    expect(await preview.invoke("get_update_status")).toMatchObject({ supported: true, result: { available: true } });
    expect(await preview.invoke("set_automatic_update_checks", { enabled: false })).toMatchObject({ automaticChecks: false });
    await preview.invoke("refresh_license");
    await preview.invoke("activate_license", { licenseKey: "sample" });
    await preview.invoke("deactivate_license");
    await preview.invoke("check_for_updates");
    await expect(preview.invoke("install_update")).rejects.toThrow("no update was downloaded or installed");
    expect(native.mock.calls).toEqual([["get_license_status"]]);
    await preview.invoke("get_settings");
    expect(native).toHaveBeenLastCalledWith("get_settings", undefined, undefined);
  });
});
