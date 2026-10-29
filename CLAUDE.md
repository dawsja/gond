# Gond: how we build it

Read this before changing anything. The README says what Gond is; this
says how it is made and which rules must hold. It names the files and
functions to start from; the code holds the details.

## The shape

- Bun workspaces monorepo. **Bun for everything, never npm or npx**: `bun
  install`, `bun run`, `bun x` / `bunx --bun`, `bun test`.
- `apps/web`: Next.js (App Router, React 19), shadcn (base-ui primitives,
  "nova" style), Tailwind 4. Talks to the API through `/api/*` rewrites,
  so one origin and one cookie.
- `apps/api`: Hono on `Bun.serve`, `bun:sqlite`, Better Auth. Owns the
  database, drives the box, runs the dispatcher that answers messages and
  fires routines.
- `packages/box`: the bots' computer. Plain Node ESM (`.mjs`), no build
  step, runs as root only to drop to each person's user. Claude Code
  sessions in `agents.mjs` on the shared base in `bridge.mjs`; the `gond`
  MCP bridge in `gond-mcp.mjs`.
- `packages/shared`: types, zod schemas, constants, templates, the app
  catalog. If web and api both need it, it goes here.
- `packages/relay` (`gond-relay`): carries sealed envelopes between Gond
  servers for Spaces, so neither needs to be reachable from the internet.
  A server is its Ed25519 key, which names its mailbox; it holds one
  WebSocket there, proves the key by signing a challenge, pings every
  25 s and reconnects when a pong doesn't come in 10 (a socket can die
  without a close). It sends to mailboxes that allowed it or with a
  one-use invite. An envelope is HPKE (RFC 9180, X25519, HKDF-SHA256,
  AES-128-GCM) for the recipient's box key, its header the associated
  data, signed by the sender (`client.ts`, `@hpke/core`); the relay sees
  only who, to whom, when and how big, and an invite's token when it is
  used (it holds only the hash until then), so a relay is trusted to
  redeem invites honestly. One mailbox logic (`mailbox.ts`,
  over any SQLite) runs as `server.ts` (Bun, one SQLite file, the
  self-hosted image) and `worker.ts` (a Cloudflare Worker, a Durable
  Object per mailbox, hibernating sockets, `wrangler.jsonc`,
  `api.gond.io`). The relay has no dependencies. Its tests run every flow
  on the Bun server, and on any relay `GOND_RELAY_TEST_URL` names.
  It also carries push to phones (`/v1/push`, `push.ts`): a Gond signs
  each push with its key, the notice already sealed for that phone, and
  the relay sends it through Firebase as the service account in the
  `FCM_SERVICE_ACCOUNT` Cloudflare secret, counted per key; Firebase hands
  an iPhone's to Apple with the APNs key uploaded to it. An iPhone gets a
  placeholder alert its extension rewrites, and a `quiet` push (taking a
  notice back) as a background one. `api.gond.io` is every Gond's push
  relay (`PUSH_RELAY_URL`), with no setting.
- `docker-compose.yml` runs the three services; CI builds the images (and
  `gond-relay`'s) and publishes them to GHCR. Builds start alongside the
  checks and nothing is published or released unless they pass. When a
  release tag lands with its main push, the tag's run publishes (`latest`
  too) and the main run leaves it alone.

### The apps around the web app

The desktop, Android and iPhone apps are shells: each ships one Connect
screen of its own, drawn with the web's tokens, then shows the Gond you
connected to, so every other screen is the web app. Each has exactly one
bridge, and every call on it checks that the page is on the saved
server's origin first, so a page from another origin (an OAuth provider
mid sign-in) can't use it. The microphone is granted to that origin only.
The address rules are mirrored in each app with the same tests.

- `apps/desktop`: Rust and Tauri v2, a Windows installer (NSIS) and a
  Linux AppImage. Connect is `src/connect.*`. The bridge is
  `window.gondDesktop`, injected by `src-tauri/src/init.js`; every
  command in `bridge.rs` checks the origin. `on_permission_request` in
  `lib.rs` allows notifications, clipboard reads and the microphone to
  that origin; on Linux `allow_media` first turns on WebKitGTK's media
  stream, which ships off, or the mic gets nothing. Address rules: the
  `server-url` crate. The menu bar is always hidden; a lone tap of Alt
  shows it, and another tap, Esc, a click or a pick hides it (`init.js`,
  `toggle_menu_bar`); no setting. Package scripts go through
  `scripts/cargo.mjs`, which skips without cargo and fails in CI.
  It updates itself (`updater.rs`): 5 s after start and every 6 hours it
  reads `latest.json` from the latest GitHub release, downloads in the
  background and installs on quit or from "Restart to update" in
  Settings → About. Only a build signed with the repository's key
  installs: CI signs with `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` and writes `latest.json` in the
  release job. The private key never goes in the repo; the public one is
  in `tauri.conf.json`.
