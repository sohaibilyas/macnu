use serde::Serialize;
use tauri::{AppHandle, WebviewWindow};

#[cfg(feature = "official-distribution")]
use tauri::{ipc::Channel, State};

#[cfg(feature = "official-distribution")]
pub(crate) const UPDATE_TARGET: &str = "macos-universal-official-stable";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateCheck {
    supported: bool,
    available: bool,
    current_version: String,
    version: Option<String>,
    notes: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg(feature = "official-distribution")]
#[serde(tag = "event", rename_all = "camelCase")]
pub(crate) enum UpdateInstallEvent {
    Started {
        #[serde(rename = "contentLength")]
        content_length: Option<u64>,
    },
    Progress {
        #[serde(rename = "chunkLength")]
        chunk_length: usize,
        downloaded: usize,
    },
    Verifying,
    Installing,
    Restarting,
}

fn require_settings_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "settings" {
        Ok(())
    } else {
        Err("Updates can only be managed from Macnu Settings.".to_string())
    }
}

#[cfg(feature = "official-distribution")]
mod official {
    use super::{require_settings_window, UpdateCheck, UpdateInstallEvent, UPDATE_TARGET};
    use crate::update_policy::{
        is_stable_upgrade, verify_update_archive, verify_update_signature, UPDATE_ARCHIVE_LIMIT,
    };
    use semver::Version;
    use std::{
        ffi::OsStr,
        io::Read,
        path::Path,
        sync::atomic::{AtomicBool, Ordering},
        time::Duration,
    };
    use tauri::{ipc::Channel, AppHandle, State, WebviewWindow};
    use tauri_plugin_updater::{Update, UpdaterExt};

    const RELEASE_HOST: &str = "github.com";
    const RELEASE_PATH_PREFIX: &str = "/sohaibilyas/macnu/releases/download/";
    const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(12);
    const UPDATE_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
    const UPDATE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(180);
    const UPDATE_DOWNLOAD_CHUNK_SIZE: usize = 64 * 1024;
    const UPDATE_INITIAL_CAPACITY_LIMIT: usize = 8 * 1024 * 1024;
    const UPDATE_REDIRECT_LIMIT: usize = 5;
    #[derive(Default)]
    pub(crate) struct UpdateOperationState {
        busy: AtomicBool,
    }

