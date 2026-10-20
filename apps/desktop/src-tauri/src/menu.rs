use tauri::menu::{MenuBuilder, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Manager, WebviewWindow, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::AppState;

fn item(
    app: &AppHandle,
    id: &str,
    text: &str,
    accelerator: Option<&str>,
) -> tauri::Result<MenuItem<Wry>> {
    let mut builder = MenuItemBuilder::with_id(id, text);
    if let Some(accelerator) = accelerator {
        builder = builder.accelerator(accelerator);
    }
    builder.build(app)
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let file = SubmenuBuilder::new(app, "File")
        .item(&item(app, "change-server", "Change server…", None)?)
        .separator()
        .item(&item(app, "exit", "Exit", Some("CmdOrCtrl+Q"))?)
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&item(app, "back", "Back", Some("Alt+Left"))?)
        .item(&item(app, "forward", "Forward", Some("Alt+Right"))?)
        .separator()
        .item(&item(app, "reload", "Reload", Some("CmdOrCtrl+R"))?)
        .separator()
        .item(&item(app, "zoom-in", "Zoom in", Some("CmdOrCtrl+="))?)
        .item(&item(app, "zoom-out", "Zoom out", Some("CmdOrCtrl+-"))?)
        .item(&item(
            app,
            "zoom-reset",
            "Actual size",
            Some("CmdOrCtrl+0"),
        )?)
        .separator()
        .item(&item(app, "fullscreen", "Toggle full screen", Some("F11"))?)
        .build()?;
    let help = SubmenuBuilder::new(app, "Help")
        .item(&item(app, "about", "About Gond", None)?)
        .build()?;
    let menu = MenuBuilder::new(app)
        .items(&[&file, &edit, &view, &help])
        .build()?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| on_menu(app, event.id().as_ref()));
    Ok(())
}

fn target(app: &AppHandle) -> Option<WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| crate::main_window(app))
}

fn zoom(app: &AppHandle, window: &WebviewWindow, factor: Option<f64>) {
    let level = app.state::<AppState>().zoom(factor);
    let _ = window.set_zoom(level);
}

fn about(app: &AppHandle) {
    let version = app.package_info().version.to_string();
    let detail = match app.state::<AppState>().server() {
        Some(server) => format!("Connected to {server}"),
        None => "Not connected to a server yet.".to_string(),
    };
    app.dialog()
        .message(format!("Gond {version}\n\n{detail}"))
        .title("About Gond")
        .kind(MessageDialogKind::Info)
        .show(|_| {});
}

fn on_menu(app: &AppHandle, id: &str) {
    let Some(window) = target(app) else {
        return;
    };
    match id {
        "change-server" => {
            if let Some(main) = crate::main_window(app) {
                crate::show_connect(&main, None);
            }
        }
        "exit" => {
            if let Some(main) = crate::main_window(app) {
                crate::remember(&main);
            }
            app.exit(0);
        }
        "back" => {
            let _ = window.eval("history.back()");
        }
        "forward" => {
            let _ = window.eval("history.forward()");
        }
        "reload" => {
            let _ = window.reload();
        }
        "zoom-in" => zoom(app, &window, Some(1.1)),
        "zoom-out" => zoom(app, &window, Some(1.0 / 1.1)),
        "zoom-reset" => zoom(app, &window, None),
        "fullscreen" => {
            let full = window.is_fullscreen().unwrap_or(false);
            let _ = window.set_fullscreen(!full);
        }
        "about" => about(app),
        _ => {}
    }
}