- `apps/android`: Kotlin, Gradle, one activity, a WebView. Connect is
  native (`res/values*/colors.xml` carry the tokens). The bridge is
  `gondMobile` (`GondBridge.kt`); keep it that small, and every action
  goes through `fromTrustedPage`. `RECORD_AUDIO` is granted in
  `onPermissionRequest` only to the saved origin and only on its own.
  `ServerUrl.kt` mirrors `server-url`. Edge to edge: your Gond's pages
  draw under the bars and get their sizes as `--shell-inset-*`
  (`layoutFor`/`pushInsets` in `MainActivity.kt`; only the keyboard pads
  the window), while Connect and other origins stay between the bars.
  Build with `gradle assembleRelease` in `apps/android` (ANDROID_HOME
  set); CI does, signed with the release key in its secrets.
  Push: `PushService` takes Firebase's messages and opens each with the
  phone's seal key (`PushCrypto`, the keys wrapped by `Vault`). A card's
  notice has Approve and Deny (`AnswerReceiver`, the phone unlocked
  first), posting `/api/push/answer` signed with the answer key.
  `google-services.json` comes from CI's `GOOGLE_SERVICES_JSON` and is
  never checked in; a build without it has no push. The page signs the
  phone up (`syncPhonePush`) through `pushState` and `setPushDevice`
  (`GondPush`, kept off `GondMobile` so an older app needn't offer it), as
  in the iPhone app.
  A call keeps going in the background through `CallService`, a
  microphone foreground service with an "On a call with …" notice (End
  there is `gond:call-end`), started by `setCall` (`GondCall`, off
  `GondMobile` too) once the page's mic runs, since Android refuses it
  otherwise.
- `apps/ios`: Swift and SwiftUI, iPhone only, iOS 17 and up. Connect is
  native (`ConnectView.swift`, Liquid Glass from iOS 26 via `glassEffect`
  and `.glassProminent`, a material before, over faces drawn from the
  cog, `CogShape`); then a `WKWebView` (`WebShell.swift`).
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
    and goes back only when the page changed it (`textRev`), and the
    chrome steps aside while anything of the page's covers the
    conversation.
  - `ServerURL.swift` mirrors `ServerUrl.kt` with the same tests, and
    `scripts/check.mjs` (the package's lint) fails when the bridge misses
    a `GondMobile` method, the loopback port drifts from shared or an
    Android address test has no Swift twin.
  - The icon is `AppIcon.icon` (Icon Composer: the cog as one glass
    layer), a resource of its own in `project.yml`, never inside `Gond/`.
    The Xcode project is generated from `project.yml` with XcodeGen and
    never checked in.
  - CI tests on `macos-26`; a push to main or a release tag archives with
    automatic signing through the App Store Connect API key
    (`APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`) and
    uploads to TestFlight (the release's version, the run number as
    build); without the secrets or on a PR it builds unsigned. It is
    never on the GitHub release. `ios-screens.yml` runs a debug build in
    a simulator against a throwaway Gond seeded by
    `scripts/screens-seed.ts` (`GOND_SCREENS_*` hooks exist only in debug
    builds) and keeps light and dark screenshots.
- **The apps are built only when they change, each on its own, never just
  because Gond ships.** A web or API change reaches them without a build.
  The `changes` job in `build.yml` compares a push with the commit before
  and a release tag with the release before, per app: `DESKTOP_FILES`
  (`apps/desktop/`, `assets/`), `ANDROID_FILES` (`apps/android/`,
  `assets/`), `IOS_FILES` (`apps/ios/`, `assets/`). A release carries
  each unchanged app's last build (`carry_desktop`: installers and
  `latest.json`; `carry_android`: the APK; `gh release download`), so the
  latest release always has what the updater and downloads read and no
  desktop app updates to an identical build. An app's version is the
  release it was last built for. After changing how an app builds, run
  the workflow by hand, which builds them all. Anything an app build
  starts to read from outside its folders goes into its pattern.

## Web

### Components and look

- **Use shadcn, don't hand-roll.** The skill is in `.agents/skills/shadcn`
  and its rules apply: forms are `FieldGroup`/`Field`, option sets are
  `ToggleGroup`, callouts are `Alert`, empty states are `Empty`, confirms
  are `AlertDialog` (never `window.confirm`), a plain yes or no is
  `Confirm` (`confirm-dialog.tsx`, which the iPhone shows as its own),
  notices are `toast`, chat is `MessageScroller`/`Message`/`Bubble`/
  `Attachment`/`Marker`, the sidebar is the `Sidebar` block, menus are
  `DropdownMenu` with items in groups, `Select` items in `SelectGroup`.
  Add a component with `bunx --bun shadcn@latest add <name>` from
  `apps/web`; check `components/ui` first.
- **Customize in `components/ui`, not at call sites.** The primitives are
  already themed (pill buttons, rounded inputs on the card surface, the
  `pill` toggle variant, the animated slider). A look needed in several
  places changes or extends the primitive; `className` at a call site is
  for layout.
- **Colours are tokens.** Never raw Tailwind colours, never hand `dark:`
  overrides, never the old `bg-carbon` / `text-graphite` /
  `bg-paper-white` outside `globals.css`. Use `text-muted-foreground`,
  `bg-card`, `bg-muted`, `border` and friends.
  - There is no brand colour: ink on paper in the light, Material's dark
    theme (#121212, elevation by a lighter grey) in the dark; the bots
    are the only colour on a page, besides the person's own accent.
  - One primary for actions: `bg-primary` / `text-primary-foreground`, a
    white pill in the light, grey in the dark (main buttons, the phone's
    circles, the bot's name pill). Secondary is `variant="outline"`,
    tertiary `ghost`, destructive `destructive`.
  - Everything is one pill: a slight grey `--primary-edge` draws it in
    both themes and nothing else does (`--primary-shadow` is `none`).
    Filled with `bg-primary` for a main action or a field you type into
    (`Input`, `Textarea`, `Select`, `InputGroup`), transparent with the
    same edge when secondary. A focused field steps to
    `--primary-edge-focus`, never a ring. A hovered pill steps solid to
    `bg-primary-hover` with `--primary-edge-focus`; no hover is an
    opacity, so a pill over a conversation or the screen still reads.
  - A control's on state (switch, checkbox, radio, slider, pressed pill)
    is `bg-control` / `text-control-foreground`, ink in both themes;
    `variant="control"` on a button is for the rare one that must.
  - Bubbles: yours `bg-bubble-you`, a bot's `bg-bubble-bot`. Send is a
    `tint` circle inside the composer pill.
  - The person's accent (Settings → Appearance, `ACCENTS` in shared, blue
    by default, `accent` on `gond_user_prefs`, `PUT /api/me/accent`) is
    the `--tint` family, one block per colour in `globals.css` under
    `<html data-accent>`, shades chosen so white on `--tint-solid` and
    `--tint-ink` on `--tint-wash` clear 4.6:1 in both themes. It paints
    their bubble, the main button on a card (`variant="tint"`), Send, and
    a card a bot posts on its own (`bg-tint-wash`). The theme init script
    sets it from `localStorage` before first paint, the store from
    `me.accent`.
  - Markers are tokens too: the primary bot's crown (`--gold`,
    `--gold-coin`, `bg-gold-coin`, its ring `--surface`, the colour of
    whatever it sits on; an svg in it is sized inline, since `Button`
    resizes svgs without a size class), status tones (`--tone-ok`,
    `-warn`, `-bad`, `-info`), hang-up (`variant="hangup"`, `--hangup`,
    the one solid red), diffs (`bg-diff-added`, `bg-diff-removed`).
- **No scrollbars, no blur, no side fades.** `globals.css` hides every
  scrollbar (the shells' own views too); never style one. shadcn's
  `scroll-fade-*` is not used (WebView2 and WebKitGTK drew it as a
  permanent fade). The one fade is a conversation's top and bottom
  (`MessageScrollerEdges` in `ui/message-scroller.tsx`): strips in the
  page's background whose opacity follows how far there is to scroll.
  The phone's Chats screen uses the same strips (`viewport`).
- **Every pop-up is one object.** A dialog, confirm, sheet and the
  computer's window are a `bg-card` card with the `--primary-edge` edge,
  `rounded-3xl` (the computer's window `rounded-lg`, so the screen reads
  as a screen), `shadow-subtle-3`, over `bg-black/60` with no blur;
  fields inside are `bg-primary`. The close is a primary circle
  (`icon-lg`, 44 px under a coarse pointer), the title `text-lg
  font-semibold`, the footer has no band and its buttons are `lg` pills,
  full width and stacked on a phone. Only the middle scrolls
  (`dialog-body`); header and footer stick and show a `border` only while
  something is under them (`trackScrollEdges`). A `Dialog` is a sheet
  from the bottom under `sm`. A confirm (`AlertDialog`) is the same card,
  left-aligned, above everything. On touch, no pop-up focuses a field
  when it opens (`useInitialFocus` in `ui/dialog.tsx`). A confirm whose
  button does work passes `onAction`: it stays open with a spinner,
  closes when done, stays with a toast when it fails, and holds its words
  while it fades (`useHeld`). A dialog someone types a lot into asks
  "Discard your changes?" (`useDiscardChanges`).
  Menus, context menus, a `Select`'s list and popovers are a
  `rounded-2xl` card with the same edge, `h-9` rows, kept off the edges
  (`collisionPadding`). A `Select`'s list is never a sheet and never over
  its box: it drops below from its left edge (`alignItemWithTrigger` off
  in `ui/select.tsx`), at least as wide as the box, and on a touch screen
  exactly as wide, its items wrapping.
  The picture viewer (`image-viewer.tsx`) is the one exception: the
  picture itself over `bg-black/90`, pills floating like a header.
- **Layers are fixed**: dialogs and sheets `z-50`, the computer's window
  `z-[70]`, a confirm `z-[90]`, everything that floats from a control
  (lists, menus, popovers, tooltips) and toasts `z-[100]`. A new layer
  takes a place in that order.
- **Two themes, both checked every time.** Settings → Appearance is a
  `Select` of System, Light and Dark (`THEMES` in `lib/theme/theme.ts`,
  kept on the device, `followsDevice`); the theme init script sets
  `<html class="dark">` before first paint. Edges, rings and fills must
  read in both.
- **Mascots come from the gond-bot skill** (`components/hq/gond-bot.tsx`),
  copied 1:1. Don't redraw the cog. `shape` (`BOT_SHAPES`) picks a body
  from `BODIES` under the same eyes and animations; only the cog spins. A
  new shape is a path there and a name in `BOT_SHAPES`. A bot may wear a
  picture instead (`usePicturePicker`, a 512 px PNG or a GIF as is,
  `gond_bot_avatars`, `Bot.avatar`); `BotAvatar` draws either.

### Layout

- **Phones first, one screen at a time.** Under `md` the app is a
  messaging app: `/app` is Chats (`chats-screen.tsx`, the sidebar's
  list; your picture opens Settings; pinned bots are big faces,
  `PinnedTile`). A conversation is full screen with floating pills over
  the page, never a bar: the header is absolute and messages scroll under
  it (the strip between pills is `pointer-events-none`), and the composer
  floats at the bottom with the messages padded by `--composer-h`. There
  is no bottom bar; every screen goes back with its chevron or a swipe
  from the left edge (`hooks/use-swipe-back.ts`). The bot's ⋯ menu is
  `thread-actions.tsx`, shared with the sidebar's long-press menu.
- **Wide and narrow are CSS, not `useIsMobile`**, so the server's HTML is
  right: say `wide:` and `xwide:` (variants in `globals.css`, `md` and
  `lg`), except inside the Android and iPhone apps, where the phone layout
  applies at every width (`<html data-shell="phone">`, `isPhoneShell` in
  `lib/shell.ts`).
- Edges pad with `var(--safe-top)`, `var(--safe-bottom)` and friends,
  never `env(safe-area-inset-*)`: the tokens take the larger of `env()`
  and what the app reports, since a WebView's `env()` can't be trusted.
- Touch: every `Button` has a 44 px hit area under a coarse pointer, a
  toggle is 44 px tall; anything revealed on hover is always shown under
  `pointer-coarse:`; a long press opens a menu after `HOLD_MS` (700 ms,
  timed in `ui/context-menu.tsx` so a slow scroll never opens one); on a
  touch keyboard Enter is a new line (`useCoarsePointer`). Selecting in a
  box of text (`data-select-all`) or a pop-up stays in it
  (`ScopedSelection` in `shell.tsx`). Nothing takes focus on its own when
  a screen opens, so the keyboard stays down.
- **The shells are found with `lib/shell.ts`** (`useNativeShell`,
  `shellBridge()`, `mobileShell`, `desktopShell`), never by touching
  `window.gondDesktop` or `window.gondMobile`. The desktop's calls return
  promises and an older desktop may lack a method, so check it is a
  function first. In an app there is no Web Push. The phone apps get push
  through the relay once signed up (`phonePushOn`); otherwise, and in the
  desktop app, the `notify` live event becomes a native notification
  while the app runs (`shell-notifications.tsx`). Turn off
  is a per-device switch (`shellNotificationsOff` in `lib/push.ts`) that
  also signs the phone out of push. A tap
  on a link to another site goes to `openExternal` (`OutsideLinks` in
  `shell.tsx`). Signing out in an app ends only Gond's session
  (`useSignOut` passes `disableRedirect`), since the provider's session
  lives in the system browser.

### Data and rendering

- **No hydration surprises.** Anything that depends on storage, the
  viewport or the clock renders the server's value first
  (`useSyncExternalStore` with a server snapshot). Effects that set state
  do it off the effect's tick (`Promise.resolve().then(...)`), which is
  what the lint rule wants.
- **Live data flows through the store.** `components/store.tsx` holds
  bots, threads, approvals, `me`, the box update and `desktop`, and
  refetches on `/api/events` topics. Add a topic in `packages/shared` and
  handle it there rather than polling from a component. Things that
  change several times a second stay out of the store, in their own
  context or in the conversation: activity (`useActivity`), `writing`,
  `picture`, live teaching steps (`TeachingProvider`). A load several
  events can ask for is single-flight (`singleFlight`,
  `useSingleFlight`). A message is a memoized `Line` with stable
  callbacks (`useStableCallback`), so typing or streaming doesn't redraw
  the conversation; a GET several cards make at once goes through
  `apiShared`. Background polls skip a hidden page.
- **A bot's message is GitHub Markdown** (`lib/markdown.ts`, mdast with
  GFM and directives; `components/markdown.tsx` walks the tree into
  React), so nothing a bot writes is ever injected as markup. Raw HTML
  shows as text (an inline `<br>` breaks), links get an href only for
  http, https or mailto (`safeHref`), footnotes stay literal, an image is
  a link (files go through `send_file`), headings are styled text with
  `role="heading"`, never h1–h6. Chat directives
  (`components/chat-blocks.tsx`): `:badge[…]{tone=}`, `::meter{…}` and
  `::choices[A | B]` (two to six options, filled pills while open, the
  picked one pressed; a tap sends the option; the row closes once the
  person says anything after it; only the conversation
  provides `ChoicesContext`, so it is inert elsewhere). `prepareMarkdown`
  moves a trailing `::choices` onto its own line; `badgeOf` / `meterOf` /
  `choicesOf` validate; anything else renders as raw source. Copy leaves
  choices out (`copyText`). `plainMarkdown` in shared and `plainText` in
  the web reduce to one line for notifications and previews. The
  `## Formatting` section of `souls.ts` tells bots how to use all this.
- **Anything a person has to act on is a card, never a link**, built on
  `action-card.tsx` (`ActionCard`, `ActionRows`, `ActionCode`,
  `ActionCardDone`) so cards never drift: approval, `ask_approval`
  decision, email (`email-card.tsx`), secret, login, sign-in, connect,
  card payment, teach. A new kind goes there too. "Needs you" is a warn
  `Badge`; the main button is `variant="tint"`; a card from a watch's run
  (`noticed`) wears the person's colour. Answered, it folds to one line
  with a tone `Badge`. A card nobody answers within
  `GOND_APPROVAL_TIMEOUT_MINUTES` (15) expires and Gond posts the bot's
  line itself (`cardExpired`, `CARD_EXPIRED_LINE`), never the model; a
  turn answering the person ends there, aborted with cause `expired`
  (quiet, no incident), while a turn on a teammate's errand hears
  `expiredText` and goes on. A card closed by Stop says nothing.
- **A message is only its bubble**: no avatar beside it (a room names the
  bot above), no time under it (a tap shows it, `showsTime` in
  `conversation.tsx`). A picture
  (`isPicture`, never an SVG) sits above the bubble on its own and opens
  the viewer; a message that is only pictures has no bubble.
- **Steps are recorded, never shown.** A working bot shows one line
  (`WorkLine`; several merge into `WorkLines`); the work log is kept by
  the API and never listed by the web. A reply streams into a bubble
  (`Writing`, from the `writing` event) in place of the work line;
  `PictureMaking` shows a picture being made (`picture` event).

### Copy

- Plain English in sentence case, short, no exclamation marks. "The
  computer" to the person, "the box" in code and docs. People see "room",
  never "group". **No em dashes anywhere**, in copy, prompts, comments or
  docs: use a comma, a colon, a semicolon or a new sentence.
- **Every message a person can see reads like a person wrote it**, errors
  most of all: toasts, error lines, and every `{ error }` a route answers,
  since the web shows it as is. Say what happened and what to do next
  ("Couldn't find that bot", "The picture must be under 2 MB"). Use
  contractions; no field names, codes, statuses or ids; nothing a person
  can't act on. A request with no message gets `statusMessage` in
  `lib/api.ts`, never a bare status. Text only a bot reads (a tool's
  error) is written for the model and can be exact.
- A person's action that fails says so (`failed` in
  `components/failed.ts`, never `.catch(() => undefined)`), and a load
  that fails shows `LoadFailed` with Try again, never a spinner forever.

