fn main() {
    #[cfg(target_os = "macos")]
    swift_rs::SwiftLinker::new("14.0")
        .with_package("MacnuNative", "native")
        .link();

    tauri_build::build()
}