    struct UpdateOperationGuard<'a> {
        busy: &'a AtomicBool,
    }

    impl UpdateOperationState {
        fn acquire(&self) -> Result<UpdateOperationGuard<'_>, String> {
            self.busy
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .map_err(|_| "An update operation is already running.".to_string())?;
            Ok(UpdateOperationGuard { busy: &self.busy })
        }
    }

    impl Drop for UpdateOperationGuard<'_> {
        fn drop(&mut self) {
            self.busy.store(false, Ordering::SeqCst);
        }
    }

    fn clean_notes(notes: Option<String>) -> Option<String> {
        let clean = notes?
            .chars()
            .filter(|character| !character.is_control() || matches!(character, '\n' | '\r' | '\t'))
            .take(6_000)
            .collect::<String>()
            .trim()
            .to_string();
        (!clean.is_empty()).then_some(clean)
    }

    fn validate_release_url(update: &Update) -> Result<(), String> {
        let expected_path = format!("{RELEASE_PATH_PREFIX}v{}/Macnu.app.tar.gz", update.version);
        let url = &update.download_url;
        let valid = url.scheme() == "https"
            && url.host_str() == Some(RELEASE_HOST)
            && url.port().is_none()
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == expected_path
            && url.query().is_none()
            && url.fragment().is_none();
        if valid {
            Ok(())
        } else {
            Err("The update points to an unexpected download location.".to_string())
        }
    }

    fn validate_update_metadata(
        update: &Update,
        current_version: &Version,
    ) -> Result<Version, String> {
        if update.target != UPDATE_TARGET {
            return Err("The update is for a different Macnu release channel.".to_string());
        }
        let announced = Version::parse(&update.version)
            .map_err(|_| "The update has an invalid version.".to_string())?;
        if !is_stable_upgrade(current_version, &announced) {
            return Err("Macnu refused a non-stable or non-newer update.".to_string());
        }
        validate_release_url(update)?;
        Ok(announced)
    }

    fn installation_bundle_from_executable(executable: &Path) -> Option<&Path> {
        if executable.file_name() != Some(OsStr::new("macnu")) {
            return None;
        }
        let macos = executable.parent()?;
        if macos.file_name() != Some(OsStr::new("MacOS")) {
            return None;
        }
        let contents = macos.parent()?;
        if contents.file_name() != Some(OsStr::new("Contents")) {
            return None;
        }
        let app_bundle = contents.parent()?;
        if app_bundle.file_name() != Some(OsStr::new("Macnu.app")) {
            return None;
        }
        Some(app_bundle)
    }

    fn ensure_install_location() -> Result<(), String> {
        let executable = std::env::current_exe()
            .map_err(|_| "Macnu could not determine its installation location.".to_string())?;
        let app_bundle = installation_bundle_from_executable(&executable).ok_or_else(|| {
            "Run Macnu from an intact Macnu.app bundle before installing updates.".to_string()
        })?;
        let translocated = app_bundle
            .components()
            .any(|component| component.as_os_str() == "AppTranslocation");
        if app_bundle.starts_with("/Volumes") || translocated {
            Err("Move Macnu to Applications and reopen it before installing updates.".to_string())
        } else {
            Ok(())
        }
    }

    fn allowed_release_transport(url: &reqwest::Url) -> bool {
        let github_host = url
            .host_str()
            .is_some_and(|host| host == RELEASE_HOST || host.ends_with(".githubusercontent.com"));
        url.scheme() == "https"
            && url.port().is_none()
            && url.username().is_empty()
            && url.password().is_none()
            && github_host
    }

    fn release_redirect_policy() -> reqwest::redirect::Policy {
        reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() > UPDATE_REDIRECT_LIMIT
                || !allowed_release_transport(attempt.url())
            {
                attempt.stop()
            } else {
                attempt.follow()
            }
        })
    }

    fn read_bounded<R, S, P>(
        reader: &mut R,
        content_length: Option<u64>,
        limit: usize,
        on_start: S,
        mut on_chunk: P,
    ) -> Result<Vec<u8>, String>
    where
        R: Read,
        S: FnOnce(Option<u64>),
        P: FnMut(usize, usize),
    {
        if content_length.is_some_and(|length| length > limit as u64) {
            return Err("The downloaded update is larger than Macnu allows.".to_string());
        }
        on_start(content_length);

        let initial_capacity = content_length
            .and_then(|length| usize::try_from(length).ok())
            .unwrap_or_default()
            .min(UPDATE_INITIAL_CAPACITY_LIMIT)
            .min(limit);
        let mut bytes = Vec::with_capacity(initial_capacity);
        let mut chunk = [0u8; UPDATE_DOWNLOAD_CHUNK_SIZE];
        loop {
            let chunk_length = reader
                .read(&mut chunk)
                .map_err(|_| "The update download was interrupted.".to_string())?;
            if chunk_length == 0 {
                break;
            }

            let downloaded = bytes
                .len()
                .checked_add(chunk_length)
                .ok_or_else(|| "The downloaded update is too large.".to_string())?;
            if downloaded > limit {
                return Err("The downloaded update is larger than Macnu allows.".to_string());
            }
            bytes.extend_from_slice(&chunk[..chunk_length]);
            on_chunk(chunk_length, downloaded);
        }
        Ok(bytes)
    }

    fn download_bounded_update(
        update: &Update,
        on_event: &Channel<UpdateInstallEvent>,
    ) -> Result<Vec<u8>, String> {
        let mut headers = update.headers.clone();
        if !headers.contains_key(reqwest::header::ACCEPT) {
            headers.insert(
                reqwest::header::ACCEPT,
                reqwest::header::HeaderValue::from_static("application/octet-stream"),
            );
        }

        let mut client = reqwest::blocking::Client::builder()
            .user_agent(concat!("Macnu/", env!("CARGO_PKG_VERSION"), " updater"))
            .connect_timeout(UPDATE_CONNECT_TIMEOUT)
            .timeout(UPDATE_DOWNLOAD_TIMEOUT)
            .redirect(release_redirect_policy());
        if update.no_proxy {
            client = client.no_proxy();
        } else if let Some(proxy) = &update.proxy {
            let proxy = reqwest::Proxy::all(proxy.as_str())
                .map_err(|_| "Macnu could not configure the update proxy.".to_string())?;
            client = client.proxy(proxy);
        }

        let mut response = client
            .build()
            .map_err(|_| "Macnu could not prepare the update download.".to_string())?
            .get(update.download_url.clone())
            .headers(headers)
            .send()
            .map_err(|_| "Macnu could not download the update. Try again shortly.".to_string())?;

        if !response.status().is_success() || !allowed_release_transport(response.url()) {
            return Err("The update server refused the secure download.".to_string());
        }

        let content_length = response.content_length();
        let bytes = read_bounded(
            &mut response,
            content_length,
            UPDATE_ARCHIVE_LIMIT,
            |content_length| {
                let _ = on_event.send(UpdateInstallEvent::Started { content_length });
            },
            |chunk_length, downloaded| {
                let _ = on_event.send(UpdateInstallEvent::Progress {
                    chunk_length,
                    downloaded,
                });
            },
        )?;

        let _ = on_event.send(UpdateInstallEvent::Verifying);
        verify_update_signature(&bytes, &update.signature)?;
        Ok(bytes)
    }
    async fn checked_update(app: &AppHandle) -> Result<Option<(Update, Version)>, String> {
        let current_version = app.package_info().version.clone();
        let update = app
            .updater_builder()
            .timeout(UPDATE_CHECK_TIMEOUT)
            .build()
            .map_err(|_| "Macnu's official updater is not configured.".to_string())?
            .check()
            .await
            .map_err(|_| "Macnu could not check for updates. Try again shortly.".to_string())?;

        match update {
            Some(update) => {
                let announced = validate_update_metadata(&update, &current_version)?;
                Ok(Some((update, announced)))
            }
            None => Ok(None),
        }
    }

    pub(crate) async fn check_for_updates_impl(
        app: AppHandle,
        window: WebviewWindow,
        operations: State<'_, UpdateOperationState>,
    ) -> Result<UpdateCheck, String> {
        require_settings_window(&window)?;
        let _operation = operations.acquire()?;
        let current_version = app.package_info().version.to_string();
        let update = checked_update(&app).await?;
        Ok(match update {
            Some((update, announced)) => UpdateCheck {
                supported: true,
                available: true,
                current_version,
                version: Some(announced.to_string()),
                notes: clean_notes(update.body),
            },
            None => UpdateCheck {
                supported: true,
                available: false,
                current_version,
                version: None,
                notes: None,
            },
        })
    }

    pub(crate) async fn install_update_impl(
        app: AppHandle,
        window: WebviewWindow,
        expected_version: String,
        on_event: Channel<UpdateInstallEvent>,
        operations: State<'_, UpdateOperationState>,
    ) -> Result<(), String> {
        require_settings_window(&window)?;
        ensure_install_location()?;
        let _operation = operations.acquire()?;

        let expected = Version::parse(&expected_version)
            .map_err(|_| "The selected update version is invalid.".to_string())?;
        let current = app.package_info().version.clone();
        let Some((update, announced)) = checked_update(&app).await? else {
            return Err("That update is no longer available.".to_string());
        };
        if announced != expected {
            return Err("A newer release is available. Check again before installing.".to_string());
        }

        let download_update = update.clone();
        let download_channel = on_event.clone();
        let bytes = tauri::async_runtime::spawn_blocking(move || {
            download_bounded_update(&download_update, &download_channel)
        })
        .await
        .map_err(|_| "The update download stopped unexpectedly.".to_string())??;

        verify_update_archive(&bytes, &announced, Some(&current))?;
        let _ = on_event.send(UpdateInstallEvent::Installing);
        update.install(&bytes).map_err(|_| {
            "macOS could not install the update. The existing app was kept.".to_string()
        })?;

        let _ = on_event.send(UpdateInstallEvent::Restarting);
        app.restart()
    }

    #[cfg(test)]
    mod tests {
        use super::{allowed_release_transport, installation_bundle_from_executable, read_bounded};
        use reqwest::Url;
        use std::{io::Cursor, path::Path};

        #[test]
        fn updater_redirects_stay_on_secure_github_transport() {
            for allowed in [
                "https://github.com/sohaibilyas/macnu/releases/download/v0.2.0/Macnu.app.tar.gz",
                "https://release-assets.githubusercontent.com/github-production-release-asset/file",
                "https://objects.githubusercontent.com/github-production-release-asset/file",
            ] {
                assert!(allowed_release_transport(&Url::parse(allowed).unwrap()));
            }

            for denied in [
                "http://github.com/sohaibilyas/macnu/releases/download/v0.2.0/Macnu.app.tar.gz",
                "https://github.com:444/sohaibilyas/macnu/releases/download/v0.2.0/Macnu.app.tar.gz",
                "https://example.com/Macnu.app.tar.gz",
                "https://githubusercontent.com.evil.example/Macnu.app.tar.gz",
            ] {
                assert!(!allowed_release_transport(&Url::parse(denied).unwrap()));
            }
        }

        #[test]
        fn installer_accepts_only_the_exact_macnu_app_bundle_shape() {
            let executable = Path::new("/Applications/Macnu.app/Contents/MacOS/macnu");
            assert_eq!(
                installation_bundle_from_executable(executable),
                Some(Path::new("/Applications/Macnu.app"))
            );

            for unsafe_path in [
                "/Users/me/Downloads/macnu",
                "/Users/me/Downloads/Macnu.app/macnu",
                "/Applications/Other.app/Contents/MacOS/macnu",
                "/Applications/Macnu.app/Contents/Helpers/macnu",
                "/Applications/Macnu.app/Contents/MacOS/other",
            ] {
                assert_eq!(
                    installation_bundle_from_executable(Path::new(unsafe_path)),
                    None,
                    "unexpectedly accepted {unsafe_path}"
                );
            }
        }

        #[test]
        fn bounded_reader_accepts_an_exact_limit_payload() {
            let mut reader = Cursor::new(b"12345".as_slice());
            let mut started = None;
            let mut progress = Vec::new();
            let bytes = read_bounded(
                &mut reader,
                Some(5),
                5,
                |length| started = Some(length),
                |chunk, downloaded| progress.push((chunk, downloaded)),
            )
            .unwrap();

            assert_eq!(bytes, b"12345");
            assert_eq!(started, Some(Some(5)));
            assert_eq!(progress, vec![(5, 5)]);
        }

        #[test]
        fn bounded_reader_rejects_an_oversized_declared_length_before_starting() {
            let mut reader = Cursor::new(b"12345".as_slice());
            let mut started = false;
            let result = read_bounded(&mut reader, Some(6), 5, |_| started = true, |_, _| {});

            assert!(result.is_err());
            assert!(!started);
            assert_eq!(reader.position(), 0);
        }

        #[test]
        fn bounded_reader_rejects_a_chunked_payload_past_the_limit() {
            let mut reader = Cursor::new(b"123456".as_slice());
            let mut started = false;
            let result = read_bounded(&mut reader, None, 5, |_| started = true, |_, _| {});

            assert!(result.is_err());
            assert!(started);
        }
    }
}