### Settings

`SETTINGS_SECTIONS` in `lib/settings-sections.ts` is the list, each under
one of `SETTINGS_GROUPS` (You, Bots, Server, and About on its own) and
marked `admin` or not; `groupedSections` draws the headings, and a new
section takes a group. The route `/app/settings/[[...section]]` 404s a
user on an admin section. A new card goes into an existing section, or a
new entry with a URL the API and the bots can point at ("Settings → Apps
→ MCP servers" in copy). Settings never opens the computer; a bot's
panel does (`right-panel.tsx`, `openShellDialog({ kind: "computer", botId })`), and keeping
the computer running is `ComputerCard` in Shared computer, the admin's.
`useStore().admin` hides the admin's things elsewhere. Sign out is the
sidebar's profile menu on a desktop and the last row on a phone.

### Where the features live

One line each: where to start, and what must not change.

- **Rooms** (`room-dialog.tsx` for New and Edit, `PATCH /api/rooms/:id`,
  `RoomAvatar`): two to six bots (`ROOM_MIN_BOTS`, `ROOM_MAX_BOTS`),
  enforced by the routes, the dialog and `create_room`; an older room can
  only move toward the limits. The name is optional (`roomNameFor`).
  Changes post one line (`roomChange`). A room pins like a bot.
- **Who a room line goes to** is `roomTargets` in shared, used by both
  `targetsFor` and the composer so they never disagree. In order: whom it
  names (an @handle, a bot's name as a word since voice types no @, or
  the room as a whole, `addressedIn`, but never "tell everyone"); else
  whom the person's own last line named; else, while bots work
  (`working`, `workingIn`), them and those that answered since the person
  last wrote; else the bot that spoke last; else whom an earlier line
  addressed; else `roomAnswerer`. Those rules are the fallback: a line
  naming nobody is first placed by the router (`src/router.ts`, a
  one-turn, tool-less call on the person's own AI, `haiku` on a Claude
  plan), held from the dispatcher (`claimed_by` `routing`) at most
  `ROUTE_TIMEOUT_MS`, the pick kept as `sent_to` (`Message.sentTo`, "Sent
  to Sentry"). No AI (`canRoute`), an error, a timeout or a pick naming
  nobody falls back to the rules; a line held at a restart is released to
  them. A rules-placed unnamed line wakes one bot, told so
  (`ROOM_UNNAMED`).
- **Room turns**: answer exactly `NOTHING_NEW` when the line isn't for
  you; co-answerers are named (`answeringAlongside`) and cover their own
  part. A bot's line keeps what it answered (`answering`); whom it wakes
  is `wokenBy`, never a co-answerer on that same message, enforced in the
  dispatcher. A bot's line reaches every other bot still answering there
  by steer (`roomLineText`), and a member that has spoken since a line
  isn't woken by it (`spokeSince`). `message_bot` from a room turn to a
  member is said in the room as an @mention. A `::choices` tap in a room
  goes as `@handle option` to the bot that offered it.
- **Drafts and history** (`lib/drafts.ts`, `lib/sent-history.ts`): a
  draft is per conversation in `localStorage`, shown as "Draft: …". Up in
  an empty composer recalls sent lines (`historyStep`), only on the first
  or last line with nothing selected, and never while the @ and / list is
  open.
- **Replies** (`reply-quote.tsx`, `use-swipe-to-reply.ts`, `reply_to`,
  `quoteOf`, `replyLine`): the route takes only a message of the same
  conversation; quoting a bot doesn't address it.
- **Unsend and edit** (`DELETE` and `PATCH /api/threads/:id/messages/:id`,
  `unsendMessage`, `editMessage`, `Message.waiting`): only the person's
  own line, only while no bot has read it (unclaimed, unanswered, not
  steered, checked in the same statement as the change, so it can't race
  the dispatcher), never in a space; unsending removes its files.
- **Reactions** (`REACTIONS`, `gond_message_reactions`, `setReaction`,
  `components/reactions.tsx`): one per author per message; the
  `reactions` event carries the message's reactions as they stand,
  merged in place, since a `thread` event only appends. A bot reacts with
  `react` to the message it answers only; a reaction can be the whole
  answer (`reactedOnly` posts and pushes nothing). A closing message
  (`isClosing`) gets a turn-prompt line to react and answer
  `NOTHING_NEW`.
- **Export** (`export-card.tsx`, `POST /api/exports`, `runExport` in
  `src/chat-export.ts`): one job at a time per person, read by rowid
  (`messagesInOrder`), a zip per chat with `chat.md`, `chat.json` and
  `files/`. Hidden prompts and the work log stay out, everything passes
  the redactor. A blob in `gond_export_files`, kept `EXPORT_KEEP_DAYS`
  (7). An export preparing at start fails with a line; deleting one stops
  it.
- **A bot's screen in its conversation** (`hq/box-desktop.tsx`:
  `DesktopView`, `DesktopToolbar`, `DesktopFrame`; `hq/desktop-screen.tsx`;
  `screen-panel.tsx`; `computer-panel.tsx`). The store's `desktop` is
  `DesktopState` (`screenOf`, drivers) from `/api/box/desktop`, replaced
  by every `desktop` event; a 503 while the computer updates leaves it.
  Routes name the bot: `/api/box/desktop/:bot/…` (`screenUrl`). A
  `DesktopView` connects only while it has a size, so there is one
  connection per visible view. Nothing resizes the session: every view
  fits the bots' 1280 by 800 (Xtigervnc `-AcceptSetDesktopSize=0`), so
  the bots' coordinates hold. Zoom is the view's (`fittedSize`), not
  noVNC's. View-only while a bot drives. Going back gives control back.
  Taking control is `POST /api/box/desktop/:bot/control`
  (`changeDesktopControl`); the result arrives as the `desktop` event. A
  room shows a card per bot at a screen (`useScreenDrivers`).
- **Show me how** (`components/teach/`, `teach-card.tsx`): one at a time
  per person, up to `TEACH_MAX_MINUTES` (10) recording. `TeachBar`,
  `TeachSteps` (`DesktopFrame`'s `aside`), `TeachPhone`, `TeachPillFor`.
  Live steps are their own context (`TeachingProvider`, `useOpenTeaching`,
  `useTeaching`), never the store.
- **Spaces UI** (`components/spaces/`, `lib/spaces.ts`): `SpaceSection`,
  `InviteSpaceDialog`, `NewSpaceDialog`, `JoinSpaceDialog`, `BotPicker`,
  `RuleRow`, `SpaceDefaultsCard`, `OtherGondsSection`, public `/join`.
  Only bots the person let into spaces are offered, none until picked
  (`"*"` stored is every bot); `PATCH /api/rooms/:id` refuses others
  (`mayJoinSpaces`). A remote author is `remote:<key's first 12>:<member>`
  (`remoteMember`). Mentions include other Gonds' members
  (`spaceMentionables`). Reactions stay off another Gond's lines
  (`canReact`) and its bots' `::choices` are inert, since only lines
  cross. Always allow is picked only through `LevelSelect`, which
  confirms it every time.
- **Bot files** (`bot-files.tsx`, `GET /api/bots/:id/files`,
  `/files/raw`): dotfiles left out; a download is always a sandboxed
  attachment, a picture inline only when its bytes are one
  (`pictureType`, never an SVG), a file holding a stored secret is
  refused, and the text view hides every secret.
- **Usage** (`usage-section.tsx`, `GET /api/usage?range=`): spent is
  dollars only where the provider billed them; Gond keeps no price list.
  Refetches on `usage` and `ai`.
- **Voice input** (`voice-button.tsx`, `hooks/use-recorder.ts`,
  `/api/transcribe`, `voice-card.tsx`): the text lands in the draft and
  is never sent for them. Only the voice key can transcribe; without one
  the mic is dimmed and says where to add one. Always the
  system's default input. `Permissions-Policy` allows the microphone for
  the app's own origin only.
- **Calls** (`components/call/`, `CallProvider` in `call-provider.tsx`):
  only the primary bot, only its own chat (`CallButton`; on iPhone "Call"
  in ⋯, `useDial`). The `AudioContext` is made in the tap, before any
  await, or Safari stays silent. Mic as 24 kHz PCM from an AudioWorklet
  (`public/call-capture.js`, `lib/call-audio.ts`; ScriptProcessor
  fallback; wired through a silent gain since some engines only run what
  reaches the speakers), played by `CallPlayer` as one stream through
  `public/call-player.js` (its own resampler, a cushion that grows when
  audio runs late, fades over gaps), never a buffer per chunk: the joins
  click at 44.1 kHz. One WebSocket
  `/api/calls/:id/socket`, falling back to SSE and POSTs. No mic or
  speaker setting. In the call's chat the composer is `CallComposer`;
  elsewhere `CallPill` (sets `--call-pill-space`) or `CallBar`. Leaving
  the chat never hangs up, nor does leaving the app (Android's
  `CallService`, the iPhone's `audio` background mode, without which
  WebKit stops the mic); one call at a time. A call is heard, never
  read: one line "Call · 5 min"; what was said is `Message.spoken`, kept
  for the bot and left out of the messages route, previews, unread,
  search and exports. Voice pick: `call-voice-card.tsx`
  (`OPENAI_CALL_VOICES`, `/api/voice/sample`, `call_voice`).
- **Watches and "worth a look"** (`components/noticed.tsx`,
  `worth-a-look.tsx`): `RunMarker`, "Why you're seeing this", "Less like
  this" (`POST /api/threads/:id/messages/:id/less`). Nothing from the
  conversation on screen is repeated in the sheet.
- **Templates** (`bot-template.tsx`, `SharedTemplate` in the shell).
- **Transfer primary** (`transfer-primary.tsx`).
- **Size** (`appearance-card.tsx`, `SIZES` in `lib/theme/theme.ts`): Default
  or Large (115%), the phone apps only and each device's own. It is page
  zoom: the theme init script writes every viewport tag in the head (Next
  adds its own after hydration) as the screen's width over the scale, so
  everything grows and reflows; never rem or text zoom. What the apps
  report in points (`--shell-inset-*`, the native composer) is divided by
  `--page-scale`, and a rect sent to the app multiplied (`askNative`). An
  iPhone app offers it only with "scale" in `features()`, and draws its
  chrome at the page's size (`setScale`, `chromeScale` in
  `NativeViews.swift`); menus and toasts stay the system's.
- **Personalization** (`personalization-card.tsx`): `REPLY_STYLES`, emoji
  amount, `PUT /api/me/talk`.
- **About** (`server-update-card.tsx`, `about-card.tsx`). `VersionWatch`
  reloads a page whose server version changed.
- **Notifications** (`notifications-section.tsx`, `public/sw.js`,
  `viewing-report.tsx`). Each browser or app mutes bots of its own
  (`useDeviceNotices`, `DeviceNotices`, `noticeWanted`): a subscription's
  `muted_bots` and `other` for Web Push, `shellNotices` on the device for
  the apps, so every notice names its `botId`. A bot's two bells live in
  its Edit dialog (`BellField`, the `bell` toggle): Notify me (`notify`,
  everywhere) and this device, saved with the dialog.
  Settings keeps only the device's Other notices, never a list of bots.
- **Check-ins** (`check-ins-fields.tsx` in the primary bot's Edit dialog,
  `Message.checkIn`): a check-in line wears the person's colour (the
  `tint` bubble) under "Checked in". It is the primary bot's alone.
