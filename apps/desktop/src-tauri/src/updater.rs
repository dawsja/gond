use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::async_runtime::Mutex as AsyncMutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::lock;

const FIRST_CHECK: Duration = Duration::from_secs(5);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// A development build never checks: it would offer the latest release to
/// a tree that is ahead of it, and install that over the build on quit.
pub const ENABLED: bool = !cfg!(debug_assertions);

struct Ready {
    update: Update,
    bytes: Vec<u8>,
}

#[derive(Default)]
struct Status {
    available: Option<String>,
    ready: Option<Ready>,
    checking: bool,
    error: Option<String>,
}

#[derive(Default)]
pub struct Updates {
    status: Mutex<Status>,
    running: AsyncMutex<()>,
}

#[derive(Serialize)]
pub struct UpdateState {
    current: String,
    available: Option<String>,
    ready: bool,
    checking: bool,
    error: Option<String>,
}

pub fn state(app: &AppHandle) -> UpdateState {
    let updates = app.state::<Updates>();
    let status = lock(&updates.status);
    UpdateState {
        current: app.package_info().version.to_string(),
        available: status.available.clone(),
        ready: status.ready.is_some(),
        checking: status.checking,
        error: status.error.clone(),
    }
}

pub fn start(app: AppHandle) {
    if !ENABLED {
        return;
    }
    thread::spawn(move || {
        thread::sleep(FIRST_CHECK);
        loop {
            tauri::async_runtime::block_on(check(&app));
            thread::sleep(CHECK_EVERY);
        }
    });
}

/// Checks now and downloads what it finds; a check already running is
/// waited for rather than doubled.
pub async fn check(app: &AppHandle) {
    if !ENABLED {
        return;
    }
    let updates = app.state::<Updates>();
    let _running = updates.running.lock().await;
    {
        let mut status = lock(&updates.status);
        status.checking = true;
        status.error = None;
    }
    let found = fetch(app, &updates).await;
    let mut status = lock(&updates.status);
    status.checking = false;
    match found {
        Ok(Some(version)) => {
            drop(status);
            announce(app, &version);
        }
        Ok(None) => {}
        Err(error) => {
            eprintln!("[gond] update check failed: {error}");
            status.available = status
                .ready
                .as_ref()
                .map(|ready| ready.update.version.clone());
            status.error = Some(error);
        }
    }
}

/// The version it downloaded, if it is one not downloaded before.
async fn fetch(app: &AppHandle, updates: &Updates) -> Result<Option<String>, String> {
    let found = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    let Some(update) = found else {
        let mut status = lock(&updates.status);
        status.available = status
            .ready
            .as_ref()
            .map(|ready| ready.update.version.clone());
        return Ok(None);
    };
    {
        let mut status = lock(&updates.status);
        if status
            .ready
            .as_ref()
            .is_some_and(|ready| ready.update.version == update.version)
        {
            return Ok(None);
        }
        status.available = Some(update.version.clone());
    }
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|error| error.to_string())?;
    let version = update.version.clone();
    lock(&updates.status).ready = Some(Ready { update, bytes });
    Ok(Some(version))
}

fn announce(app: &AppHandle, version: &str) {
    let shown = app
        .notification()
        .builder()
        .title(format!("Gond {version} is ready"))
        .body("Restart Gond to update.")
        .show();
    if let Err(error) = shown {
        eprintln!("[gond] update notification not shown: {error}");
    }
}

fn take(app: &AppHandle) -> Option<Ready> {
    lock(&app.state::<Updates>().status).ready.take()
}

/// On the way out, so the next start is the new version. On Windows the
/// installer runs passive and this process ends here.
pub fn install_on_exit(app: &AppHandle) {
    let Some(Ready { update, bytes }) = take(app) else {
        return;
    };
    if let Err(error) = update.restart_after_install(false).install(&bytes) {
        eprintln!("[gond] update not installed: {error}");
    }
}

/// Installs the waiting update and starts the new version. On Windows the
/// installer relaunches Gond itself and this process ends inside `install`.
pub fn install_now(app: &AppHandle) -> Result<(), String> {
    let Some(ready) = take(app) else {
        return Err("No update is ready.".to_string());
    };
    if let Some(main) = crate::main_window(app) {
        crate::remember(&main);
    }
    if let Err(error) = ready.update.install(&ready.bytes) {
        eprintln!("[gond] update not installed: {error}");
        lock(&app.state::<Updates>().status).ready = Some(ready);
        return Err(error.to_string());
    }
    app.restart()
}
