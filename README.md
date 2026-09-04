<p align="center">
  <img src="src-tauri/icons/macnu-logo.png" width="144" alt="Macnu macOS menu bar launcher icon">
</p>

# Macnu

**Search, open, and run macOS menu bar actions from the keyboard.**

Macnu is a fast macOS menu bar manager and keyboard command launcher for
crowded menu bars. Search apps, system status items, and saved menu commands by
name, open their original menus and popovers, run supported commands without
reaching for the mouse, and reach items hidden behind a MacBook notch. Macnu
works on the display you are using, including multi-monitor Mac setups.

## Features

- Search menu bar apps and system status items from one palette.
- Open each item's original menu or popover without moving icons.
- Press Tab or Right Arrow to search exposed standard menu actions without opening the native menu.
- Find hidden menu bar icons behind the MacBook notch or crowded app menus.
- Launch Macnu on the active display with a customizable keyboard shortcut.
- Pin menu bar icons so they appear first before you type, without changing fuzzy-search relevance, and add local aliases to items Macnu can identify reliably.
- Assign direct global shortcuts when an app exposes a durable menu bar item identifier.
- Use Smart ordering to bring frequently and recently opened items forward on each display.
- Switch between Smart, menu bar, and alphabetical ordering or reset local usage history at any time.
- Pin supported commands inside each app’s Actions view so those actions appear first there before you type.
- Hide noisy items from Macnu search without deleting their pins, aliases, or shortcuts, then restore hidden items from Settings.
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

1. Type to search menu bar icons.
2. Use the arrow keys to select a result.
3. Press Enter to open an item.
4. Press Tab or Right Arrow to browse an item's standard menu actions.
5. In Actions, press Enter to run a command, use its pin or Command + P to pin or unpin it, or press Left Arrow to return. Pinned actions appear first while the Actions search is empty.
6. Use the pin beside a main icon, or press Command + P, to keep it at the top before searching. Use the three-dot menu for aliases, visibility, and direct shortcuts.
7. Press Escape, use the shortcut again, or click elsewhere to close Macnu.

Macnu never clicks a status item merely to discover its actions. Apps that
build commands only after a click, including custom popovers, use the original
menu fallback instead.

Settings lets you change the launcher shortcut and appearance, choose how
results are ordered, control per-display personalization, manage pinned actions
and hidden search items, enable Start at Login, manage your license, and check
for updates.

## Permissions and privacy

Macnu needs Accessibility permission to discover menu bar items by name and
open the item you select. Screen Recording permission is optional. It lets
Macnu capture menu bar artwork; without it, Macnu uses application icons or a
neutral fallback.

When you open Actions, Macnu briefly inspects only the selected status item. It
caches command names and descriptive menu paths for a short time, never raw
Accessibility objects. Before running any action, including a pinned action or
its direct shortcut, Macnu resolves the current status item and reads its live
menu again. It runs the command only when the saved identifier and path match
one enabled live command. Macnu refuses the request if the item is missing, the
command changed, the match is ambiguous, or the command is disabled.

Macnu processes the menu bar catalog and captured artwork on your Mac. The
official app contacts the licensing service when you activate a license and
periodically validates it. It checks GitHub for updates automatically and when
you request a manual check.

Aliases, pins, hidden-search state, pinned actions, direct shortcuts, and Smart
ordering history stay in Macnu's local app data. Pinned actions contain
the parent item identity and command path needed to find the command again. You
can clear usage history, unpin actions, and restore hidden items from
Settings.

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
npm run test:ui
npm run test:rust:source
swift test --package-path src-tauri/native
npm --prefix services/lemon-webhook run check
```

## Official releases

GitHub Releases hosts the official universal macOS downloads. Macnu’s developer
signs each customer build with Developer ID, and Apple notarizes it. Macnu
verifies the updater archive signature, downloaded archive, bundle identity,
version, architectures, and Apple notarization before it installs an update.

The maintainer keeps signing credentials and private publication instructions
outside this repository.

## License

The [PolyForm Noncommercial License 1.0.0](LICENSE) covers the Macnu source
code. You may use, modify, and share the source for personal and other
noncommercial purposes. Commercial use requires a separate license from the
copyright holder.
