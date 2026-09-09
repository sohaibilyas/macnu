type Invoke = typeof import("@tauri-apps/api/core").invoke;

// Only the opt-in source build substitutes Settings responses. The native app
// remains a source build, and official builds always keep their real licensing.
export async function createSettingsPreview(
  nativeInvoke: Invoke, enabled: boolean, getVersion: () => Promise<string>,
): Promise<{ invoke: Invoke; preview: boolean }> {
  if (!enabled) return { invoke: nativeInvoke, preview: false };
  const actual = await nativeInvoke<{ state: string; licenseRequired: boolean }>("get_license_status");
  if (actual.state !== "development" || actual.licenseRequired) {
    return { invoke: nativeInvoke, preview: false };
  }
  const currentVersion = await getVersion();
  const license = {
    state: "licensed", licenseRequired: true, canUseApp: true, plan: "personal",
    offlineGrace: false, validationDue: false, lastValidatedAt: null,
    graceEndsAt: null, message: "UI preview — sample license; no activation needed.",
  };
  const result = {
    supported: true, available: true, currentVersion,
    version: currentVersion.replace(/\d+$/, patch => String(Number(patch) + 1)),
    notes: "Sample release notes for comparing the update controls. No update will be installed.",
  };
  const updates = {
    supported: true, automaticChecks: true, checking: false,
    checkedAt: null as number | null, result, revision: 0,
  };
  const invoke: Invoke = async <T>(command: string, args?: Parameters<Invoke>[1], options?: Parameters<Invoke>[2]): Promise<T> => {
    switch (command) {
      case "get_license_status":
      case "refresh_license":
        return { ...license } as T;
      case "deactivate_license":
        return { ...license, message: "UI preview — no license was deactivated." } as T;
      case "activate_license":
        return { ...license } as T;
      case "get_update_status":
        return structuredClone(updates) as T;
      case "set_automatic_update_checks":
        updates.automaticChecks = Boolean((args as { enabled?: boolean })?.enabled);
        updates.revision++;
        return structuredClone(updates) as T;
      case "check_for_updates":
        updates.checkedAt = Math.floor(Date.now() / 1000);
        updates.revision++;
        return { ...result } as T;
      case "install_update":
        throw new Error("UI preview — no update was downloaded or installed.");
      default:
        return nativeInvoke<T>(command, args, options);
    }
  };
  return { invoke, preview: true };
}
