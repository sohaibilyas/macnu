use semver::Version;
use std::{env, ffi::OsStr, fs, path::Path};

#[path = "../../../src-tauri/src/update_policy.rs"]
mod update_policy;

fn stable_version(value: &OsStr) -> Result<Version, String> {
    let value = value
        .to_str()
        .ok_or_else(|| "The release version is not valid UTF-8.".to_string())?;
    let version =
        Version::parse(value).map_err(|_| "The release version is invalid.".to_string())?;
    if !version.pre.is_empty() || !version.build.is_empty() {
        return Err("Only stable release versions can be verified.".to_string());
    }
    Ok(version)
}

fn read_signed_file(path: &Path) -> Result<Vec<u8>, String> {
    let metadata =
        fs::metadata(path).map_err(|_| "The signed file could not be read.".to_string())?;
    if metadata.len() == 0 || metadata.len() > update_policy::UPDATE_ARCHIVE_LIMIT as u64 {
        return Err("The signed file has an invalid size.".to_string());
    }
    fs::read(path).map_err(|_| "The signed file could not be read.".to_string())
}

fn read_signature(path: &Path) -> Result<String, String> {
    let metadata =
        fs::metadata(path).map_err(|_| "The updater signature could not be read.".to_string())?;
    if metadata.len() == 0 || metadata.len() > update_policy::UPDATE_SIGNATURE_LIMIT as u64 {
        return Err("The updater signature has an invalid size.".to_string());
    }
    fs::read_to_string(path).map_err(|_| "The updater signature could not be read.".to_string())
}

fn run() -> Result<(), String> {
    let arguments = env::args_os().collect::<Vec<_>>();
    if arguments.len() != 4 {
        return Err(
            "Usage: macnu-release-verifier <archive> <signature> <version>\n       macnu-release-verifier --signature-only <file> <signature>\n       macnu-release-verifier --archive-only <archive> <version>"
                .to_string(),
        );
    }

    if arguments[1] == "--signature-only" {
        let file = read_signed_file(Path::new(&arguments[2]))?;
        let signature = read_signature(Path::new(&arguments[3]))?;
        update_policy::verify_update_signature(&file, &signature)?;
        println!("Verified updater signing key pair.");
        return Ok(());
    }

    if arguments[1] == "--archive-only" {
        let archive = read_signed_file(Path::new(&arguments[2]))?;
        let announced = stable_version(&arguments[3])?;
        update_policy::verify_update_archive(&archive, &announced, None)?;
        println!(
            "Verified unsigned Macnu updater archive for version {}.",
            announced
        );
        return Ok(());
    }

    let archive = read_signed_file(Path::new(&arguments[1]))?;
    let signature = read_signature(Path::new(&arguments[2]))?;
    let announced = stable_version(&arguments[3])?;
    update_policy::verify_update_signature(&archive, &signature)?;
    update_policy::verify_update_archive(&archive, &announced, None)?;
    println!(
        "Verified signed Macnu updater archive for version {}.",
        announced
    );
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
