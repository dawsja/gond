# Mac app

Read with the root `CLAUDE.md`, whose rules (Bun only, copy, tests, before a
commit, things that stay true) hold here too.

- `apps/mac`: Swift and SwiftUI, macOS 15 and up, in place of Tauri on
  the Mac. Connect is native (`ConnectView.swift`), then a `WKWebView`
  (`WebShell.swift`) with the app's own sidebar, toolbar and composer,
  Liquid Glass from macOS 26 and a material before. The page decides
  everything; the app only draws and reports, as on the iPhone.
  - The bridge is `window.gondMac` (`GondMac` and `macShell()` in
    `lib/shell.ts`), never `gondMobile` (that is a phone) or `gondDesktop`
    (Tauri's): a document-start script defined only on the saved origin,
    posting to a `gondMac` handler that checks the frame's origin again.
    The theme init script marks `<html data-shell="mac">` before first
    paint; the `mac:` variant scopes the page's Mac look, and the Mac is
    wide at every width.
  - The sidebar is the page's state (`SidebarState`, `useNativeSidebarState`,
    `native-sidebar.tsx`), sent whole at most once a frame, faces as PNGs by
    key sent once per page, `sidebar("null")` on unmount; a click comes back
    as a `gond:native-sidebar` event and the app never navigates by itself.
  - The toolbar and composer take the iPhone's `ChromeState` and send the
    same `ChromeEvent`s; `column` is the chat's stretch of the web view,
    which the details panel narrows, so the composer sits over the chat.
    Details shows or hides the panel beside the chat at every width, never
    the phone's sheet.
  - Only `/app` pages run under the toolbar: its height comes from the
    window's content layout rect and reaches the page as
    `--shell-inset-top` before first paint. WebKit's own content insets
    are turned off, or the page would be padded twice.
  - `ServerURL.swift`, its tests, the brand mark and `AppIcon.icon` are
    the iPhone app's, referenced by path in `project.yml`, never copied.
    The Xcode project is generated with XcodeGen and never checked in.
    `scripts/check.mjs` (the lint) fails when the bridge misses a
    `GondMac` method, the loopback port drifts or a shared file is gone.
  - CI (`mac` in `build.yml`, `xcode-27`) tests, builds one app for Apple
    silicon and Intel, and signs it with a Developer ID and notarizes the
    dmg (waiting at most 20 minutes, then shipping it signed without a
    stapled ticket, which Gatekeeper checks online) only when `MAC_CERTIFICATE_P12`, `MAC_CERTIFICATE_PASSWORD` and the App
    Store Connect key (`ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`) are all
    there and it isn't a pull request; ad hoc otherwise. The repository
    variable `MAC_NOTARIZE` set to `off` skips notarizing, the dmg still
    signed. The release gets the dmg. Take its screenshots with
    `bun run screens mac`, as for the iPhone.
