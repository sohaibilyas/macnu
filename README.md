# Macnu

Macnu is a small Tauri utility for crowded macOS menu bars. It mirrors the
real status-item windows—including items positioned behind the camera
notch—into a fast, searchable launcher.

## Development

```sh
npm install
npm run tauri dev
```

On first launch, allow Macnu under **System Settings → Privacy & Security →
Screen Recording**, then reopen it. macOS requires this permission so
ScreenCaptureKit can mirror the real icon artwork. Allow **Accessibility** when
you first click an icon so Macnu can activate the original status item.

Macnu stays available as a native status item in the top bar. Click its `M`
icon or press **Command + Semicolon (`⌘;`)** to open the launcher. Type to filter,
use the arrow keys to choose an item, then press Enter to activate its original
menu or popover. Press the shortcut again—or Escape—to close the launcher.

Open **Settings** from the launcher footer or the status-item menu to change
the global shortcut and enable Start at Login. macOS requires the packaged app
to be moved into **Applications** before it can be registered as a login item.

## Build

Build the app bundle with a stable local designated requirement so macOS
Accessibility permission survives subsequent local rebuilds:

```bash
npm run build:app
```

The packaged app is written to `src-tauri/target/release/bundle/macos`.
