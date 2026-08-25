# Macnu patch to Tauri updater 2.10.1

This directory is the minimal source distribution of
`tauri-plugin-updater` 2.10.1, licensed upstream under Apache-2.0 OR MIT.
The original license files are included unchanged.

Macnu carries two defense-in-depth changes in `src/updater.rs` and
`src/lib.rs`:

- reject update manifests above 64 KiB before buffering or JSON parsing;
- reject fallback updater downloads above 512 MiB before buffering; and
- test that a rejected chunk is never appended; and
- do not register upstream's raw updater IPC commands, so every install must go
  through Macnu's stricter Rust policy.

The application also uses its own bounded download and verifies the updater
signature, archive layout, bundle metadata, Apple signing identity,
notarization, architectures, and version before installation. The vendored cap
is still required because upstream 2.10.1's `Updater::check` otherwise buffers
an unbounded `latest.json` before Macnu receives it.

When upgrading upstream, replace this directory from the new crate source,
reapply the bounded-response patch, review the complete diff, and run both
Macnu Rust test modes plus the release verifier.
