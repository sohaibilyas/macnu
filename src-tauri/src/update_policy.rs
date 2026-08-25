use base64::{engine::general_purpose::STANDARD, Engine as _};
use flate2::read::GzDecoder;
use minisign_verify::{PublicKey, Signature};
use semver::Version;
use std::{
    ffi::OsStr,
    io::Cursor,
    path::{Component, Path},
    process::{Command, Output},
};

pub(crate) const UPDATE_ARCHIVE_LIMIT: usize = 512 * 1024 * 1024;
pub(crate) const UPDATE_SIGNATURE_LIMIT: usize = 16 * 1024;
const UPDATE_ENTRY_LIMIT: usize = 20_000;
const UPDATE_UNPACKED_LIMIT: u64 = 1_024 * 1024 * 1024;

const EXPECTED_BUNDLE_ID: &str = "com.qoest.macnu";
const EXPECTED_TEAM_ID: &str = "UVYJU3MY6G";
const EXPECTED_DISTRIBUTION: &str = "official";
const EXPECTED_CHANNEL: &str = "stable";
const EXPECTED_EXECUTABLE: &str = "macnu";
const EXPECTED_PUBLIC_KEY_BASE64: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDI4N0VDRjcwMjM1MDRGQkUKUldTK1QxQWpjTTkrS0h3THZ6L2UzWkZuVGwvVVZNOGJWMVgxbjFiOEJiZ09MTHFSRGlaK21uazAK";

pub(crate) fn is_stable_upgrade(current: &Version, remote: &Version) -> bool {
    remote.pre.is_empty() && remote.build.is_empty() && current.pre.is_empty() && remote > current
}

fn decode_signature_box(encoded: &str, label: &str) -> Result<String, String> {
    let decoded = STANDARD
        .decode(encoded.trim())
        .map_err(|_| format!("The {label} is not valid base64."))?;
    String::from_utf8(decoded).map_err(|_| format!("The {label} is not valid UTF-8."))
}

pub(crate) fn verify_update_signature(bytes: &[u8], encoded_signature: &str) -> Result<(), String> {
    let encoded_signature = encoded_signature.trim();
    if encoded_signature.is_empty() || encoded_signature.len() > UPDATE_SIGNATURE_LIMIT {
        return Err("The updater signature has an invalid size.".to_string());
    }

    let public_key_box = decode_signature_box(EXPECTED_PUBLIC_KEY_BASE64, "updater public key")?;
    let signature_box = decode_signature_box(encoded_signature, "updater signature")?;
    let public_key = PublicKey::decode(&public_key_box)
        .map_err(|_| "The updater public key is invalid.".to_string())?;
    let signature = Signature::decode(&signature_box)
        .map_err(|_| "The updater signature is invalid.".to_string())?;
    public_key
        .verify(bytes, &signature, true)
        .map_err(|_| "The updater signature does not match the downloaded file.".to_string())
}

fn command_output(command: &str, output: std::io::Result<Output>) -> Result<Output, String> {
    let output = output.map_err(|_| format!("Could not run the macOS {command} check."))?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(format!(
            "The downloaded app failed the macOS {command} check."
        ))
    }
}

fn codesign_field<'a>(details: &'a str, key: &str) -> Option<&'a str> {
    details.lines().find_map(|line| {
        line.strip_prefix(key)
            .and_then(|value| value.strip_prefix('='))
    })
}

fn codesign_has_runtime(details: &str) -> bool {
    details
        .lines()
        .filter_map(|line| line.strip_prefix("CodeDirectory "))
        .flat_map(str::split_whitespace)
        .filter_map(|field| field.strip_prefix("flags="))
        .filter_map(|flags| flags.split_once('(').map(|(_, names)| names))
        .filter_map(|names| names.strip_suffix(')'))
        .flat_map(|names| names.split(','))
        .any(|flag| flag == "runtime")
}

fn plist_string<'a>(dictionary: &'a plist::Dictionary, key: &str) -> Result<&'a str, String> {
    dictionary
        .get(key)
        .and_then(plist::Value::as_string)
        .ok_or_else(|| format!("The downloaded app is missing {key}."))
}

