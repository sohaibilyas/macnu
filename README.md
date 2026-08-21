# Macnu

Macnu is a small Tauri utility for crowded macOS menu bars. It mirrors the
real status-item windows—including items positioned behind the camera
notch—into a fast, searchable launcher.

## Development

```sh
npm install
npm run tauri dev
```

On first launch, Macnu guides you through granting **Accessibility** under
**System Settings → Privacy & Security**. This permission is required to find
and activate menu-bar items. Screen Recording is optional and is used only to
show captured menu-bar artwork; Macnu remains functional with application or
neutral fallback icons when it is not granted.

Macnu stays available as a native status item in the top bar. Click its `M`
icon or press **Command + Semicolon (`⌘;`)** to open the launcher. Type to filter,
use the arrow keys to choose an item, then press Enter to activate its original
menu or popover. Press the shortcut again—or Escape—to close the launcher.

Open **Settings** from the launcher footer or the status-item menu to change
the global shortcut and enable Start at Login. macOS requires the packaged app
to be moved into **Applications** before it can be registered as a login item.

## Build

Build the local development app bundle with an ad-hoc signature and stable
designated requirement so macOS Accessibility permission survives subsequent
local rebuilds:

```bash
npm run build:app
```

The packaged app is written to `src-tauri/target/release/bundle/macos`.
Production releases must instead use a Developer ID signature and Apple
notarization.

## License

Macnu is source-available under the
[PolyForm Noncommercial License 1.0.0](LICENSE). You may use, study, modify,
and share it for purposes permitted by that license. This is not an
OSI-approved open-source license because it does not permit commercial use.

Commercial use requires a separate written license from Sohaib Ilyas. See
[LICENSING.md](LICENSING.md). The [Macnu name and branding](TRADEMARKS.md),
Apple signing credentials, and update-signing private keys remain reserved.
