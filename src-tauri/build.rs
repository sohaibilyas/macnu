fn main() {
    #[cfg(target_os = "macos")]
    {
        // Swift's build engine now uses out/Products/<configuration>, while
        // swift-rs assumes the older <arch>-apple-macosx/<configuration> path.
        // Ask Swift for its actual output first so an old cached archive can
        // never take precedence over the library we are about to build.
        let configuration = if std::env::var("DEBUG").as_deref() == Ok("true") {
            "debug"
        } else {
            "release"
        };
        let arch = match std::env::consts::ARCH {
            "aarch64" => "arm64",
            arch => arch,
        };
        let build_path = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap())
            .join("swift-rs/MacnuNative");
        let output = std::process::Command::new("swift")
            .current_dir("native")
            .args([
                "build",
                "--show-bin-path",
                "-c",
                configuration,
                "--arch",
                arch,
            ])
            .arg("--build-path")
            .arg(&build_path)
            .output()
            .expect("Could not ask Swift for its native library output path");
        assert!(
            output.status.success(),
            "Could not locate the Swift build output: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let output_path = String::from_utf8(output.stdout).expect("Invalid Swift output path");
        assert!(
            !output_path.trim().is_empty(),
            "Swift returned an empty output path"
        );
        let output_path = std::path::Path::new(output_path.trim());
        println!("cargo:rustc-link-search=native={}", output_path.display());

        swift_rs::SwiftLinker::new("14.0")
            .with_package("MacnuNative", "native")
            .link();
        assert!(
            output_path.join("libMacnuNative.a").is_file(),
            "Swift did not build MacnuNative in its reported output directory"
        );
    }

    tauri_build::build()
}
