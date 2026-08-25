<p align="center">
  <img src="src-tauri/icons/macnu-logo.png" width="144" alt="Macnu macOS menu bar launcher icon">
</p>

# Macnu

**Search and open macOS menu bar icons from the keyboard.**

Macnu is a fast macOS menu bar manager and keyboard launcher for crowded menu
bars. Search menu bar icons by name, open their original menus and popovers,
and reach items hidden behind a MacBook notch. Macnu works on the display you
are using, including multi-monitor Mac setups.

## Features

- Search menu bar apps and system status items from one palette.
- Open each item's original menu or popover without moving icons.
- Find hidden menu bar icons behind the MacBook notch or crowded app menus.
- Launch Macnu on the active display with a customizable keyboard shortcut.
- Cache discovered items and refresh the menu bar catalog in the background.
- Match macOS light mode, dark mode, or the current system appearance.
- Start Macnu at login and keep the launcher available from the menu bar.

Macnu supports macOS 14 Sonoma or newer on Apple silicon and Intel Macs.

## Download and licenses

[Download the latest signed and notarized Macnu DMG from GitHub Releases](https://github.com/sohaibilyas/macnu/releases/latest).

Macnu offers two license options:

- [Personal License](https://qoest.lemonsqueezy.com/checkout/buy/12e893f2-c4df-423e-b2b1-b6b7f24bd07d?enabled=2046255) for personal, noncommercial use on up to two Macs.
- [Business License](https://qoest.lemonsqueezy.com/checkout/buy/fc6c40ec-376e-4fc5-806b-830a56ab3790?enabled=2046262) for work or company use on up to two Macs per seat.

## Using Macnu

Click the Macnu menu bar icon or press **Command + Semicolon**.

1. Type to filter menu bar items.
2. Use the arrow keys to select a result.
3. Press Enter to open its menu or popover.
4. Press Escape, use the shortcut again, or click elsewhere to close Macnu.

Settings lets you change the shortcut and appearance, enable Start at Login,
manage your license, and check for updates.

## Permissions and privacy

Macnu needs Accessibility permission to discover menu bar items by name and
open the item you select. Screen Recording permission is optional. It lets
Macnu capture menu bar artwork; without it, Macnu uses application icons or a
neutral fallback.

Macnu processes the menu bar catalog and captured artwork on your Mac. The
official app contacts the licensing service when you activate a license and
periodically validates it. It checks GitHub for updates automatically and when
you request a manual check.

## Build from source

You need macOS 14 or newer, Node.js, Rust, Cargo, and Xcode Command Line Tools.

Install dependencies and start the development build:

```sh
npm install
npm run tauri dev
```

Build a local source bundle:

```sh
npm run build:app
```

Macnu writes the app bundle under
`src-tauri/target/release/bundle/macos`. Source builds use a local ad hoc
signature, do not require a paid license, and cannot use the official update
channel. Do not distribute a source build as an official Macnu release.

Run the main verification commands:

```sh
npm run build
npm run test:rust:source
swift test --package-path src-tauri/native
npm --prefix services/lemon-webhook run check
```

## Official releases

GitHub Releases hosts the official universal macOS downloads. Apple signs and
notarizes each customer build. Macnu verifies the signed update manifest,
downloaded archive, bundle identity, version, architectures, and Apple
notarization before it installs an update.

The maintainer keeps signing credentials and private publication instructions
outside this repository.

## License

The [PolyForm Noncommercial License 1.0.0](LICENSE) covers the Macnu source
code. You may use, modify, and share the source for personal and other
noncommercial purposes. Commercial use requires a separate license from the
copyright holder.