fn validate_archive_path(path: &Path) -> Result<(), String> {
    let mut components = path.components();
    match components.next() {
        Some(Component::Normal(component)) if component == OsStr::new("Macnu.app") => {}
        _ => return Err("The update archive has an unexpected app layout.".to_string()),
    }
    if components.all(|component| matches!(component, Component::Normal(_))) {
        Ok(())
    } else {
        Err("The update archive contains an unsafe path.".to_string())
    }
}

pub(crate) fn verify_update_archive(
    bytes: &[u8],
    announced: &Version,
    current_version: Option<&Version>,
) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > UPDATE_ARCHIVE_LIMIT {
        return Err("The downloaded update has an invalid size.".to_string());
    }

    let temporary = tempfile::Builder::new()
        .prefix("macnu-update-verification")
        .tempdir()
        .map_err(|_| "Macnu could not create a secure update workspace.".to_string())?;
    let decoder = GzDecoder::new(Cursor::new(bytes));
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|_| "The downloaded update archive is invalid.".to_string())?;

    let mut entry_count = 0usize;
    let mut unpacked_size = 0u64;
    for entry in entries {
        let mut entry =
            entry.map_err(|_| "The downloaded update archive is invalid.".to_string())?;
        entry_count = entry_count.saturating_add(1);
        if entry_count > UPDATE_ENTRY_LIMIT {
            return Err("The update archive contains too many files.".to_string());
        }

        let path = entry
            .path()
            .map_err(|_| "The update archive contains an invalid path.".to_string())?
            .into_owned();
        validate_archive_path(&path)?;

        let entry_type = entry.header().entry_type();
        if !entry_type.is_file() && !entry_type.is_dir() {
            return Err("The update archive contains an unsupported file type.".to_string());
        }

        unpacked_size = unpacked_size
            .checked_add(entry.size())
            .ok_or_else(|| "The update archive is too large.".to_string())?;
        if unpacked_size > UPDATE_UNPACKED_LIMIT {
            return Err("The update archive expands beyond the allowed size.".to_string());
        }

        let unpacked = entry
            .unpack_in(temporary.path())
            .map_err(|_| "Macnu could not inspect the downloaded update.".to_string())?;
        if !unpacked {
            return Err("The update archive contains an unsafe path.".to_string());
        }
    }

    if entry_count == 0 {
        return Err("The update archive is empty.".to_string());
    }

    let app_path = temporary.path().join("Macnu.app");
    if !app_path.is_dir() {
        return Err("The update archive does not contain Macnu.app.".to_string());
    }

    let info_path = app_path.join("Contents/Info.plist");
    let info = plist::Value::from_file(&info_path)
        .map_err(|_| "The downloaded app has an invalid Info.plist.".to_string())?;
    let dictionary = info
        .as_dictionary()
        .ok_or_else(|| "The downloaded app has invalid bundle metadata.".to_string())?;

    if plist_string(dictionary, "CFBundleIdentifier")? != EXPECTED_BUNDLE_ID {
        return Err("The downloaded app has the wrong bundle identifier.".to_string());
    }
    if plist_string(dictionary, "MacnuDistribution")? != EXPECTED_DISTRIBUTION {
        return Err("Macnu refused a non-official update.".to_string());
    }
    if plist_string(dictionary, "MacnuUpdateChannel")? != EXPECTED_CHANNEL {
        return Err("Macnu refused an update from another channel.".to_string());
    }

    let executable = plist_string(dictionary, "CFBundleExecutable")?;
    if executable != EXPECTED_EXECUTABLE {
        return Err("The downloaded app has an unexpected executable.".to_string());
    }

    let internal_version = Version::parse(plist_string(dictionary, "CFBundleShortVersionString")?)
        .map_err(|_| "The downloaded app has an invalid internal version.".to_string())?;
    let bundle_version = Version::parse(plist_string(dictionary, "CFBundleVersion")?)
        .map_err(|_| "The downloaded app has an invalid bundle version.".to_string())?;
    if &internal_version != announced || bundle_version != internal_version {
        return Err(
            "The signed app version does not match the announced update version.".to_string(),
        );
    }
    if let Some(current) = current_version {
        if !is_stable_upgrade(current, &internal_version) {
            return Err("Macnu refused a non-stable or non-newer update.".to_string());
        }
    }

    command_output(
        "code signature",
        Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict", "--verbose=2"])
            .arg(&app_path)
            .output(),
    )?;

    let signature = command_output(
        "signing identity",
        Command::new("/usr/bin/codesign")
            .args(["-dv", "--verbose=4"])
            .arg(&app_path)
            .output(),
    )?;
    let signature_details = String::from_utf8_lossy(&signature.stderr);
    let developer_id = signature_details.lines().any(|line| {
        line.strip_prefix("Authority=")
            .is_some_and(|authority| authority.starts_with("Developer ID Application: "))
    });
    let timestamped =
        codesign_field(&signature_details, "Timestamp").is_some_and(|value| !value.is_empty());
    if !developer_id
        || codesign_field(&signature_details, "TeamIdentifier") != Some(EXPECTED_TEAM_ID)
        || codesign_field(&signature_details, "Identifier") != Some(EXPECTED_BUNDLE_ID)
        || !codesign_has_runtime(&signature_details)
        || !timestamped
    {
        return Err("The downloaded app has an unexpected signing identity.".to_string());
    }

    command_output(
        "Gatekeeper",
        Command::new("/usr/sbin/spctl")
            .args(["--assess", "--type", "execute", "--verbose=4"])
            .arg(&app_path)
            .output(),
    )?;

    let executable_path = app_path.join("Contents/MacOS").join(executable);
    let architectures = command_output(
        "architecture",
        Command::new("/usr/bin/lipo")
            .arg("-archs")
            .arg(&executable_path)
            .output(),
    )?;
    let architectures = String::from_utf8_lossy(&architectures.stdout)
        .split_whitespace()
        .map(str::to_string)
        .collect::<Vec<_>>();
    if architectures.len() != 2
        || !architectures.iter().any(|arch| arch == "arm64")
        || !architectures.iter().any(|arch| arch == "x86_64")
    {
        return Err("The downloaded app is not an exact universal Mac build.".to_string());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_updater_signatures_are_rejected_before_decoding() {
        let oversized = "A".repeat(UPDATE_SIGNATURE_LIMIT + 1);
        assert_eq!(
            verify_update_signature(b"payload", &oversized).unwrap_err(),
            "The updater signature has an invalid size."
        );
    }

    #[test]
    fn codesign_metadata_is_parsed_as_exact_fields() {
        let valid = "Identifier=com.qoest.macnu\nCodeDirectory v=20500 flags=0x10000(runtime) hashes=1+7 location=embedded\nAuthority=Developer ID Application: Example Publisher (UVYJU3MY6G)\nTeamIdentifier=UVYJU3MY6G\nTimestamp=24 Aug 2026 at 00:00:00\n";
        assert_eq!(
            codesign_field(valid, "Identifier"),
            Some(EXPECTED_BUNDLE_ID)
        );
        assert_eq!(
            codesign_field(valid, "TeamIdentifier"),
            Some(EXPECTED_TEAM_ID)
        );
        assert!(codesign_has_runtime(valid));

        let misleading = "Other=TeamIdentifier=UVYJU3MY6G\nCodeDirectory flags=0x0\n";
        assert_eq!(codesign_field(misleading, "TeamIdentifier"), None);
        assert!(!codesign_has_runtime(misleading));
    }

    #[test]
    fn stable_comparator_rejects_equal_lower_prerelease_and_build_metadata() {
        let current = Version::parse("1.2.3").unwrap();
        assert!(is_stable_upgrade(
            &current,
            &Version::parse("1.2.4").unwrap()
        ));
        assert!(!is_stable_upgrade(
            &current,
            &Version::parse("1.2.3").unwrap()
        ));
        assert!(!is_stable_upgrade(
            &current,
            &Version::parse("1.2.2").unwrap()
        ));
        assert!(!is_stable_upgrade(
            &current,
            &Version::parse("1.3.0-beta.1").unwrap()
        ));
        assert!(!is_stable_upgrade(
            &current,
            &Version::parse("1.3.0+rebuilt").unwrap()
        ));
    }

    #[test]
    fn archive_paths_must_stay_inside_exact_macnu_bundle() {
        assert!(validate_archive_path(Path::new("Macnu.app/Contents/Info.plist")).is_ok());
        assert!(validate_archive_path(Path::new("Other.app/Contents/Info.plist")).is_err());
        assert!(validate_archive_path(Path::new("Macnu.app/../Other.app")).is_err());
        assert!(validate_archive_path(Path::new("/Macnu.app/Contents")).is_err());
    }
}