- **Linked sign-in** (`linked-sign-in.tsx`): the local account links the
  provider (`LinkedSignIn`), and an account the provider made moves its
  sign-in to the local one (`MoveSignIn`, `POST /api/me/sign-ins/move` in
  `routes/sign-ins.ts`): proven by that account's password, rate limited,
  refused when it's already linked, and only with `confirm` when the
  provider's account has bots or chats (`contentsOf`), which `removePerson`
  then deletes with every profile.
- **Profiles** (`profiles.tsx`): your picture on Chats opens
  `ProfilesDialog` (wearing the open one's `ProfileMark`, a dot when
  another has something waiting); on a desktop they are a group in
  `ProfileMenu`; Settings → Profiles is `ProfilesCard`. Switching is
  `openProfile`, a full load, so nothing of the old profile stays in
  memory; the store starts over when the session's profile changed under
  it. A mark's colour is `data-mark` in `globals.css`.

## API

### Conventions

- Routes live in `src/routes/*.ts`, one file per area, mounted in
  `app.ts`. Everything under `/api` needs the session; unsafe methods
  must be same-origin (enforced in `app.ts`).
- Validate bodies by hand at the route (shape, ranges, allowed values)
  and answer `{ error }` with a fitting status. A partial update parses
  with the `*PatchSchema` from shared, never `inputSchema.partial()`:
  zod 4 fills every missing field with its default, so a pin would wipe a
  bot's job and approval level.
- Data access lives in `src/data/*.ts`. A write the UI should see emits
  through `src/events.ts` (`botsChanged`, `threadChanged`,
  `settingsChanged`, or `emit({ topic })`). `botsChanged` takes the owner
  when known (`threadChanged` always does), so one person's bot doesn't
  make everyone reload.
- **Migrations are append-only**: add a SQL string to `MIGRATIONS` in
  `src/db/migrations.ts`; never edit an earlier one. A new enum value in a
  `CHECK` means rebuilding that table in a new migration (see the
  messages table in migration 6) and a data test that writes it.
  Team-wide settings go in `gond_settings`; binary things are blobs in
  their own table.
- **Search is an index, not a scan.** `gond_messages_fts` is an FTS5
  trigram index kept by triggers; `searchMessages` matches all words in
  any order, newest first, stopping at its limit; words under three
  characters use LIKE. It follows `gond_messages`' rowids, so a migration
  that rebuilds that table (or a VACUUM) ends with `INSERT INTO
  gond_messages_fts (gond_messages_fts) VALUES ('rebuild')`.
- **Hot queries have an index.** The dispatcher's claim, `noticedIn`,
  `botLinesSincePerson` and a conversation's sent lines each read one
  (`gond_messages_open`, `_author`, `_from`), and a logic test reads their
  query plans. A page of messages loads reactions and quotes in one query
  each (`toMessages`); what needs only conversation ids reads
  `threadRefs`, not `listThreads`; a route that only checks ownership uses
  `ownsThread`, not `ownThread`.
- **Roles** (`src/access.ts`): `requireAdmin` guards the admin's areas
  (the computer's Update and Reset, onboarding, users, oidc, every
  settings write). `ownBot` and `ownThread` answer null for anything not
  the signed-in person's, and the route answers 404, never 403.
  `listBots`, `listThreads`, `getPrimary`, `createBot`, `createRoom`,
  `searchMessages` and the push functions take the user; the responder
  and bot tools use the conversation's or bot's owner. A live event about
  a conversation or person reaches only its owner (`routes/events.ts`).
- **Everything is each profile's own**: bots, conversations, connected
  apps, the Composio key, MCP servers, secrets, skills, the AI and its
  providers, the computer account. Nothing is shared and nobody falls back
  to the admin's, except `COMPOSIO_API_KEY` for the admin's default
  profile alone.
- **Profiles** (`src/data/profiles.ts`, `src/profiles.ts`,
  `routes/profiles.ts`, `gond_profiles`): each profile but the default is
  a `"user"` row nobody signs in to, owned by a person (`personOf`); the
  default is the person's own id, "Default" until renamed, and never
  deleted. A profile may wear one of `PROFILE_ICONS` (`icon`, `isProfileIcon`) in
  the middle of its mark instead of its initial. `userId(c)` is the profile the session has open
  (`gond_session_profiles`, per device, `activeProfile`), `personId(c)` the
  login. Only the person's: name, sign-in, time zone, push subscriptions
  and the admin role (`/api/me` takes the
  person's role); everything else switches. A profile's role is never
  admin. Notices are labelled and open in their profile (`fromProfile`,
  `?profile=`), a muted one sends none. Other profiles reach a page's
  live events only as `notify` and a `profiles` nudge. `deleteProfile`
  removes everything, its computer account too, and is checked by a test
  that sweeps every table. At most `MAX_PROFILES` (5); a new one copies
  nothing.
- **Time is the person's browser's.** `gond_user_prefs` keeps each
  person's zone, shared by their profiles (reported by `viewing-report.tsx`); `userTimezone(userId)`
  in `src/data/prefs.ts` is the only reader; routines, prompts and
  templates use the bot owner's, and a change rewrites their routines.
  No team time zone. Only ISO strings cross the wire; the browser formats.
- A hidden `prompt` message (author `system`) is how the API asks a bot
  to do something on its own; the dispatcher answers it like a message
  and the web never renders it.
- Tests: `bun test` in `apps/api/test`. Data tests use a temporary data
  directory; logic tests stay pure.

### The box from the API

- Anything that runs on the box goes through `src/box.ts`.
  `boxConfig(userId)` makes the client for one person, and every request
  about a home carries `X-Gond-User`. The box answers `no_account` for
  someone new; the client makes the account (`POST /accounts`) and
  retries, so nothing is set up ahead of time. `boxHome(userId)` is the
  home's path once known. Deleting a person removes their account and
  home (`removeBoxAccount`).
- The API never reads the Claude sign-in and never sends connected-app
  credentials to the box; app actions run through Composio in the API.

### Turns

- Long work is started by the dispatcher (`src/dispatcher.ts`) and
  awaited in the responder (`src/responder.ts`); a tick stays quick. The
  tick is every 2 s, but a new message or a bot coming free wakes it
  (`wake`). While the computer updates or resets (`src/updater.ts`)
  nothing new starts. Stalled handoffs are chased by `src/nudges.ts`.
  Five of each profile's bots answer at once (`TURNS_PER_PERSON`), no
  setting. A turn's setup runs side by side (SOUL.md only when changed,
  `soulsWritten`; memory; skills; apps; MCP listings cached five minutes,
  `listings`). `GOND_TURN_TIMING=1` logs one timing line per turn
  (`timingLine`, `createTurnClock` in `src/work.ts`).
- **A session hears only what's new.** `botTurn` sends a full prompt
  (house rules, the last `CONTEXT_LINES`) and a `followUp` with only
  what arrived since that agent's last turn (`seenBy`, `runKey`).
  `pickUp` forgets a CLI session whose last turn ran on another engine or
  account (`closeAgent`), and sends the full prompt when more lines
  arrived than the window holds. The transcript and the memory a prompt
  carries are read in `src/transcript.ts`. The box sends the follow-up only to a
  session it resumed (`turnPrompt` in `packages/box/sessions.mjs`).
  Session ids live in `/state/sessions.json` (`createSessionStore`) per
  agent, person and engine, each tied to the model service it was made on
  (`backendOf`), and never resumed on another: Claude can't read another
  model's thinking, and an unknown context size makes Claude Code compact
  the whole history first. What drops out of the window is folded into
  `gond_thread_summaries` (`src/summaries.ts`), redacted.
- **The system prompt holds still** (`systemPromptFor` in `souls.ts`):
  what all a person's bots share first, then the bot, team, apps, skills
  index and servers, then memories and where it is, so provider caches
  keep the longest prefix. What a message brings (a `/slug` skill,
  `skillsInUse`) goes in that turn's prompt, since on Claude Code a
  changed system prompt is resent whole. `withCacheBreakpoints` on
  Anthropic's API; `prompt_cache_key` per bot and conversation on a
  ChatGPT plan. It opens with `assistantFirst()` on every engine: an
  assistant first, an engineer only when asked or the role is technical.
  Connected apps are listed with their tool prefix.
- **Talk style** (`REPLY_STYLES`, `userTalk`, `howToTalk` in `souls.ts`):
  a non-default style is a section right after "What you are" that wins
  over every other tone rule, plus a line in every turn prompt the person
  will read (`talkReminder`), since a system-prompt-only rule drifts. It
  never changes a bot's job or what it writes to teammates.
- **Memory** (`src/memory.ts`): `MEMORY.md` loads up to
  `MAX_MEMORY_BYTES` (24 KB), the team's up to `MAX_TEAM_MEMORY_BYTES`
  (12 KB). Headings say how full it is, nudging from `NEARLY_FULL` (80%);
  past the limit `fitMemory` drops the middle, never the newest notes.
  `memory_update` and `team_memory_update` refuse anything over. The
  house rules say how to tend it (pointer lines to `memory/<topic>.md`,
  rewrite what stopped being true, keep what the person asked to
  remember, dated things become reminders).
- **Steering.** A person's message to bots already working in that
  conversation goes to their running turns (`postFromPerson`), posted
  `steered` and put back to wait if no turn took it; in a room the idle
  ones answer it as a new turn. Files and "Send after it finishes" queue.
  Only a person steers; routines, teammates and hidden prompts queue.
  Each driver steers its own way (`steer` on the session, `POST
  /agents/:id/steer`; Claude Code reads another stdin message under
  `--replay-user-messages`, Gond's own engines read a `SteerQueue`); a
  driver that can't answers false, never guesses.
  Neither reads a line while a tool waits on a card, so a line a turn
  took sets that bot's waiting cards there aside (`setAside`: `expired`,
  outcome `aside`, "Set aside"), and the tool hears `setAsideText` with
  the line after it. Its decision is "deny", so a caller that never looks
  at `aside` still runs nothing.
- **Streaming** (`createWriting` in `src/writing.ts`): the whole redacted
  text so far, at most every `WRITING_INTERVAL_MS`, only for a turn whose
  answer goes to the person, never while it could still be `NOTHING_NEW`
  (`couldBeQuiet`), null when a tool call starts or the turn ends. Claude
  Code streams with `--include-partial-messages` (the box's `streamText`);
  `native.ts` streams all three API shapes (`anthropicAssembler`,
  `openAiAssembler`, `responsesText` over `sseStream` in `src/sse.ts`).
- **Stop means stop, and everything it started.** `stopThread`
  (`src/responder.ts`) aborts the conversation's turns with reason
  `"stopped"`, drops what waits there (queued messages too), calls off
  the handoffs it gave out, what it sent teammates and its follow-ups,
  closes a handoff to it, ends `ask_bot` turns and expires approvals it
  waited on. A stop is never an incident: `botTurn` asks the signal
  (`stopCauseOf`, `unansweredEnding`), never the error. Commands carry
  the turn's signal (the box's `/exec` kills the process tree when the
  API hangs up), and `native.ts` stops waiting on any tool once stopped
  (`unlessStopped`). `stopAll` runs it over every conversation when a
  person is deleted. **Anything new that can wake a bot later (a timer, a
  queued message, a handoff) must be called off here too.**
