(() => {
  if (window.gondDesktop) return;
  const invoke = (command, args) => {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals) return Promise.reject(new Error("Not allowed here."));
    return internals.invoke(command, args);
  };
  const bridge = Object.freeze({
    platform: () => invoke("platform"),
    version: () => invoke("version"),
    connect: (address) =>
      invoke("connect", { input: String(address ?? "") }).then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error: String(error) }),
      ),
    changeServer: () => invoke("change_server"),
    signIn: (next) => invoke("sign_in", { next: String(next ?? "") }),
    notify: (title, body, url, tag) =>
      invoke("notify", { title: String(title ?? ""), body: String(body ?? ""), url: String(url ?? ""), tag: String(tag ?? "") }),
    notificationsState: () => invoke("notifications_state"),
    requestNotifications: () => invoke("request_notifications"),
    openExternal: (url) => invoke("open_external", { url: String(url ?? "") }),
    setTheme: (background, dark, system) =>
      invoke("set_theme", { background: String(background ?? ""), dark: Boolean(dark), system: Boolean(system) }),
    updateState: () => invoke("update_state"),
    checkForUpdates: () => invoke("check_for_updates"),
    installUpdate: () => invoke("install_update"),
  });
  Object.defineProperty(window, "gondDesktop", { value: bridge, writable: false, configurable: false });

  // Alt on its own, pressed and let go with nothing in between, shows the menu bar; Esc or a click hides it.
  let altAlone = false;
  let menuShown = false;
  const toggleMenu = (hide) =>
    invoke("toggle_menu_bar", { hide }).then(
      (shown) => (menuShown = Boolean(shown)),
      () => {},
    );
  window.addEventListener(
    "keydown",
    (event) => {
      altAlone = event.key === "Alt" && !event.repeat && !event.ctrlKey && !event.shiftKey && !event.metaKey;
      if (event.key === "Escape" && menuShown) void toggleMenu(true);
    },
    true,
  );
  window.addEventListener(
    "keyup",
    (event) => {
      if (event.key !== "Alt" || !altAlone) return;
      altAlone = false;
      event.preventDefault();
      void toggleMenu(false);
    },
    true,
  );
  window.addEventListener("pointerdown", () => {
    altAlone = false;
    if (menuShown) void toggleMenu(true);
  }, true);
  window.addEventListener("blur", () => (altAlone = false));

  window.open = (url) => {
    let target;
    try {
      target = new URL(String(url ?? ""), window.location.href);
    } catch {
      return null;
    }
    const own = window.location.origin !== "null" && target.origin === window.location.origin;
    void invoke(own ? "open_window" : "open_external", { url: target.href }).catch(() => {});
    return null;
  };
})();
