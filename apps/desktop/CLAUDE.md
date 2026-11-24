# Desktop app (Windows and Linux)

Read with the root `CLAUDE.md`, whose rules (Bun only, copy, tests, before a
commit, things that stay true) hold here too.

- `apps/desktop`: Rust and Tauri v2, a Windows installer (NSIS) and a
  Linux AppImage, Windows and Linux only (the Mac has `apps/mac`).
  Connect is `src/connect.*`: three 3D bots above the
  words as on the iPhone (`team.svg`, written by `brand:build` from the
  cog's geometry and shaded as `GondBot` shades, never edited by hand)
  and the form as an island. The bridge is
  `window.gondDesktop`, injected by `src-tauri/src/init.js`; every
  command in `bridge.rs` checks the origin. `on_permission_request` in
  `lib.rs` allows notifications, clipboard reads and the microphone to
  that origin; on Linux `allow_media` first turns on WebKitGTK's media
  stream, which ships off, or the mic gets nothing. Address rules: the
  `server-url` crate. The menu bar is always hidden; a lone tap of Alt
  shows it, and another tap, Esc, a click or a pick hides it (`init.js`,
  `toggle_menu_bar`); no setting. A window without a frame has no menu
  bar, so there Alt opens the menu below the top row.
  Windows have no frame: the page is the title bar. Each page says so as
  it loads (`setFrameless`, from the theme init script and `connect.js`),
  and one that hasn't by the time it finishes loading (an older Gond, an
  error page) gets the system's frame back (`on_page_load` in `lib.rs`).
  The page marks where the window is held with `data-window-drag`, which
  `init.js` turns into a move, or a maximize on a double press; its
  buttons go through `window_action`, and `gond:window` says when it is
  maximized. Package scripts go through
  `scripts/cargo.mjs`, which skips without cargo and fails in CI.
  It updates itself (`updater.rs`): 5 s after start and every 6 hours it
  reads `latest.json` from the latest GitHub release, downloads in the
  background and installs on quit or from "Restart to update" in
  Settings → About. Only a build signed with the repository's key
  installs: CI signs with `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` and writes `latest.json` in the
  release job. The private key never goes in the repo; the public one is
  in `tauri.conf.json`.