- **"stop" in the chat is Stop.** A short stop message (`isStopRequest`
  in shared; "cancel the order" is not one) while anything runs goes to
  `stopFromMessage`: posted answered, `stopThread` runs quietly, and the
  bot posts `stoppedReply` from its `StopReport`. There is no Stop
  button; the composer's `interrupt` is the same `stopThread`. A bot
  can't be duplicated and a conversation can't be cleared: no routes.
- **A restart never strands a bot.** At start `releaseClaims` in
  `db/init.ts` puts every claimed message back to wait, marked cut off
  (`src/resume.ts`), and expires every open card. A turn the computer
  cuts off (an update, a failed health check, "still busy") isn't an
  incident: the message waits with the steps that ran, nothing new starts
  until the computer answers (`computerAway`, every 15 s), and after 30
  minutes it is given up with a line. The retry hears what ran first
  (`takeInterrupted`); in a room it skips bots that had answered. On the
  box, an API that hangs up interrupts the CLI turn and keeps its
  session. **Anything new that a turn waits on, or that holds a bot,
  needs the same treatment at start.**
- `NOTHING_NEW` (`QUIET_REPLY`, `isQuietReply`) posts nothing and pushes
  nothing; a trailing one is stripped from an answer
  (`withoutQuietReply`). The word never shows anywhere.
- **A failed turn can be tried again.** Its grey line names the person's
  message (`answering`), and the steps that ran are kept
  (`noteInterrupted` with `failed`); `POST
  /api/threads/:id/messages/:id/retry` drops those lines and puts the
  message back to wait. No AI picked or signed in, a missing CLI (the
  box's 424) or a signed-out one (`signedOut` from the box's `settle`)
  is `setupProblem`: a `signin` card with `AI_SETUP_CARD`, never an
  incident, and one per bot and conversation unless each answers a
  line of the person's (a hidden prompt's adds none beside one).

### Bots and teammates

- **No tool is the primary bot's alone**: `teamTools` (`create_bot`,
  `update_bot`, `delegate_bot`, `ask_bot`) goes to every bot. `primary`
  shapes the prompt, answers in a room when nobody is named and hears of
  broken runs (`getPrimary`). It is never a tool's to set: `POST
  /api/bots/:id/primary` transfers it, and `ensurePrimary` keeps exactly
  one visible primary per person. Who does what lives in SOUL and the
  house rules, never gated in the responder.
- **Profiles through tools, not SQL**: `set_profile` and `update_bot` go
  through `profilePatch()` in `src/tools.ts`, then `syncSoul` rewrites
  SOUL.md. Add a field there, not in the route. `picture` is a path in
  the calling bot's home (`setBotPicture`, checked by `pictureType`, a
  still over 2 MB sent as the box's JPEG, a GIF as is; `none` restores
  the mascot).
- **Handoffs**: `MAX_CHAIN` stops bots waking each other forever. A
  result lands a hop up from its brief (`resultDepth`); a teammate that
  hands part on keeps its handoff open (`parentId`) until the last result
  is in, so results go up the chain, never relayed deeper with
  `message_bot`. A broken run says so in its failed result.
- **Notes are an action or information** (`NOTE_KINDS`, `note` on
  `gond_messages`): an `action` wakes the teammate to act and report what
  it did; `info` is posted answered, wakes nobody, and reaches running
  turns by steer (`tellWorking`). A teammate's answer always goes back as
  info. A line back to a bot that asked for an action on the person's
  errand (`awaitsReport`, the answer or an info note) wakes it, or steers
  its turn there, so it carries on (`reportTo`); its answer goes to the
  person, so the two can't bounce. No kind means action.
- **What bots say to each other stays between them.** A reply to a
  teammate is posted in the sender's conversation with `fromThreadId`,
  answered, waking nobody but a bot waiting on its report (`deliverReply`); a handoff result goes up via
  `reportBack`. Neither is ever a bubble in the person's chat with the
  answering bot. A `fromThreadId` line never previews, dates, sorts or
  counts as `unread` (new ones are `unreadTeam`, a grey dot). A bot a
  teammate woke tells the person with `post_message`. Where an answer goes
  is one decision, `answerGoesTo`, read by both `deliverReply` and
  `promptFor` (a result back to the bot that handed it out is the
  person's, and so is a teammate's reply to a bot that wrote first on the
  person's errand, `openedExchange`). A person's line reaching a turn
  bound for a teammate steers it as an aside (`asideText`), answered with
  `post_message`.
- **Approvals** (`src/approvals.ts`): `ask` ("Always ask"), `auto`
  ("Auto", the default) and `full` ("Always allow", where only an email
  that goes out still asks, `sendsEmail`). Reading is never
  gated, nor a change inside the bot's own `~/.bots/<id>` (`inOwnHome`).
  `ask` sends a card for every shell command, outside file change and app
  action; `auto` lets them through unless `mustAsk` says otherwise (forced
  push, sudo, a download piped into a shell, `rm -r` outside its home, an
  app action that sends, deletes, pays, transfers or publishes, adding an
  MCP server, `type_secret`, `forget_secret`) and trusts the bot to call
  `ask_approval` before anything irreversible or outward-facing.
  `requestApproval` re-reads the bot's level at the moment it decides,
  since people change it mid-turn. The box only hears `ask` or `full`
  (`PERMISSION_MODES`, `boxPermission`), so every prompt comes to the
  broker. `ask_approval` is a yes or no on one act; something that looks
  like a pick between options is sent back (`pickNotYesNo`) toward
  `::choices`. `touchesEngine` refuses a command, a read or a change
  reaching `~/.claude` or `~/.claude.json`, a relative path resolved from
  the bot's own folder; `scriptsTheScreen` refuses xdotool, pyautogui, pynput
  or a Chrome debugging port in a command or written file, both before any
  approval.
- **Email cards** (`emailDraftOf`, `emailText`, `email-card.tsx`): drawn
  from the action's own input, so what is approved is what goes out; the
  body's HTML is reduced to words, never rendered. Replies, forwards and
  saving a draft ask on Auto (`OUTWARD_ACTION`). Editable cards write
  only changed fields back (`editedEmailInput`); drafts send with
  `sendDraftAction` (`draftIdOf`). "Ask for changes" carries a `note`; the
  next card `revises` it (`wordDiff`). Outcome, `edited` and `note` are
  kept.
- **Tool labels in one place**: `toolLabel` in shared turns a raw tool
  and input into words (activity, work log, `approvalLine`,
  `ruleLabel`). The box sends raw `{ tool, input }`; nothing that matches
  on a name changes. Quiet tools (`isQuietTool`) are logged `quiet: true`
  and never become activity.
- **Routines are the bots'**: only bot tools make, change, run or remove
  them (`create_routine`, `update_routine`, `run_routine`,
  `delete_routine`; `routine-dialog.tsx` shows them). `PATCH /api/routines/:id` takes `enabled` and
  nothing else; no other routine routes. The chat shows a run as a clock
  and `routineName`, never its prompt (`describeSchedule` for when, never
  the cron). A reminder is `once`: `claimDueRoutines` switches it off as
  it fires and `finishRoutineRun` removes it when done (a failed one
  stays, off); it never goes into a template and its run is never
  `NOTHING_NEW`. A watch is `watch` set: its run posts `[Watch: name]`
  (`isWatchRun`), what follows up to the person's next message is
  `noticed` (`noticedRuns`), and unread noticed is `Thread.noticed`
  (`noticedIn` in `src/data/threads.ts`). Bots offer watches themselves; there is no form.
- **Templates** (`src/bot-bundle.ts`, `src/bot-templates.ts`,
  `botTemplateSchema`): a `.bot` zip of `bot.json`, the picture (only if
  its bytes are one) and each routine's skill as `.skill`. Memory,
  secrets, conversations, apps and MCP servers never go in.
  `addFromBundle` picks a free name, never trusts beyond Auto, reuses
  skills by slug, and brings routines in switched off on the person's
  time zone. Links are tokens in `gond_bot_shares`.

### AI engines

- **The AI is each person's own** (`src/data/ai.ts`, `src/engines.ts`,
  Settings → AI in three steps, `ai-steps.tsx`). `enabled` is the engines
  turned on, `engine` the one in use, `engines[engine]` its model. A pick
  moves the bots only once its account works (`readiness`). Models come
  from the engines (`/api/models` in `routes/llm.ts`, `ModelPicker`);
  nothing keeps a list of model names, and any id can be typed. A plan
  engine always has a model (`ModelPicker` picks the default as the list
  arrives). How hard a model thinks has no setting. A new engine is a
  session class in the box (`ensure`, `turnWith`, `steer`, `answerTool`,
  `close`, permissions through `askPermission`) and an entry in
  `CLI_ENGINES` in both box and shared.
- **Claude Code** runs on the person's plan (signed in inside their box
  account, `/api/box/engines/:engine/sign-in`, `engine-signin.tsx`) or an
  Anthropic-compatible key (`engines.claude.access` `api`): `engineRun`
  hands the box the LLM proxy and the key's proxy token
  (`claudeAccessEnv`), with the key's model for every tier. On a key the
  box ends a turn at its first refusal retry (`keyRefusal`); other retries
  show as the work line (`retryLine`). The proxy sends bodies whole and
  passes Claude Code's own headers; Gond never changes a client's
  User-Agent (Kimi's terms forbid it; `coderOnlyRefusal` explains coding
  plans that refuse the `api` engine). Removing a key puts CLI engines
  back on the plan (`releaseEngines`).
- **`api` has no CLI** (`src/native.ts`): `engineRun` answers `native`
  and the responder runs the loop here on Anthropic's Messages API or the
  OpenAI chat API, with the same tools plus the computer
  (`src/computer.ts`: Bash, Read, LS, Write, Edit, named like the CLI's on
  purpose so approvals and rules hold). Its `Read` answers a picture with
  the 1568 px preview. It goes out through the LLM proxy. It is its own
  MCP client (`nativeMcpTools` in `src/mcp-client.ts`, through `forwardMcp`, tools as
  `mcp__<server>__<tool>`; command servers run only on a CLI). Web search
  is the provider's own where it has one (`serverSearch`; a `pause_turn`
  is sent back as is to resume, and the reply is the text after the last
  result); usage is read by `anthropicUsage`, `openAiUsage` (a chat stream
  asks with `stream_options`) and `responsesUsage`; a PDF goes
  inline only to Anthropic (`readsPdf`). A new API shape is two functions
  in `native.ts`.
- **ChatGPT plan** (`src/chatgpt.ts`, `chatgpt-plan.tsx`): OpenAI's Sign
  in with ChatGPT, OAuth with PKCE, the client registered on first use
  (kept in `gond_user_prefs.chatgpt_client`), one `ext_agent_host_id` per
  install, redirect `http://127.0.0.1:47651/callback` (the desktop's MCP
  loopback; `/api/mcp-servers/oauth/callback` forwards a ChatGPT `state`).
  The ID token is checked against OpenAI's JWKS. Tokens are the `chatgpt`
  row of `gond_providers`, renewed one at a time per person
  (`chatGptAccessToken`, refresh tokens rotate). Responses API (`store:
  false`, tools in one `gond` namespace, `strict: false`); the proxy
  passes only `responses` and `models`. `planError` words its refusals.
  Use OpenAI's wording and mark (`ChatGptLogo`, nowhere else). No image
  generation, no voice. It is why there is no Codex engine; old settings
  naming Codex read back without it (`readEnabled`, `toAi`).