#[cfg(feature = "official-distribution")]
pub(crate) use crate::update_policy::is_stable_upgrade;
#[cfg(feature = "official-distribution")]
pub(crate) use official::UpdateOperationState;

#[cfg(feature = "official-distribution")]
#[tauri::command]
pub(crate) async fn check_for_updates(
    app: AppHandle,
    window: WebviewWindow,
    operations: State<'_, UpdateOperationState>,
) -> Result<UpdateCheck, String> {
    official::check_for_updates_impl(app, window, operations).await
}

#[cfg(feature = "official-distribution")]
#[tauri::command]
pub(crate) async fn install_update(
    app: AppHandle,
    window: WebviewWindow,
    expected_version: String,
    on_event: Channel<UpdateInstallEvent>,
    operations: State<'_, UpdateOperationState>,
) -> Result<(), String> {
    official::install_update_impl(app, window, expected_version, on_event, operations).await
}

#[cfg(feature = "source-build")]
#[tauri::command]
pub(crate) async fn check_for_updates(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<UpdateCheck, String> {
    require_settings_window(&window)?;
    Ok(UpdateCheck {
        supported: false,
        available: false,
        current_version: app.package_info().version.to_string(),
        version: None,
        notes: None,
    })
}

#[cfg(feature = "source-build")]
#[tauri::command]
pub(crate) async fn install_update(
    _app: AppHandle,
    window: WebviewWindow,
    _expected_version: String,
) -> Result<(), String> {
    require_settings_window(&window)?;
    Err("Official updates are not included in source builds.".to_string())
}
