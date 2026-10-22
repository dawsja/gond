mod bridge;
mod config;
mod loopback;
mod menu;
mod updater;

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use tauri::webview::{NewWindowResponse, PermissionKind, PermissionResponse};
use tauri::window::Color;
use tauri::{
    AppHandle, Manager, RunEvent, Theme, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent, Wry,
};
use tauri_plugin_opener::OpenerExt;
use url::Url;

use config::{Bounds, Config};

/// Kept in step with MCP_LOOPBACK_PORT in packages/shared.
pub const LOOPBACK_PORT: u16 = 47651;
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const INIT_SCRIPT: &str = include_str!("init.js");
const LIGHT: Color = Color(0xf5, 0xf3, 0xee, 0xff);
const DARK: Color = Color(0x12, 0x12, 0x12, 0xff);

pub struct PendingSignIn {
    pub verifier: String,
    pub next: String,
}

pub struct AppState {
    config: Mutex<Config>,
    pending_sign_in: Mutex<Option<PendingSignIn>>,
    children: AtomicU32,
    zoom: Mutex<f64>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl AppState {
    fn new(config: Config) -> Self {
        Self {
            config: Mutex::new(config),
            pending_sign_in: Mutex::new(None),
            children: AtomicU32::new(0),
            zoom: Mutex::new(1.0),
        }
    }

    pub fn server(&self) -> Option<String> {
        lock(&self.config).server.clone()
    }

    pub fn menu_bar(&self) -> bool {
        lock(&self.config).menu_bar
    }

    pub fn update(&self, app: &AppHandle, change: impl FnOnce(&mut Config)) {
        let mut config = lock(&self.config);
        change(&mut config);
        if let Err(error) = config::write(app, &config) {
            eprintln!("[gond] config not saved: {error}");
        }
    }

    pub fn start_sign_in(&self, pending: PendingSignIn) {
        lock(&self.pending_sign_in).replace(pending);
    }

    pub fn take_sign_in(&self) -> Option<PendingSignIn> {
        lock(&self.pending_sign_in).take()
    }

    pub fn zoom(&self, factor: Option<f64>) -> f64 {
        let mut zoom = lock(&self.zoom);
        *zoom = factor.map_or(1.0, |factor| (*zoom * factor).clamp(0.5, 3.0));
        *zoom
    }

    fn next_child_label(&self) -> String {
        format!(
            "child-{}",
            self.children.fetch_add(1, Ordering::Relaxed) + 1
        )
    }
}

/// Where the bundled pages live: wry serves the app protocol as a host on Windows.
pub fn app_url() -> &'static str {
    if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    }
}

pub fn is_bundled(url: &Url) -> bool {
    url.scheme() == "tauri"
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
}

pub fn connect_url(server: Option<&str>, error: Option<&str>) -> Url {
    let mut url = Url::parse(&format!("{}/connect.html", app_url())).expect("the app url parses");
    {
        let mut query = url.query_pairs_mut();
        if let Some(server) = server {
            query.append_pair("server", server);
        }
        if let Some(error) = error {
            query.append_pair("error", error);
        }
    }
    url
}

pub fn server_page(server: &str, path: &str) -> Option<Url> {
    Url::parse(server).ok()?.join(path).ok()
}

pub fn open_outside(app: &AppHandle, url: &str) {
    let allowed = Url::parse(url)
        .map(|url| matches!(url.scheme(), "http" | "https" | "mailto"))
        .unwrap_or(false);
    if !allowed {
        return;
    }
    if let Err(error) = app.opener().open_url(url, None::<&str>) {
        eprintln!("[gond] could not open {url}: {error}");
    }
}

pub fn allowed_page(app: &AppHandle, url: &Url) -> bool {
    is_bundled(url)
        || app
            .state::<AppState>()
            .server()
            .is_some_and(|server| server_url::same_origin(url.as_str(), &server))
}

pub async fn probe(origin: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(format!("{origin}/api/health"))
        .header("Cache-Control", "no-store")
        .send()
        .await
        .map_err(|error| error.without_url().to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "not a Gond".to_string())?;
    if body.get("ok") == Some(&serde_json::Value::Bool(true)) {
        Ok(())
    } else {
        Err("not a Gond".to_string())
    }
}

pub fn navigate(window: &WebviewWindow, url: Url) {
    if let Err(error) = window.navigate(url) {
        eprintln!("[gond] navigation failed: {error}");
    }
}

pub fn show_connect(window: &WebviewWindow, error: Option<&str>) {
    let server = window.state::<AppState>().server();
    navigate(window, connect_url(server.as_deref(), error));
}

pub fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

pub fn focus_main(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        if window.is_minimized().unwrap_or(false) {
            let _ = window.unminimize();
        }
        let _ = window.set_focus();
    }
}