- **Grok plan** (`src/grok.ts`, `grok-plan.tsx`): reuses the open-source
  Grok CLI's public client (device flow RFC 8628 against auth.x.ai with
  `referrer=grok-build`, `startGrokLogin`), tokens as the `grok` row,
  renewed one at a time (`grokAccessToken`), revoked on sign out.
  Inference via `GROK_API_URL` with `GROK_PLAN_HEADERS`, Responses API,
  reasoning carried as `encrypted_content`; `grokError` words refusals.
  Use xAI's mark (`GrokLogo`).
  It is why there is no Grok CLI on the box.
- **Provider keys** (`src/data/providers.ts`, `src/providers.ts`): one
  endpoint per API per person (`PROVIDER_KINDS`), encrypted and
  write-only, typed only in Settings → AI (`KeyList`). An engine names the
  APIs it runs on (`ENGINE_LABELS[engine].providers`). The box gets only
  the LLM proxy (`/api/llm/:kind/*`) and a proxy token
  (`providerByToken`); only the proxy decrypts. `allSecretValues()`
  includes every key and every LLM and MCP proxy token for redaction,
  and the web's proxy answers 404 to `/api/llm/…` and `/api/mcp/…`
  (`isInternalApiPath`), so those token-only routes are reached only on
  the Compose network.
- **Usage** (`src/usage.ts`, `data/usage.ts`): every call (turns, the
  router, summaries, guest turns, pictures) records a `gond_usage` row per
  model through `usageRecorder` / `onUsage`, with a cost only when the
  provider billed one; Claude Code's `total_cost_usd` is a list-price
  estimate and never kept. Plan limits are `gond_plan_limits`: Claude's
  from `rate_limit_event` (`saveClaudeLimits`), Grok's from its proxy's
  `/billing` at most every five minutes (`grokWindows`). Neither is a
  documented API, so a failed read keeps the last one.
- **xAI is an OpenAI-compatible key**, not a kind of its own: chat
  goes the OpenAI way, and a key at `api.x.ai` (`isXaiUrl`) reaches xAI's
  own speech and images endpoints (`voiceProvider`, the `xai` image
  source). Saved xAI keys were folded in by `foldXaiKeys`.
- **The voice key** (the `voice` row of `gond_providers`,
  `voice-key-card.tsx` in Settings → Voice) is what the microphone, calls
  and call voices run on, OpenAI's or xAI's by its address; Settings → AI
  is only the bots'. No engine takes it (`EngineProviderKind`), and the
  LLM proxy refuses it, so nothing on the computer reaches it.
  `VOICE_KEYS` copied each person's OpenAI-compatible key into it.
- **Transcription** (`src/routes/voice.ts`, `src/data/voice.ts`,
  `voiceProvider`, `VOICE_MODELS`): the person's voice key, through
  `upstreamUrl` and `authHeaders`, on xAI's `stt` when it points at xAI. The format comes from the file's
  extension (Bun's multipart parser drops a part's type). Audio is never
  stored or logged.
- **Calls** (`src/calls.ts`, `src/voice-link.ts`, `src/routes/calls.ts`):
  `POST /api/threads/:id/call` takes only the primary bot's own chat
  (`callableBot`, so the route decides, not the button). The API holds
  the provider socket with the person's voice key (`CALL_MODELS`), so the key
  never reaches the page. `upgradeCallSocket` runs ahead of Hono and
  checks the Origin (a WebSocket carries the cookie from any site), the
  session and ownership. Events are read by `readLiveEvent` /
  `readXaiEvent` (pure, tested). xAI drops a `response.create` sent while
  one runs, so asks go through `SpeakQueue`; `AnswerWatch` and
  `tellsAnswer` check the voice said the answer. The voice only talks:
  anything past small talk becomes a hidden prompt (`callPrompt`)
  answered as a normal turn, routed back to the voice (`answerOnCall`,
  `closeCallTurn`, `handedOnCall`) or posted if the call ended. Speech is
  kept `spoken` and never sent to a page. A spoken "stop" is Stop;
  `endsCall` and xAI's `end_call` hang up. Ends at `ORPHAN_MS` without a
  listener, `CALL_MAX_MINUTES`, or the person's deletion; lives in memory,
  so a restart ends it.
- **Pictures** (`src/pictures.ts`, `create_image`): on the owner's plan or
  key, `imageAccess` taking the first of `IMAGE_SOURCES` they have (Grok plan, SuperGrok only,
  with `GROK_MEDIA_HEADERS`; the OpenAI-compatible key on xAI's images
  when it points at xAI, else OpenAI's, the only one that streams
  previews). `IMAGE_MODELS`. Previews live in memory while made
  (`keepPreview`). The result passes `pictureType`, is posted, and copied
  to `images/<name>-<stamp>.<ext>`. Rides the turn's signal.

### The screen

- **Bots use the screen through two tools, only by structured actions**
  (`src/computer-tool.ts`): `browser` (a persistent Chrome per bot,
  Playwright in the box, for every website) and `computer` (the whole
  desktop, xdotool). `{ actions: [...] }`, up to `MAX_SCREEN_STEPS` (20)
  of `SCREEN_STEP_TYPES`, answered with one screenshot and a line
  (`screenSummary`). The browser also returns its controls with refs
  (`compactSnapshot` in the box's `snapshot.mjs`), outputs, dialogs and
  downloads. Steps name elements by `ref` or `label` (waits up to 8 s,
  exact then starts-with then contains), and the prompt prefers those over
  x, y, since a page shifts after a click. `view: "text"` skips the
  picture. The model never writes code for the screen.
- `screenSteps` checks a batch, scales desktop coordinates (`scaleOf`)
  and turns `type_login` into the held value the model never sees. On
  Anthropic's API `computer` is `computer_20250124` (1024×640, beta
  header) converted by `fromNativeAction`; elsewhere both are JSON
  schemas. Screenshots are `ToolPart`s (`driver.ts`), relayed per API
  shape (`stepMessages`).
- A batch with any step but screenshot or wait goes through
  `requestApproval` once per reply for both tools; Always allow saves
  `computer`; Auto lets it through (not on `mustAsk`, by decision). A
  denial holds for the reply; 300 steps end it. Claude Code gets
  `--disallowedTools Bash(xdotool:*)` and friends at every level
  (`SCREEN_SCRIPTING_DENIED`).
- **Control** (`src/desktop.ts`): drivers per person (`markDriving`,
  `releaseComputer` in `botTurn`'s `finally`), the `desktop` event
  (`desktopState`). A lock is free, bots or person; the person takes it
  (never `bots`), and the box answers input with 409
  `person_has_control`; the tool waits (`untilHandedBack`,
  `HANDBACK_WAIT_MS`) and resumes with `HANDED_BACK_TEXT`. Handing back
  (`tellHandedBack`, `tookControl`, `forgetHandBack`) tells the bots it
  was taken from. A bot in two conversations has one screen
  (`waitForScreen`, `DESKTOP_LAPSE_MS`, `SCREEN_WAIT_MS`,
  `screenBusyText`); a 429 `screens_full` retries every second, then
  `SCREENS_FULL_TEXT`. A stale lock from a restart is freed by
  `desktopState`. The lock is a courtesy between the person and a bot
  that follows its rules, not a security boundary (a bot's Bash could set
  DISPLAY).
- `send_screenshot` posts a fresh screenshot with a caption, kept for
  when the person asks or the screen an answer is about (`share` on a
  batch does the same).

### Files, secrets, sign-ins

- **Files the person sends** (`src/inbox.ts`, `deliverAttachments`): each
  is written to `inbox/<id>-<name>` in the bot's folder; the model sees a
  picture's 1568 px preview (`/files/preview`) and a PDF up to 8 MB
  inline, and `attachmentNote` says what came and where. Any type is
  taken (`attachmentType`: the browser's type when Gond knows it, other
  text as plain text, else by the name, else `application/octet-stream`)
  and served as a sandboxed download unless it can't run script. Text
  and SVG are inlined as text (`attachmentText`, never bytes with a NUL);
  the original never goes to a model at full size. A
  HEIC or HEIF photo (`isHeic`, told by its bytes) is kept as a JPEG,
  made at upload by the box's `POST /images/jpeg` (`JPEG_FROM_HEIC`,
  ImageMagick as the person, stdin to stdout, nothing written to disk).
- **`send_file`** reads from the box (`/files/raw`, links resolved inside
  the home), refuses a file holding a stored secret, and posts an
  attachment. Anything that could run script (HTML, SVG, unknown) is
  served as a download with a sandbox CSP, never inline. `pictureType`
  (`src/images.ts`) trusts only the bytes (PNG, JPEG, GIF, WebP).
- **Secrets never leave the API** (`src/data/secrets.ts`): encrypted per
  person; only `readSecret`/`injectSecrets` decrypt, at the moment of
  use. No route returns a value. A value reaches the box only as
  keystrokes from `type_login` (or `type_secret`, on `mustAsk` with no
  Always) or in the environment of one `run_with_secrets` command
  (`secretCommandTool`, approved like Bash; the box's `execEnv` refuses
  names that change how the shell runs; output `scrubbed` to `[NAME]`).
  Every reply and activity line passes `createRedactor(allSecretValues())`.
  A bot asks with `request_secret` and only hears "stored"; its `target`
  is the store, the Composio key or a website sign-in. A name already
  stored needs `replace` (a "Replace …?" card, `changeSecret` keeps the
  site); `forget_secret` deletes only after an approval card. Settings →
  Secrets lists, changes (`PUT /api/secrets/:name`, fields start empty,
  `forgetHeldLogin`) and forgets; a new secret only comes in through a
  bot's card. Never tell a person to paste a key into Settings that a bot
  could ask for.
- **Payment cards** (`saveCard`, `CardMeta`, `CardsCard`, `card-form.tsx`,
  `pay-card.tsx`, `looseCards`): readable only as name, brand, last four,
  expiry. `use_card` with the site and total posts the card request; that
  yes is the payment's approval (no extra `ask_approval`, no Always). The
  card is held for the conversation `CARD_HELD_MS` (10 min, `holdCard`)
  under `CARD_FIELDS` and typed with `type_login` (`select: true`,
  `selectOptions`). `readSecret` excludes cards; `request_secret` refuses
  card pieces; the redactor knows every grouping (`cardNumberForms`); and
  screen answers drop held values (`heldIn`). A screenshot still can show
  one.
