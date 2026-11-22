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
    showDownload: (id) => invoke("show_download", { id: Number(id) }),
    setFrameless: (frameless) => invoke("set_frameless", { frameless: Boolean(frameless) }),
    minimize: () => invoke("window_action", { action: "minimize" }),
    toggleMaximize: () => invoke("window_action", { action: "maximize" }),
    closeWindow: () => invoke("window_action", { action: "close" }),
    isMaximized: () => invoke("window_action", { action: "state" }),
  });
  Object.defineProperty(window, "gondDesktop", { value: bridge, writable: false, configurable: false });

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

  const controls =
    "a,button,input,select,textarea,label,summary,[contenteditable]:not([contenteditable='false'])," +
    "[role=button],[role=link],[role=menuitem],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=option],[role=textbox],[role=combobox],[role=slider]";
  document.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || event.detail > 2 || !(event.target instanceof Element)) return;
    const region = event.target.closest("[data-window-drag]");
    const control = event.target.closest(controls);
    if (!region || (control && region.contains(control))) return;
    event.preventDefault();
    invoke("window_action", { action: event.detail === 2 ? "maximize" : "drag" }).catch(() => {});
  });

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
