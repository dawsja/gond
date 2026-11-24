# iPhone app

Read with the root `CLAUDE.md`, whose rules (Bun only, copy, tests, before a
commit, things that stay true) hold here too.

- `apps/ios`: Swift and SwiftUI, iPhone only, iOS 17 and up. Connect is
  native (`ConnectView.swift`, Liquid Glass from iOS 26 via `glassEffect`
  and `.glassProminent`, a material before, over 3D faces drawn from the
  cog, `BotFace` on `CogShape`); then a `WKWebView` (`WebShell.swift`).
  - `gondMobile` is a document-start script that defines itself only on
    the saved origin and posts to a message handler, which checks the
    frame's origin again. WebKit's messages are one way, so what the page
    reads back (platform `ios`, the version, the notification permission)
    is written into the script and kept current with a
    `gond:notifications-state` event. `setTheme` says whether the page
    follows the system, and then the app pins no colour scheme, since the
    web view's `prefers-color-scheme` is whatever the app pins (only the
    iPhone hears it: Android's bridge matches a call by argument count).
  - Attachments download to the share sheet, other origins' links open
    in Safari's view, insets are `--shell-inset-*` as on Android. Sign-in
    is `ASWebAuthenticationSession` with `app=ios`, back on
    `gond://sign-in`.
  - Push (`Push.swift`): Firebase Messaging with the APNs token handed over
    by the app delegate. The notification service extension
    (`GondNotifications`, `NotificationService.swift`) opens each notice
    with the phone's seal key (`Shared/PushCrypto.swift`) from the
    keychain it shares with the app through the App Group
    `group.io.gond.ios` (`PushKeys`). A card's notice is in the `gond.card`
    category, Allow and Deny behind Face ID or the passcode, answered with
    the answer key. `GoogleService-Info.plist` comes from CI's
    `GOOGLE_SERVICE_INFO_PLIST`, never checked in; without it there's no
    push and the bridge's notify works as before. The archive is signed ad
    hoc with the entitlements before export, since an unsigned one carries
    none.
  - Some UI is the app's own, in Liquid Glass (`NativeUI.swift`,
    `NativeViews.swift`, `lib/native-ui.ts` on the page): `present` (a
    confirm as iOS's alert, from every `Confirm`; a message's long-press
    menu; pictures in Quick Look with the web view's cookies), answered
    as `gond:native` events, and `chrome`, which hands over a
    conversation's header and composer (`ConversationChrome`, a `call`
    state for the call bar; an app without "call" in `features()` leaves
  the call to the page, `useNativeCallBar`). The page keeps its own header and composer
    in place unseen so the layout holds (`--native-composer-bottom`,
    `--native-composer-height`); taps and typing come back as
    `gond:native-chrome` events. The page decides everything; the app
    only draws and reports. The text lives in the app's field while typed
    and goes back only when the page changed it (`textRev`, raised by
    every page change and never by the app's typing, `changeDraft`; never
    told apart by comparing texts), and the chrome steps aside while anything of the page's covers the
    conversation.
  - `ServerURL.swift` mirrors `ServerUrl.kt` with the same tests, and
    `scripts/check.mjs` (the package's lint) fails when the bridge misses
    a `GondMobile` method, the loopback port drifts from shared or an
    Android address test has no Swift twin.
  - The icon is `AppIcon.icon` (Icon Composer: the mascot as one white glass
    layer with its eyes cut out over the ink fill, at `MARK_MASCOT`, derived by `brand:build`), a resource of its own in `project.yml`, never inside `Gond/`.
    The Xcode project is generated from `project.yml` with XcodeGen and
    never checked in.
  - CI tests on `xcode-27` (App Store Connect takes only iOS 27 SDK
    builds from April 2027); a push to main or a release tag archives with
    automatic signing through the App Store Connect API key
    (`APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`) and
    uploads to TestFlight (the release's version, the run number as
    build); without the secrets or on a PR it builds unsigned. It is
    never on the GitHub release.
  - Take screenshots on a Mac, never in CI. `bun run screens [ios|mac]`
    (`scripts/screens.ts`) starts a throwaway Gond seeded by
    `apps/ios/scripts/screens-seed.ts`, then runs each app's
    `GondScreens` UI tests in light and dark, the iPhone's in a
    simulator. The `GOND_SCREENS_*` hooks exist only in debug builds. The
    script needs Xcode and XcodeGen. The Mac run moves the real pointer
    and types, so leave the Mac alone until it ends.