- **Website sign-ins** (`src/logins.ts`, `login-card.tsx`):
  `request_login` posts one card (`<SITE>_<KIND>`); values are held in
  memory for the conversation for 30 minutes and typed by `type_login`;
  the bot only hears names. "Remember" stores a secret with a `site`; a
  code is never stored. A later request for saved details asks first
  (`mustAsk`). Matching is loose (`savedLoginFor`, `coverLogin`);
  `fresh` asks again; "Use a saved sign-in" fills from the API, the web
  never sees a value. `readLogin` reads only secrets with a site, so an
  API key is never typed into a page.

### Apps, MCP, skills

- **Connected apps** (`src/composio.ts`, `src/data/composio-keys.ts`):
  each person's own Composio key (Settings → Apps or `set_composio_key`,
  both through `applyComposioKey`, which forgets the old key's
  connections). `toolsFor`, `executeAction` and `startConnection` always
  take the person's id and run on their key and connection. A non-active
  row is healed from Composio before it reads as disconnected
  (`healConnection`), and `startConnection` returns a live account rather
  than overwriting it. Every connection works for all their bots; nothing
  per bot (`gond_bots.toolkits` is read by nothing). A connect is a
  `signin` card with `composio:<toolkit>` (`composioCard`), fetching a
  fresh Connect Link on tap. `connect_app` checks Composio before pointing
  at `add_mcp_server`; keep that order. A bot never pastes a sign-in link.
- **The catalog is curated and indexed**: `APP_CATALOG` in shared is the
  set (a new app is a line there), narrowed by `curatedToolkits` and
  `COMPOSIO_TOOLKITS`. `catalogIndex` pages Composio's API through the
  client under the SDK (the SDK drops the cursor), cached ten minutes per
  key. `indexApps` (`src/catalog.ts`) precomputes squashed text, words and
  a character bitmask so a search is one integer test per app and nothing
  is allocated per keystroke; it is pure and tested. `/api/catalog`
  pages; `components/apps-card.tsx` uses shadcn `Pagination`.
- **MCP servers** (`src/mcp.ts`, `src/routes/mcp.ts`, `src/mcp-oauth.ts`):
  HTTP servers become a proxy URL with a per-server token; stdio ones
  pass as given. Each belongs to one person (names unique per person,
  404 to anyone else), and every enabled one attaches to all their bots
  (`mcpServersFor`). A changed config relaunches the session (the args
  key); refresh (`POST /api/mcp-servers/:id/refresh`) stamps
  `refreshed_at`, which becomes the server's `rev`. Keys ride as
  `{{secret:NAME}}` headers (`checkMcpHeaders` refuses a raw value, an
  unstored secret and `X-Gond-*`; `hasKeyHeader`); such a server is never
  sent to OAuth. A bot never builds a local wrapper to carry a key. A
  server needing sign-in stays off the session until signed in, and the
  proxy never answers a session with 401 (403 wrong token, 424 sign-in
  needed): Claude Code reads a 401 as an OAuth to run itself and digs in
  `~/.claude`. OAuth follows the MCP authorization spec with dynamic
  registration and PKCE, tokens encrypted in the row, refreshed one at a
  time per server (refresh tokens are often single-use; a refusal while
  the token works signs nobody out). The web only sees `authStatus`.
  `oauthRedirect: "localhost"` returns to `MCP_LOOPBACK_CALLBACK` (the
  desktop listens there; a browser pastes into
  `/api/mcp-servers/oauth/complete`). A desktop-started sign-in in the
  system browser hands back through the loopback with `via=app`
  (`mcpLoginHandBack`, ahead of the session check).
- **Skills** (`src/data/skills.ts`, `src/skills.ts`,
  `src/skill-bundle.ts`): a row is SKILL.md, `gond_skill_files` the rest.
  Mirrored to `~/.skills/<slug>/` in the person's home only (on change,
  at start, after a reset, before their first turn in a process). The
  system prompt has the index; `/slug` puts the skill in that turn's
  prompt. A routine with `skillId` posts `Use /slug.` from its owner's
  library only. `syncSkills(userId)` writes the mirror. Bots use `save_skill` and `update_skill`; a `.skill` is
  the folder zipped.

### People, notifications, updates

- **Notifications** (`src/push.ts`): Web Push (VAPID keys in the data
  directory) on every subscription. Push only when a bot finishes for the
  person or needs them, only when `bot.notify` is on, and only to devices
  that didn't mute that bot (`muted_bots`, `other`). `sendPush` also
  emits a `notify` event for the shells.
  Phones (`gond_push_devices`, per person, Android or iPhone,
  `src/phone-push.ts`) get each notice sealed for them alone (`sealNotice`, AES-256-GCM with
  the phone's key) and signed with this Gond's key (`signPush`), sent to
  the relay; a 410 forgets the phone. `registerPushDevice` hands out keys
  only to a phone it doesn't know. A card a phone may answer
  (`answerableOnPhone`: never an email) carries its buttons under a
  `card-<id>` tag and is withdrawn from the phones once closed
  (`offPhones`), quietly. `/api/push/answer` runs ahead of the session, taken
  only signed by the phone's answer key within five minutes
  (`answerSigned`), for a card of that phone's person. Nothing is pushed about a
  conversation on screen (`src/presence.ts`, since the service worker
  can't tell on an iPhone).
- **Check-ins** (`src/check-ins.ts`, `data/check-ins.ts`,
  `routes/check-ins.ts`, `gond_check_ins`, on by default per profile): the
  primary bot offers them once (`offerCheckIns`, fixed words from Gond,
  only after it has answered the person and nothing of theirs waits).
  Every `everyHours` outside the quiet hours, from the dispatcher's minute
  and outside `TURNS_PER_PERSON`, plain code gathers what's new in every
  conversation, cards waiting, stalled handoffs, the person's own lines
  (promises) and unread Gmail through Composio; only when that changed
  (`worthALook`) does one tool-less turn on the small model (`askOnce`,
  shared with the router) answer `NOTHING_NEW` or a line posted
  `check_in`. Nothing new means nothing is said. Email is set apart as
  outside text and never acted on. Stop in the primary bot's chat ends one
  (`stopCheckIn`); `set_check_ins` is the primary bot's tool.
- **OIDC** (`data/oidc.ts`, Better Auth's `genericOAuth` in `auth.ts`, a
  change calls `invalidateAuth()`): the first account is `admin`
  (`ensureAdmin`), everyone from the provider `user`; pre-user rows are
  adopted by the admin (`adoptOrphans`). `/api/auth-config` is the only
  public view. Linking the provider to the local account goes through
  Better Auth's `link-social` (`GET /api/me/sign-ins`), only for someone
  signed in; a sign-in that already made its own account is refused. The
  `auth-link` test runs it end to end.
- **Gond updates itself** (`src/release.ts`, `src/self-update.ts`):
  `GOND_VERSION` comes from CI ("dev" never offers to update). `GET
  /api/server/update` (admin) checks GitHub at most every ten minutes
  unless `?check=1`; notes are commit subjects (`releaseNotes`). `POST`
  pulls images, updates the computer (`updateComputer`), recreates web,
  and last starts a helper from the new API image to replace the API
  (`replaceSelf`), since a container can't recreate itself.
  `recreateContainer` drops what inspect folded in from the old image
  (env including the version, command, labels). Pages check `GET
  /api/version` on focus or reconnect and reload on change.

### Spaces

`src/spaces.ts` over `src/federation.ts` and `data/spaces.ts`. This
Gond's keys are made once and kept encrypted (`gond_federation.identity`);
it holds one `RelayClient` to its own relay (`GOND_RELAY_URL` or the
admin's) and one per other relay it sends to. Everything goes through
`gond_space_outbox` (sealed and sent with backoff, at once when a relay
reconnects, `outboxDueNow`), and arrivals are checked against
`gond_space_seen` (refused past 14 days), so restarts lose nothing and
nothing posts twice. A space is a room with the same id on each Gond
(`gond_spaces`); the creator hosts, guests send to it, it passes lines on.
Events (`parseEvent` checks everything from another Gond): join, welcome
(lines since it became a space, never earlier talk), refused, line,
members, leave, closed, gond.

- Lines go out from `onThreadEvent` (`outbound`); an edited room sends its
  members. Every line passes `spaceSafe` in `wireLine` on its way out,
  whoever posted it, which also hides stored values from
  `SHORT_SECRET` (4) characters as whole words. What crosses is only lines said there (a file as a note), members'
  names and colours and each Gond's name: never a card, file, memory or
  setting.
- The rules (`gond_space_rules`, `spaceDefaults`) gate what another
  Gond's line does in code, never only in the prompt: `peopleWake`
  (`wokenFromAfar`), `botsWake` (by @handle, within `MAX_ROOM_LINES`).
  `talk` and `look` answer as a guest (`answerAsGuest`,
  `guestInstructions`, memory only with `memory` on, a box guest session
  with no tools or only web, `guestReply`). `act` asks the owner
  (`askOwner`) whatever the bot's level; on a yes a hidden prompt has it do
  the task as Gond's own word with the request set apart (a yes inside
  quoted remote text reads like injected permission), the same words the
  card showed (`askedText`) and the asker's names only inside the quote
  (`actPrompt`). `full`, Always allow, skips the card: set per bot and
  space only, confirmed (`confirmed: true`), never a default, and put
  back to `act` with a line when someone new joins
  (`newcomersEndAlwaysAllow`).
- A line counts only from a member the Gond it's from declared in that
  space (`mayTakeLine`, on the host and every guest, the welcome's lines
  too; members are keyed by Gond, so one can't overwrite another's), and
  a member nobody can place is a bot to the rules, since no Gond can
  check what another says its members are. Every name from afar is one
  plain line (`plainName`). Members go out only when the list changed,
  after a short settle and in order with the lines (`membersSoon`,
  `inOrder`). Answers to another Gond wait in a lane per bot (`inTurn`,
  three waiting at most, the oldest giving way) that Stop aborts and
  empties (`stopGuestWork`), expiring an `act` card with it; a "stop"
  said in a space and the bot's account of it stay on this Gond
  (`keepHere`). "We checked the words" is each person's own
  (`gond_peer_checks`).
- Every space turn hears `SPACE_TURN` (public, no private reply). The
  person's own line wakes only bots it names (`spaceTargets`,
  `postInSpace`); `spaceNote`; `memoryAllowed`. Remote people are "not
  your person" in transcripts. `say_in_space` (rule `relay`, off by
  default) works only when the bot's own person asks in their chat
  (`message.author` is "you").
- Leaving, deleting the room or person, or turning Spaces off sends leave
  or closed first; Block removes a Gond everywhere, forgets it at the
  relay and drops its outbox. A join the relay refuses ends with a line.
  `test/spaces.test.ts` runs three real APIs and a relay.

### Show me how

`src/teach.ts` over `gond_teachings` and `gond_teaching_frames`
(`TEACH_STATUSES`). Starting records with `replace`, then takes the
screen for the person (`desktopControl`, `tookControl`), undoing the box
side on failure; `follow` reads `followRecording` and emits `teaching`.
`finishTeaching` moves steps and screenshots into the database and gives
the screen back, or waits for an away box. Private typing is hidden in
review; `beginLooking` sends `lookPrompt` with `keyframes`, answered with
`propose_skill` (`cleanDraft`). A look turn with no draft keeps the steps
(`lookTurnEnded`, `draftFromSteps`). Stop discards (`StopReport.recordings`),
a restart resumes (`resumeTeachings`), pictures expire a week after
(`expireTeachingFrames`).

