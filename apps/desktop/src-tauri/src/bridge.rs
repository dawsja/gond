use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sha2::{Digest, Sha256};
use tauri::window::Color;
use tauri::{AppHandle, Manager, State, Theme, WebviewWindow};
use tauri_plugin_notification::{NotificationExt, PermissionState};
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::updater::{self, UpdateState};
use crate::{AppState, PendingSignIn};

const NOT_HERE: &str = "Not allowed here.";

/// What a page may do depends on the origin it is showing right now, never
/// on the window: the same window shows Connect, then the server, and a
/// capability only says which windows may call at all.
fn trusted(window: &WebviewWindow, state: &AppState) -> bool {
    let Some(server) = state.server() else {
        return false;
    };
    window
        .url()
        .map(|url| server_url::same_origin(url.as_str(), &server))
        .unwrap_or(false)
}

fn from_connect_page(window: &WebviewWindow) -> bool {
    window
        .url()
        .map(|url| crate::is_bundled(&url))
        .unwrap_or(false)
}

/// Where to go once signed in: a path on the server, never another site.
fn safe_path(value: &str) -> String {
    if value.starts_with('/') && !value.starts_with("//") && !value.starts_with("/\\") {
        value.to_string()
    } else {
        "/app".to_string()
    }
}

fn parse_color(value: &str) -> Option<Color> {
    let hex = value.trim().strip_prefix('#')?;
    if hex.len() != 6 && hex.len() != 8 {
        return None;
    }
    let channel = |at: usize| u8::from_str_radix(&hex[at..at + 2], 16).ok();
    Some(Color(channel(0)?, channel(2)?, channel(4)?, 0xff))
}

#[tauri::command]
pub async fn connect(
    window: WebviewWindow,
    state: State<'_, AppState>,
    input: String,
) -> Result<(), String> {
    if !from_connect_page(&window) {
        return Err(NOT_HERE.to_string());
    }
    for origin in server_url::server_candidates(&input)? {
        if crate::probe(&origin).await.is_ok() {
            state.update(window.app_handle(), |config| {
                config.server = Some(origin.clone())
            });
            if let Some(login) = crate::server_page(&origin, "/login") {
                crate::navigate(&window, login);
            }
            return Ok(());
        }
    }
    Err("No Gond answered at that address. Check it, and that Gond is running.".to_string())
}

#[tauri::command]
pub fn change_server(window: WebviewWindow, state: State<'_, AppState>) -> Result<(), String> {
    if !trusted(&window, &state) {
        return Err(NOT_HERE.to_string());
    }
    crate::show_connect(&window, None);
    Ok(())
}

/// Signing in with the OIDC provider happens in the default browser (it has
/// passkeys, and providers trust it); the API hands the session back to the
/// loopback as a one-time code. Only the verifier's hash goes out, so that
/// code is worth nothing to anyone without the verifier kept here.
#[tauri::command]
pub fn sign_in(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    next: String,
) -> Result<(), String> {
    if !trusted(&window, &state) {
        return Err(NOT_HERE.to_string());
    }
    let Some(server) = state.server() else {
        return Err(NOT_HERE.to_string());
    };
    let verifier = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>());
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    state.start_sign_in(PendingSignIn {
        verifier,
        next: safe_path(&next),
    });
    let mut start = crate::server_page(&server, "/api/mobile-sign-in/start").ok_or(NOT_HERE)?;
    start
        .query_pairs_mut()
        .append_pair("challenge", &challenge)
        .append_pair("app", "desktop");
    crate::open_outside(&app, start.as_str());
    Ok(())
}

#[tauri::command]
#[allow(unused_variables)]
pub fn notify(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    title: String,
    body: String,
    url: String,
    tag: String,
) -> Result<(), String> {
    if !trusted(&window, &state) {
        return Err(NOT_HERE.to_string());
    }
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| error.to_string())
}

fn permission_name(permission: PermissionState) -> &'static str {
    match permission {
        PermissionState::Granted => "granted",
        PermissionState::Denied => "denied",
        _ => "prompt",
    }
}

#[tauri::command]
pub fn notifications_state(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<&'static str, String> {
    if !trusted(&window, &state) {
        return Err(NOT_HERE.to_string());
    }
    app.notification()
        .permission_state()
        .map(permission_name)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn request_notifications(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<&'static str, String> {
    if !trusted(&window, &state) {
        return Err(NOT_HERE.to_string());
    }
    let permission = app
        .notification()
        .request_permission()
        .map_err(|error| error.to_string())?;
    let _ = window.eval("window.dispatchEvent(new Event('gond:notifications'))");
    Ok(permission_name(permission))
}

#[tauri::command]
pub fn open_external(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    url: String,
) -> Result<(), String> {
    if !trusted(&window, &state) {
        return Err(NOT_HERE.to_string());
    }
    crate::open_outside(&app, &url);
    Ok(())
}

#[tauri::command]
pub fn set_theme(
    window: WebviewWindow,
    state: State<'_, AppState>,
    background: String,
    dark: bool,
    system: Option<bool>,
) -> Result<(), String> {
    if !trusted(&window, &state) {
        return Err(NOT_HERE.to_string());
    }
    let color = parse_color(&background).ok_or_else(|| "Not a colour.".to_string())?;
    window
        .set_background_color(Some(color))
        .map_err(|error| error.to_string())?;
    let theme = match system {
        Some(true) => None,
        _ => Some(if dark { Theme::Dark } else { Theme::Light }),
    };
    let _ = window.set_theme(theme);
    Ok(())
}

/// A tap of Alt shows the menu bar, as in any Windows app, and a second one, Esc
/// or a click in the page hides it; `hide` only ever hides. Shown or not after.
#[tauri::command]
pub fn toggle_menu_bar(
    window: WebviewWindow,
    state: State<'_, AppState>,
    hide: bool,
) -> Result<bool, String> {
    if !trusted(&window, &state) && !from_connect_page(&window) {
        return Err(NOT_HERE.to_string());
    }
    let shown = window.is_menu_visible().unwrap_or(false);
    let show = !hide && !shown;
    let _ = if show {
        window.show_menu()
    } else {
        window.hide_menu()
    };
    Ok(show)
}

#[tauri::command]
pub fn platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

#[tauri::command]
pub fn version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub fn open_window(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    url: String,
) -> Result<(), String> {
    if !trusted(&window, &state) {
        return Err(NOT_HERE.to_string());
    }
    let own = state
        .server()
        .is_some_and(|server| server_url::same_origin(&url, &server));
    let url = Url::parse(&url).ok().filter(|_| own).ok_or(NOT_HERE)?;
    crate::open_child(&app, url).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn update_state(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<UpdateState, String> {
    if !trusted(&window, &state) {
        return Err(NOT_HERE.to_string());
    }
    Ok(updater::state(&app))
}

#[tauri::command]
pub async fn check_for_updates(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<UpdateState, String> {
    if !trusted(&window, &state) {
        return Err(NOT_HERE.to_string());
    }
    updater::check(&app).await;
    Ok(updater::state(&app))
}

#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !trusted(&window, &state) {
        return Err(NOT_HERE.to_string());
    }
    updater::install_now(&app)
}

/// Shows a finished download in its folder, by the id the page heard; the page never names a path.
#[tauri::command]
pub fn show_download(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    id: u32,
) -> Result<(), String> {
    if !trusted(&window, &state) {
        return Err(NOT_HERE.to_string());
    }
    let path = state
        .download(id)
        .ok_or_else(|| "That download isn't here any more.".to_string())?;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|error| error.to_string())
}
