fn main() {
    #[cfg(target_os = "macos")]
    {
        // swift-rs still supplies the runtime libraries, but its package builder
        // uses the host architecture and assumes Swift's old output layout.
        // Build the package with Cargo's target and ask Swift for its real path.
        swift_rs::SwiftLinker::new("14.0").link();

        let configuration = if std::env::var("DEBUG").as_deref() == Ok("true") {
            "debug"
        } else {
            "release"
        };
        let cargo_arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap();
        let arch = match cargo_arch.as_str() {
            "aarch64" => "arm64",
            "x86_64" => "x86_64",
            arch => panic!("Unsupported Macnu native architecture: {arch}"),
        };
        let triple = format!("{arch}-apple-macosx14.0");
        let sdk = std::process::Command::new("xcrun")
            .args(["--sdk", "macosx", "--show-sdk-path"])
            .output()
            .expect("Could not locate the macOS SDK");
        assert!(
            sdk.status.success(),
            "Could not locate the macOS SDK: {}",
            String::from_utf8_lossy(&sdk.stderr)
        );
        let sdk = String::from_utf8(sdk.stdout).expect("Invalid macOS SDK path");
        let package_path =
            std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
                .join("native");
        let build_path =
            std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("macnu-native");
        let build_command = || {
            let mut command = std::process::Command::new("swift");
            command
                .current_dir(&package_path)
                .args([
                    "build",
                    "--configuration",
                    configuration,
                    "--triple",
                    &triple,
                    "--sdk",
                    sdk.trim(),
                    "--product",
                    "MacnuNative",
                ])
                .arg("--scratch-path")
                .arg(&build_path);
            command
        };
        let output = build_command()
            .arg("--show-bin-path")
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
        assert!(
            build_command()
                .status()
                .expect("Could not build MacnuNative")
                .success(),
            "Swift failed to build MacnuNative for {triple}"
        );
        let archive = output_path.join("libMacnuNative.a");
        assert!(
            archive.is_file(),
            "Swift did not build MacnuNative in its reported output directory"
        );
        let architectures = std::process::Command::new("lipo")
            .arg("-archs")
            .arg(&archive)
            .output()
            .expect("Could not verify the MacnuNative archive architecture");
        assert!(
            architectures.status.success()
                && String::from_utf8_lossy(&architectures.stdout).trim() == arch,
            "MacnuNative must contain only {arch}, found: {} {}",
            String::from_utf8_lossy(&architectures.stdout).trim(),
            String::from_utf8_lossy(&architectures.stderr).trim()
        );
        println!("cargo:rerun-if-changed={}", package_path.display());
        println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");
        println!("cargo:rustc-link-search=native={}", output_path.display());
        println!("cargo:rustc-link-lib=static=MacnuNative");
    }

    tauri_build::build()
}