## Box

- **The box is not a throwaway.** `/home/agent` (the admin's home) is a
  volume, with their bots' homes, package caches and Claude sign-in
  inside; `/home` is a volume for everyone else; `/state` keeps the
  token, the account register, sessions, teach recordings and set-aside
  logins. Never put state anywhere else.
- **One Linux account per person** (`accounts.mjs`): the admin is
  `agent`; everyone else `gond-<name>` (uid from 2001), `/home/<name>`,
  mode 0700, made with `useradd` on first use and again at start from
  `/state/accounts.json`, since `/etc/passwd` doesn't survive a recreate.
  Every home route takes the person from `X-Gond-User` (`accountFor`) and
  runs as them (`agentEnv(account)`, `asUser(account)`,
  `botDir(account, id)`); sessions and screens answer 404 to anyone else.
  Unix permissions in one container: real, not a hard boundary. Without
  root (a dev checkout) every account shares the process's user.
- Everything a bot runs is as its owner with `agentEnv(account)`;
  credentials are stripped first. Each person's `.claude` is never
  readable through the files API and survives Reset.
- In every home: `~/.team` (the person's `.team/<user id>`, its
  `MEMORY.md` loaded into their bots' turns), `~/.skills` (a link to
  `/srv/gond/skills/<linux name>`, root's, group-readable, written by the
  API through `/skills`), `~/.bots/<id>` (each bot's home). Hidden so the
  home looks like a person's.
- **New endpoints**: add to `route()` in `server.mjs`, keep the
  bearer-token check, take the account from the request, keep paths
  inside that person's home (`insideHome`, `boxCwd` with `account.home`
  and `forbiddenIn(account)`).
- Anything that uses the computer answers 503 while `update.sh` runs;
  reads of a bot's files still work. Node and the desktop come from the
  image; Bun is patched in place by `update.sh`, step per tool, each
  reporting and never stopping the next.
- **Reset.** `POST /reset` (`accounts.reset()`) removes every account
  and home, empties the admin's and clears skills mirrors, keeping only
  each person's CLI sign-ins in `/state/logins/<user id>`, restored by
  `ensure()`. A person's own reset (`home-reset-card.tsx` → `POST
  /api/box/home/reset` → the box's `POST /home/reset`) stops their bots,
  kills their processes and `refreshHome` empties it except `homeKeeps`
  (memories, `SOUL.md`, the team's, CLI sign-ins, browser profiles).
  Everything else is made again as used. `DELETE /accounts/:id` removes a
  person entirely.
- **Sessions** (`agents.mjs`): `AgentSession.spawn` resolves as soon as
  Claude Code runs and the prompt goes to stdin at once. A CLI too old
  for an optional flag (`OPTIONAL_FLAGS`, `FLAG_FLOORS`) exits before
  init, the turn ends `flagRejected` and is relaunched without them, as
  after a failed resume. Usage per result
  (`model_usage_since_last_result`, or the change in `modelUsage` on an
  older CLI) is a `usage` event; `rate_limit_event` is a `limits` event
  (`usageSince`, `planLimits`, `countUsage`).
- **Models** (`models.mjs`): Claude Code has no list, so it offers its
  aliases (`fable`, `opus`, `sonnet`, `haiku`, `opus` the default), which
  never go stale; only their labels carry versions, edited by hand. A CLI
  that can't answer returns nothing.
- **Sign-in** (`sign-in.mjs`): the CLI's own login in a pty as the
  person (wide so links don't wrap, `CI` dropped), the link parsed out,
  the code written back, the result confirmed by the CLI. Only the link,
  the code and a short error leave; never the transcript. Pure and tested
  (`test/sign-in.test.mjs`).
- **Guest sessions** (Spaces, `GUEST_MODES`): Claude Code with `--tools
  ""` (or only WebSearch for `look`; WebFetch never, since it reaches
  any address the box can), everything else denied, never skipped
  permissions, no MCP but the gond bridge, project settings only, a fresh
  mkdtemp folder removed with the agent (`guestDir`, `dropAgent`), no
  session kept. Below `GUEST_FLOOR`, or when the version can't be read,
  it refuses.
- **`POST /computer`** (`computer.mjs`): `{ bot, target, steps, saveTo? }`
  in real pixels, a sign-in pre-filled as `{ type: "type", text, secret:
  true }`. `parseSteps` checks every step (pure, tested; navigate is http
  and https only); the batch stops at the first failure and answers one
  screenshot with `done` and `error`, plus page data for the browser.
  After input the browser waits for the DOM to go quiet (150 ms, at most
  1.5 s); a dialog blocks everything but `dialog`. Clipboard through
  `xclip`. Desktop steps are xdotool argv (`xdotoolArgv`; text on stdin,
  never in an argument). Drags move in small steps (`dragPath`, `hold`),
  since drag-and-drop lists ignore a jumping pointer.
- **A screen per bot** (`screens` in `server.mjs`): its own display
  (`freeDisplay`), runtime dir `~/.run/screens/<bot>`, lock and Chrome
  profile `~/.config/gond-browser-bots/<bot>` (never opened by the files
  API, kept by a home reset); the old `~/.config/gond-browser` moves to
  the primary bot's (`primary`). Folders are made as the person
  (`prepareScreen`), never as root, since the paths are theirs to point
  anywhere. Starts on first batch or viewer, stops after 30 idle minutes;
  at most `GOND_SCREENS_PER_PERSON` (3), a fourth replacing the
  least-recent unwatched, undriven one (`screenToStop`) or refused with
  429 `screens_full`. `GET /desktop`, `POST /desktop/<bot>/control`
  (`from: "bots"` only frees what bots held), `/desktop/<bot>`,
  `/desktop/<bot>/connections`. Input while the person holds control is
  409 `person_has_control`. Every holder change goes through
  `changeControl`: while `bots`, `vncconfig` turns off Xtigervnc's
  `AcceptPointerEvents`, `AcceptKeyEvents` and `AcceptCutText`
  (`desktop.sh` passes `-AllowOverride`), so viewers' input is dropped by
  the server; xdotool goes through XTEST. The hold lapses after
  `BOTS_HOLD_MS`. Tool results take `content` as a string or
  `ToolPart[]`. `PUT /files/raw` writes up to 30 MB as the person; `GET
  /files/preview` answers a 1568 px JPEG by ImageMagick as the person
  (`preview.mjs`). `GET /stats` (`stats.mjs`, even while updating) is
  disk, memory and per account its bots, screens, browsers, memory (by
  uid from `/proc`, root only) and home size (a background `du`, kept an
  hour, never awaited); the API names the accounts (`healthOf`) for the
  admin's `BoxStatus.health`.
- **The browser host** (`browser-host.mjs`, started by `browser.mjs` as
  the person): a Playwright persistent context, Chrome headed and
  maximized, JSON lines on stdio so no port is open. It stays up between
  batches, closes after 30 idle minutes only while nobody watches
  (`watched`), and a host that stops answering is killed. Before every
  browser batch the window is maximized (`fill`, `maximizeWindow` over
  CDP), so whatever the person did to it never changes what the bot sees;
  a person's own window holding the profile is closed first
  (`freeProfile`). Stale profile locks from another hostname are removed
  (`clearForeignLock`, and the wrapper). Every Chrome starts through
  `google-chrome.sh`, which opens the screen's bot's profile
  (`GOND_BROWSER_PROFILE`). Every new tab opens the bot's homepage
  (`home/index.html` at `/usr/share/gond/home/`, `homeUrl`, `lookOf`); a
  fresh screen shows it at 70% centred (`windowArgs`, `browsers.open`),
  and a bot's first desktop batch waits for it (`browserShown`).
- **The desktop** (`desktop.sh`): Xfce (xfwm4, xfdesktop, xfsettingsd, no
  session manager or panel) with a Plank dock that reserves its strip and
  is restarted if it crashes or the screen size changes. Settings via
  `dconf` (no `gsettings` in the image) wherever the person hasn't set
  their own; the look is system defaults in `xfce/` copied to `/etc/xdg`,
  so a person's changes stay in their `~/.config`.
- **Recording Show me how** (`recorder.mjs`, `recordings.mjs`,
  `teach-script.mjs`): the person's input is read from their VNC messages
  (`createRfbReader` from a connection's first byte, `createInputTracker`);
  a bot's goes through XTEST and never passes there. `teachPage` in the
  bot's Chrome reports clicks, typing, picks and submits; a password,
  code or card field is reported by kind only, its value never leaving
  the page. Screenshots are shot as the person, read back without
  following links (`readFrame`) and kept under `/state/teach/<user>/<id>`,
  root's alone; leftovers go after a week (`sweep`).

## Before a commit

```sh
bun run lint
bun run typecheck
bun run test
bun run --filter @gond/web build
```

All four green, then screenshots of what changed in light and dark when
it is UI (Playwright against the dev servers works; Chromium is at
`/opt/pw-browsers/chromium` in the remote environment).

Comments only where they say what the code can't: a non-obvious why, a
security invariant, a workaround for someone else's bug, a spec
reference. A name, a type or a test says the rest, and CLAUDE.md holds the
prose. Keep this file to rules and pointers: a new feature gets a line
saying where it lives and what must not change, not a walkthrough.

Commit messages: a short subject in sentence case, then a paragraph or a
list saying what changed and why, written for the person reading the log.

## Things that stay true

- One local account per install, the admin; the setup token gates its
  registration. Everyone else comes through the admin's OIDC provider
  and is a user.
- All bots share one computer; every person has their own Linux account
  on it (home, bots' files, CLI sign-ins, a screen per bot). Separate
  bots are not a security boundary; separate people are Unix permissions
  inside one container, not a hard boundary either. The container and the
  unprivileged users are. In the database every bot, conversation,
  connected app, Composio key, MCP server, secret, skill, AI setting and
  provider belongs to a profile, push subscriptions to a person, and a
  route never returns another profile's.
- Everyone's bots run on their own plan or key. Nothing about the AI is
  shared, and nobody falls back to the admin's.
- The web app never talks to the box; the API does, with a bearer token,
  over the Compose network.
- Another Gond only ever gets what is said in a space it is in, the
  members' names and colours and this Gond's name, sealed end to end
  through a relay. A line from it is untrusted: it can't make a bot act
  without its owner's yes, unless the owner confirmed Always allow for
  that bot in that space.
- The Docker socket on the API exists only for updating (Shared computer
  → Update and Reset, and Settings → About). Nothing else may use it.
- A stored secret is never returned by a route, never written in plain
  text, never in a message: only injected by the API at the point of use,
  as `type_login` keystrokes (xdotool's stdin or the browser host's) or
  in one `run_with_secrets` command's environment, never in an argument
  or a log, its output scrubbed.
- `.env` never holds anything checked in. `.env.example` is only what a
  person sets: `APP_URL` and `GOND_SECRET_KEY`. Anything with a safe
  default is made or chosen in code and listed in the README's Advanced
  settings. The API finds the Docker socket's group itself
  (`apps/api/docker-entrypoint.sh`). Names are `GOND_*`.
