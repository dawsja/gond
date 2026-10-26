fn main() {
    let commands = tauri_build::AppManifest::new().commands(&[
        "connect",
        "change_server",
        "sign_in",
        "notify",
        "notifications_state",
        "request_notifications",
        "open_external",
        "set_theme",
        "platform",
        "version",
        "open_window",
        "menu_bar",
        "set_menu_bar",
        "update_state",
        "check_for_updates",
        "install_update",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(commands))
        .expect("tauri-build failed");
}