fn page_builder<'a>(
    app: &'a AppHandle,
    label: &str,
    url: Url,
) -> WebviewWindowBuilder<'a, Wry, AppHandle> {
    let guard = app.clone();
    let opener = app.clone();
    WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title("Gond")
        .visible(false)
        .initialization_script(INIT_SCRIPT)
        // Tauri's own drop handler takes every file drop, so the page's drop events never fire.
        .disable_drag_drop_handler()
        .on_navigation(move |url| {
            if allowed_page(&guard, url) {
                return true;
            }
            open_outside(&guard, url.as_str());
            false
        })
        .on_new_window(move |url, _features| {
            let own = opener
                .state::<AppState>()
                .server()
                .is_some_and(|server| server_url::same_origin(url.as_str(), &server));
            if own {
                let app = opener.clone();
                let _ = opener.run_on_main_thread(move || {
                    if let Err(error) = open_child(&app, url) {
                        eprintln!("[gond] could not open a window: {error}");
                    }
                });
            } else {
                open_outside(&opener, url.as_str());
            }
            NewWindowResponse::Deny
        })
        .on_permission_request(|webview, kind| {
            let own = webview
                .url()
                .ok()
                .zip(webview.state::<AppState>().server())
                .is_some_and(|(url, server)| server_url::same_origin(url.as_str(), &server));
            match kind {
                PermissionKind::Notifications
                | PermissionKind::ClipboardRead
                | PermissionKind::Microphone
                    if own =>
                {
                    PermissionResponse::Allow
                }
                _ => PermissionResponse::Deny,
            }
        })
}

pub fn apply_menu_bar(window: &WebviewWindow) {
    let shown = window.state::<AppState>().menu_bar();
    let _ = if shown {
        window.show_menu()
    } else {
        window.hide_menu()
    };
}

fn present(window: &WebviewWindow) {
    apply_menu_bar(window);
    let dark = matches!(window.theme(), Ok(Theme::Dark));
    let _ = window.set_background_color(Some(if dark { DARK } else { LIGHT }));
    let _ = window.show();
}

pub fn open_child(app: &AppHandle, url: Url) -> tauri::Result<()> {
    let label = app.state::<AppState>().next_child_label();
    let window = page_builder(app, &label, url)
        .inner_size(1024.0, 720.0)
        .min_inner_size(480.0, 560.0)
        .build()?;
    present(&window);
    Ok(())
}

pub fn remember(window: &WebviewWindow) {
    let maximized = window.is_maximized().unwrap_or(false);
    let bounds = if maximized {
        None
    } else {
        let scale = window.scale_factor().unwrap_or(1.0);
        match (window.outer_position(), window.inner_size()) {
            (Ok(position), Ok(size)) => {
                let position = position.to_logical::<f64>(scale);
                let size = size.to_logical::<f64>(scale);
                Some(Bounds {
                    x: position.x.round() as i32,
                    y: position.y.round() as i32,
                    width: size.width.round() as u32,
                    height: size.height.round() as u32,
                })
            }
            _ => None,
        }
    };
    window
        .state::<AppState>()
        .update(window.app_handle(), |config| {
            config.maximized = maximized;
            if bounds.is_some() {
                config.bounds = bounds;
            }
        });
}

fn build_main(app: &AppHandle, start: Url) -> tauri::Result<()> {
    let (bounds, maximized) = {
        let state = app.state::<AppState>();
        let config = lock(&state.config);
        (config.bounds, config.maximized)
    };
    let mut builder = page_builder(app, "main", start)
        .inner_size(1280.0, 820.0)
        .min_inner_size(480.0, 560.0)
        .maximized(maximized);
    if let Some(bounds) = bounds {
        builder = builder
            .inner_size(f64::from(bounds.width), f64::from(bounds.height))
            .position(f64::from(bounds.x), f64::from(bounds.y));
    }
    let window = builder.build()?;
    let saver = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { .. } = event {
            remember(&saver);
        }
    });
    present(&window);
    Ok(())
}

fn start_url(app: &AppHandle) -> Url {
    let Some(server) = app.state::<AppState>().server() else {
        return connect_url(None, None);
    };
    match tauri::async_runtime::block_on(probe(&server)) {
        Ok(()) => server_page(&server, "/app").unwrap_or_else(|| connect_url(Some(&server), None)),
        Err(reason) => connect_url(
            Some(&server),
            Some(&format!("Couldn't reach {server} ({reason}).")),
        ),
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_main(app)
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            bridge::connect,
            bridge::change_server,
            bridge::sign_in,
            bridge::notify,
            bridge::notifications_state,
            bridge::request_notifications,
            bridge::open_external,
            bridge::set_theme,
            bridge::platform,
            bridge::version,
            bridge::open_window,
            bridge::menu_bar,
            bridge::set_menu_bar,
            bridge::update_state,
            bridge::check_for_updates,
            bridge::install_update,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(AppState::new(config::read(&handle)));
            app.manage(updater::Updates::default());
            menu::install(&handle)?;
            let start = start_url(&handle);
            build_main(&handle, start)?;
            loopback::start(handle.clone());
            updater::start(handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Gond")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                updater::install_on_exit(app);
            }
        });
}
