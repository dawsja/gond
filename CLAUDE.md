# Gond: how we build it

Read this before changing anything. It keeps new features consistent with
what is here. The README says what Gond is; this says how it is made.

## The shape

- Bun workspaces monorepo. **Bun for everything, never npm or npx**: `bun
  install`, `bun run`, `bun x` / `bunx --bun`, `bun test`.
- `apps/web`: Next.js (App Router, React 19) + shadcn (base-ui primitives,
  "nova" style) + Tailwind 4. Talks to the API through `/api/*` rewrites,
  so one origin and one cookie.
- `apps/api`: Hono on `Bun.serve`, `bun:sqlite`, Better Auth (one account).
  Owns the database, drives the box, runs the dispatcher that answers
  messages and fires routines.
- `packages/box`: the bots' computer. Plain Node ESM (`.mjs`), no build
  step, runs as root only to drop to the `agent` user. Persistent CLI
  sessions: Claude Code in `agents.mjs`, Codex (`codex app-server`) in
  `codex.mjs`, Grok (`grok agent stdio`, ACP) in `grok.mjs`, all on the
  shared base in `bridge.mjs`; the `gond` MCP bridge in `gond-mcp.mjs`.
- `apps/desktop`: Rust and Tauri v2, a Windows installer (NSIS) and a
  Linux AppImage. It ships one page of its own (Connect, `src/connect.*`,
  drawn with the web's tokens); after that the window loads the Gond you
  connected to, so every other screen is the web app. `window.gondDesktop`
  is the only bridge: `src-tauri/src/init.js` injects it into every page,
  and every command it reaches in `bridge.rs` checks the page's current
  origin against the saved server before doing anything, the way Android's
  `fromTrustedPage` does. The address rules live in the `server-url` crate
  with the same tests Android's `ServerUrl.kt` has. The menu bar is hidden
  unless the person turns it on (`menu_bar` in `config.json`, the switch in
  Settings → Account's This app card, applied to every window). The package scripts go
  through `scripts/cargo.mjs`, which skips with a notice where cargo is
  missing and fails in CI. It updates itself (`updater.rs`, the updater
  plugin): 5 s after start and every 6 hours it reads `latest.json` from
  the latest GitHub release, downloads a newer build in the background and
  installs it on quit or from "Restart to update" in Settings → Account.
  Only a build signed with the repository's key installs; CI signs with
  the `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
  secrets and writes `latest.json` in the release job. The private key
  never goes in the repo; the public one is in `tauri.conf.json`.
- `apps/android`: Kotlin, Gradle, one activity. Like the desktop, it
  ships one screen of its own (Connect, native, drawn with the web's
  tokens in `res/values*/colors.xml`) and then shows the Gond you
  connected to in a WebView, so every other screen is the web app.
  `gondMobile` (`GondBridge.kt`) is the only bridge; keep it that small, and
  every action on it goes through `fromTrustedPage` so a page from another
  origin (an OAuth provider mid sign-in) can't use it. `ServerUrl.kt`
  mirrors the desktop's `server-url.mjs`, with the same tests. The app is
  edge to edge: your Gond's pages draw under the status and navigation
  bars and the activity hands their sizes to the page as
  `--shell-inset-*` (`layoutFor`/`pushInsets` in `MainActivity.kt`; only
  the keyboard pads the window), while Connect and any other origin's page
  stay between the bars. Build with
  `gradle assembleRelease` in `apps/android` (ANDROID_HOME set); CI does.
- `packages/shared`: types, zod schemas, constants, templates, the app
  catalog. If web and api both need it, it goes here.
- `docker-compose.yml` runs the three services; CI builds the images and
  publishes them to GHCR.

## Web

- **Use shadcn, don't hand-roll.** The skill is in `.agents/skills/shadcn`
  and its rules apply: forms are `FieldGroup`/`Field`, option sets are
  `ToggleGroup`, callouts are `Alert`, empty states are `Empty`, confirms
  are `AlertDialog` (never `window.confirm`), notices are `toast`, chat is
  `MessageScroller`/`Message`/`Bubble`/`Attachment`/`Marker`, the sidebar
  is the `Sidebar` block, menus are `DropdownMenu` with items in groups,
  `Select` items in `SelectGroup`. Add a component with
  `bunx --bun shadcn@latest add <name>` from `apps/web`; check
  `components/ui` first.
- **Customize in `components/ui`, not at call sites.** The primitives are
  already themed (pill buttons, taller rounded inputs on the card surface,
  the `pill` toggle variant, the animated slider). If a look is needed in
  several places, change or extend the primitive; `className` on a call
  site is for layout.
- **Colours are tokens.** One primary for actions: `bg-primary` /
  `text-primary-foreground`, a white pill in the light and a grey one in
  the dark. Every main button, the circles on the phone's screens and the
  bot's name pill use it. Bubbles have their
  own greys: yours is `bg-bubble-you`, a bot's `bg-bubble-bot`, a step
  lighter. Send is a primary circle inside the composer pill. A control's
  on state (switch, checkbox, radio, slider, pressed pill) is `bg-control`
  / `text-control-foreground`, ink in both themes, so on and off always
  read; `variant="control"` on a button is for the rare one that must. Everything
  else is one pill: a slight grey `--primary-edge` draws it in both themes
  and nothing else does (`--primary-shadow` is `none`), so a button, a
  circle, a field, a select and a toggle read as the same object at any
  size. It is filled with `bg-primary` when it is a main action or a field
  you type into (`Input`, `Textarea`, `Select`, `InputGroup`), and
  transparent with the same edge when it is secondary
  (`variant="outline"`, a toggle until it is pressed). A focused field
  steps to `--primary-edge-focus`, never a ring, which reads as a band on
  the light page and vanishes on the dark one. There is no brand colour:
  ink on paper in the light, Material's dark theme (#121212, elevation by
  a lighter grey) in the dark, and the bots are the only colour on a page.
  The exceptions are markers, each a token: your bubble's blue, the
  primary bot's gold crown (`--gold`), and the tones of a status
  (`--tone-ok`, `-warn`, `-bad`, `-info`). Secondary actions are `variant="outline"`, tertiary
  `ghost`, destructive `destructive`. Use `text-muted-foreground`,
  `bg-card`, `bg-muted`, `border` and friends; never raw Tailwind colours,
  never `dark:` overrides by hand, never the old `bg-carbon` /
  `text-graphite` / `bg-paper-white` names outside `globals.css`.
  Nothing draws a scrollbar: `globals.css` hides every one, for every
  scroller, and the desktop's Connect page and the Android app's views do
  the same. Scrolling itself is untouched. shadcn's `scroll-fade-*`
  utilities are not used anywhere (WebView2 and WebKitGTK drew them as a
  permanent fade). The one fade is a conversation's, top and bottom only
  (`MessageScrollerEdges` in `ui/message-scroller.tsx`): two strips in the
  page's background, from solid at the screen's edge to clear a little
  past the header's pills and the composer, so what scrolls under them
  fades into the page and stays legible. There is no blur. Each strip's
  opacity follows how far there is to scroll, measured in script, so at
  the very top or bottom that edge has none. Never style a scrollbar, and
  never fade the sides.
- **Every pop-up is one object.** A dialog, a confirm, a sheet and the
  computer's window are a `bg-card` card with the `--primary-edge`
  edge, `rounded-3xl`, `shadow-subtle-3`, over a `bg-black/60` backdrop
  with no blur; fields inside are `bg-primary`, so they read on it. The
  close is a primary circle (`icon-lg`, 44px under a coarse pointer),
  the title `text-lg font-semibold`, and the footer has no band: its
  buttons are `lg` pills, full width and stacked on a phone. Menus, a
  `Select`'s list and popovers are a `rounded-2xl` card with the same
  edge and `h-9` rows on every pointer. All of it lives in
  `components/ui`; a call site only sets its width.
- **Both themes, every time.** Check light and dark. Field edges, rings and
  fills must read on both.
- **Phones first, one screen at a time.** Under `md` the app is a
  messaging app: `/app` is the Chats screen (`chats-screen.tsx`, the same
  list the sidebar draws: your picture top left opens Settings, Search and
  New are circles top right, Search swaps in the field; pinned bots are a
  row of big faces above the list, `PinnedTile` in `sidebar.tsx`), a conversation is a full screen with floating
  pills over the page, never a bar: the header is absolute and the messages
  scroll under it, so only the pills themselves cover what was said (the
  strip between them is `pointer-events-none`). They are a back chevron,
  the bot (tap it for the details sheet, the right panel's content; on a
  wide screen, where that panel is already beside the chat, it opens Edit
  profile) and a
  menu with the bot's actions
  (`thread-actions.tsx`, shared with the sidebar's long-press menu; under
  `pointer-coarse:` menus are large rounded cards). The composer is an
  attach circle beside a pill that holds the text and the send button, on
  every screen size, and it floats the same way at the bottom: the
  messages scroll under it, padded by its measured height
  (`--composer-h`). There is no bottom bar: the app
  opens on Chats, Settings is behind your picture (with Open the computer
  as a row for the admin), and every screen goes back with its chevron or
  a swipe in from the left edge (`hooks/use-swipe-back.ts`).
  `/app/settings` is the list of sections on a phone and the account on a
  desktop. Wide and narrow are CSS, not `useIsMobile`, so the server's
  HTML is right for both: layout code says `wide:` and `xwide:` (the
  variants in `globals.css`), which are `md` and `lg` except inside the
  Android app, where the phone layout applies at every width (the theme
  init script marks `<html data-shell="android">` before first paint).
  Everything at an edge pads with `var(--safe-top)`, `var(--safe-bottom)`
  and friends, never `env(safe-area-inset-*)` directly: the `--safe-*`
  tokens in `globals.css` take the larger of `env()` and what the Android
  app reports, since a WebView's `env()` can't be relied on; a
  `Dialog` is a sheet from the bottom under `sm`. A `Select`'s list is
  never a sheet and never sits over its box: it drops below it, starting
  at its left edge, on every screen (`alignItemWithTrigger` off in
  `ui/select.tsx`), drawn like a `DropdownMenu`, with the same large
  rounded card and rows a thumb can hit under `pointer-coarse:`; touch
  targets are 44px;
  anything revealed on hover is always shown under `pointer-coarse:`; on a
  touch keyboard Enter is a new line and the send button sends
  (`useCoarsePointer`). Nothing takes focus on its own when a screen
  opens, so the keyboard stays down until a field is tapped.
- **The apps around the web app** are found with `lib/shell.ts`
  (`useNativeShell`, `shellBridge()` for whichever bridge wraps the page,
  `mobileShell` and `desktopShell` for one of them), never by touching
  `window.gondDesktop` or `window.gondMobile` directly. The desktop's calls
  answer promises and an older desktop may lack a method, so check it is a
  function before calling. In the Android and the desktop app there is no
  Web Push: the API's `notify` live event becomes a native notification
  through the bridge (`shell-notifications.tsx`), the theme provider hands
  the page's background to the bars and the window around it, and Settings
  → Account shows the server the app is pointed at with a Change server
  button. Signing out in an app ends only Gond's session (`useSignOut`
  passes `disableRedirect`): the app signed in through the system
  browser, so the provider's session lives there, and its logout page,
  being another origin, would open there too.
- **No hydration surprises.** Anything that depends on storage, the
  viewport or the clock renders the server's value first
  (`useSyncExternalStore` with a server snapshot), then the real one.
  Effects that set state do it off the effect's own tick
  (`Promise.resolve().then(...)`), which is what the lint rule wants.
- **Live data flows through the store.** `components/store.tsx` holds bots,
  threads, approvals, activity, you (`me`) and the box update; it refetches
  on `/api/events` topics. Add a topic in `packages/shared` and handle it
  there rather than polling from a component.
- **A bot's screen is live in its conversation.** The store holds
  `desktop` (`DesktopState`: loaded from `/api/box/desktop`, replaced by
  every `desktop` event; a 503 while the computer updates leaves it as it
  was). `hq/box-desktop.tsx` is `DesktopView` (one noVNC connection, the
  canvas, paste and the phone keyboard; `viewOnly`,
  `quality: "thumb" | "full"`, `onStatus`, and it only connects while it
  has a size, so a hidden panel holds no connection), `DesktopToolbar`
  (the status as an icon, a green check while connected and a grey cross
  when not, `ControlChip` with `DESKTOP_CONTROL_LABELS`, Take control /
  Give control back, Keyboard, Hide; no Ctrl+Alt+Del and no full screen)
  and `DesktopFrame`. `DesktopScreen` (`hq/desktop-screen.tsx`) is those
  together at full size, view-only while a bot is driving, and
  `BoxDesktop` (the computer panel) is one. On a wide screen it is a
  window that is only the screen (about two thirds of the app's width, in
  16:10, so the app stays in view around it), with the toolbar's pills floating above
  it on the dimmed page like a conversation's header (the bot and its
  status, what the control is, Take control, ×), never a bar; under `wide:` it is the page itself: the
  desktop fitted to the width with floating pills like a conversation's
  (back, the bot, `?` for the full-page help, ⋯ for Take control or I'm
  done, zoom, trackpad mode), the clipboard (Copy to phone, Paste from
  phone, which falls back to a field when the phone won't share its
  clipboard) and the keyboard as circles in the bottom corners. Going back
  gives control back. Nothing resizes the session: every view, wide or
  narrow, sees the bots' own 1280 by 800 fitted inside it (Xtigervnc runs
  with `-AcceptSetDesktopSize=0`), so the person sees a whole page
  smaller rather than a cramped one, and the bots' coordinates hold. Zoom is the view's, not noVNC's: noVNC
  still reads the touches (tap, hold, drag, two-finger scroll) and its
  gesture events pass through `DesktopView`'s stage on the way to its
  canvas, so a pinch is taken there and zooms a sizer the remote screen is
  fitted into (`fittedSize`), and zoomed in, two fingers move around
  instead of scrolling. Trackpad mode keeps a pointer of its own and sends
  noVNC's taps, drags and scrolls again at it. `screen-panel.tsx` is the same for a
  conversation: compact, a 16:10 thumbnail in the right panel's frame with
  a Live dot and the control chip, tap to expand; expanded, a full frame
  the conversation owns (`screen` state), so the compact view unmounts
  while it is open and there is one connection per visible view. The
  right panel shows it when `desktop.drivers` names the thread, else the
  grey placeholder; on a phone a "Watching the screen" pill under the
  header opens it; the thread menu says "Watch its screen" meanwhile.
  Taking control is `POST /api/box/desktop/control` (`changeDesktopControl`
  in `computer-panel.tsx`); the result arrives as the `desktop` event.
- **A bot can wear a picture instead of its mascot.** Edit profile uploads
  one through the same picker as your own (`usePicturePicker` in
  `picture-crop-dialog.tsx`): it is placed in a circle (drag, zoom) and
  saved as a 512 px square PNG, the circle drawn by CSS wherever it shows;
  a GIF goes as it is so it keeps moving. The API trusts only the bytes
  (`pictureType` in `src/images.ts` sniffs PNG, JPEG, GIF and WebP, so an
  SVG named `.png` is refused) and keeps it in `gond_bot_avatars`;
  `Bot.avatar` is its URL with a version, or null. `BotAvatar` draws the
  picture when there is one, crown and all.
- **Reactions are a chat's tapbacks** (`REACTIONS` in shared: 👍 ❤️ 😂
  😮 😢 🙏), one per author per message (`gond_message_reactions`,
  `setReaction`). The person reacts to a bot's message from its context
  menu, right-click or a long press, the row of emoji above Copy
  (`components/reactions.tsx`); tapping theirs again, or its badge on the
  bubble's corner, takes it off. A change is the `reactions` live event
  with the message's reactions as they stand, merged into the list in
  place, since a `thread` event only appends.
- **Steps are recorded, never shown.** While a bot works the conversation
  shows one line of what it is doing (`WorkLine`); the work log behind it
  is kept by the API but the web never lists it.
- **Mascots come from the gond-bot skill** (`components/hq/gond-bot.tsx`),
  copied 1:1. Don't redraw the cog. A bot's `shape` (`BOT_SHAPES`) picks
  its body: the cog, always the default, or a gumdrop, cloud, circle or
  rounded triangle (`BODIES`), each drawn in the cog's box under the same
  eyes, expressions and animations; only the cog spins on a tap. A new
  shape is a path there and a name in `BOT_SHAPES`.
- **A bot's message is GitHub Markdown** (`lib/markdown.ts`): mdast via
  `mdast-util-from-markdown` with the GFM and directive extensions, and
  `components/markdown.tsx` walks the tree into React, so nothing a bot
  writes is ever injected as markup. Raw HTML is shown as text (an inline
  `<br>` becomes a line break), a link gets an href only for http, https
  or mailto (`safeHref`; anything else is plain text), footnotes stay
  literal, and an image is a link with its alt as the text: a bot hands
  over a file with `send_file` and it becomes an attachment. Headings are
  styled text with `role="heading"`, never h1–h6. `> [!NOTE]`-style
  callouts, task lists, tables with alignment and fenced code with the
  language label and Copy are all there. Two chat blocks ride on the
  directive syntax (`components/chat-blocks.tsx`): an inline
  `:badge[Label]{tone=ok}` is a `Badge` with the tone variant (ok, warn,
  bad, info, neutral) and a leaf `::meter{value=6 label="…" text="6% used"
  left="…" right="…" tone=ok}` is a `Progress` with a label row and
  captions. `badgeOf` / `meterOf` say when one is well formed; any other
  directive, a container, or a malformed one renders as its raw source, so
  `Note:this` and `:smile:` survive. The `## Formatting` section of the
  system prompt (`souls.ts`) tells a bot to use them, with figures in a
  right-aligned table and a bold label for a key fact. `plainMarkdown` in
  `packages/shared` is the dependency-free reduction to one line of words,
  for a push notification's body; `plainText` in the web does the same
  from the tree. Anything a person has to act on (a sign-in, a key) is a
  card, not a link. Every one of them is built on `action-card.tsx`, one
  shell in the same grey with the same edge as a button or a field: the
  approval in `conversation.tsx`, then `secret-card.tsx`,
  `login-card.tsx`, `signin-card.tsx` and `connect-card.tsx`. A new kind of card goes there
  too, so they never drift. What is waiting is said by the buttons inside,
  never by a colour on the card; the approvals badge in the list carries
  the amber.
- **Settings is sections, not a scroll.** `SETTINGS_SECTIONS` in
  `lib/settings-sections.ts` is the list (account, team, ai, computer,
  skills, apps, secrets, auth), each marked `admin` or not; the route
  `/app/settings/[[...section]]` maps to it and 404s a user on an admin
  section. Settings never opens the computer: a bot's panel does
  (`right-panel.tsx` → `openShellDialog({ kind: "computer", botId })`),
  and keeping it running (Update, Reset, what is installed) is the
  `ComputerCard` inside Team, the admin's. `useStore().admin` hides the
  admin's things elsewhere ("Open its computer", the computer section of a
  bot's details). A new card goes into an existing section, or a new entry there
  with a URL the API and the bots can point at (`Settings → Apps → MCP
  servers` in copy). Sign out is in the sidebar footer's profile menu on a
  desktop and the last row of the Settings list on a phone (`useSignOut`).
  `about-card.tsx` ends the Account section with the link to the
  repository; Account is the one section everybody has, so anything for
  every person goes there.
- Copy is plain English in sentence case, short, no exclamation marks. Say
  "the computer" to the person, "the box" in code and docs for developers.

## API

- Routes live in `src/routes/*.ts`, one file per area, mounted in
  `app.ts`. Everything under `/api` needs the session; unsafe methods must
  be same-origin (already enforced in `app.ts`).
- Data access lives in `src/data/*.ts`. A write that the UI should see
  emits an event through `src/events.ts` (`botsChanged`, `threadChanged`,
  `settingsChanged`, or `emit({ topic })`). The web hears it on
  `/api/events`.
- **Migrations are append-only**: add a new SQL string to `MIGRATIONS` in
  `src/db/migrations.ts`; never edit an earlier one. A new enum value in a
  `CHECK` means rebuilding that table in a new migration (see the messages
  table in migration 6), and a data test that writes the new value. Settings that apply to
  the whole team go in `gond_settings`; binary things (attachments, your
  picture) are blobs in their own table.
- Anything that runs on the box goes through `src/box.ts`. The API never
  reads the Claude sign-in and never sends connected-app credentials to
  the box; app actions run through Composio in the API.
- **Connected apps are each person's own** (`src/composio.ts`). Everyone
  sets their own Composio project key in Settings → Apps, or gives it to a
  bot that asks with `set_composio_key` (`src/data/composio-keys.ts`,
  encrypted and write-only like a provider key; both paths go through
  `applyComposioKey`, which forgets what the old key connected); the admin
  falls back to `COMPOSIO_API_KEY`, nobody else does.
  Connections are rows per user, and every Composio call takes the
  person's id: `toolsFor`, `executeAction` and `startConnection` run on
  that person's key and their own connection, never anyone else's. A new
  key for a different project forgets the old project's connections.
  A row that isn't active is healed from Composio before anything says
  it isn't connected (`healConnection`), and `startConnection` hands
  back a live account rather than writing a fresh link over it, so
  asking again never disconnects a working app.
- **The marketplace is curated**: `APP_CATALOG` in `packages/shared` is
  the apps a person can connect (Google's working set, Outlook, GitHub, Notion, Slack, Alpaca),
  and `curatedToolkits` narrows everything to it, `COMPOSIO_TOOLKITS`
  narrowing further when set. Names, logos and descriptions still come
  from Composio: `catalogIndex` pages through their API (the SDK's own
  list drops the cursor, so it goes through the client under it) and
  keeps the result per key for ten minutes. A new app is a line in
  `APP_CATALOG`. **The catalog is indexed, not
  scanned**: `indexApps` (`src/catalog.ts`) reads every name, slug,
  category and description once into squashed text, its words, and a
  bitmask of the characters it holds, so a search is one integer test per
  app and then scoring — nothing is allocated per keystroke. The search is
  forgiving (a few letters in order: `gsheet` finds Google Sheets) and
  pure, so it is tested without a network. `/api/catalog` answers one page
  at a time and Settings → Apps is a page and shadcn `Pagination`
  (`components/apps-card.tsx`), with the search field only once there is
  more than a page, and what you have connected kept at the top. Like an
  MCP server, a connected app works for every one of the person's bots
  (`toolsFor(userId)` is every active connection); nothing is picked per
  bot, and a bot's old `toolkits` column is read by nothing.
- **Three approval levels, and none gates a bot's own folder.** `ask`
  ("Always ask"), `auto` ("Auto", the default for a new bot) and `full`
  ("Always allow") are the whole set. Reading is never gated, and nor is a
  change a bot makes inside `~/.bots/<id>`: that folder is its desk, so
  `inOwnHome` in `src/approvals.ts` lets it through at every level. Past
  that, `full` allows everything; `ask` sends a card and waits for every
  shell command, file elsewhere and connected-app action; `auto` lets
  those through unless `mustAsk` says otherwise (a forced push, sudo, a
  download piped into a shell, `rm -r` outside its home, an app action
  that sends, deletes, pays, transfers or publishes, adding an MCP server)
  and trusts the bot to call `ask_approval` before anything irreversible
  or outward-facing, which posts the same card; "Always allow" on that
  card saves no rule. The level is read at the moment it decides, not from
  the object the turn started with (`requestApproval` re-reads the bot),
  because a turn runs for minutes and changing the level while a bot works
  is exactly when a person does it. The box only ever hears `ask` or
  `full` (`PERMISSION_MODES`, `boxPermission`): `auto` goes to it as
  `ask`, so every prompt comes to the broker, which answers the free ones
  itself.
- **Tool calls are labelled in one place.** `toolLabel` in `packages/shared`
  turns a raw tool name and input into the words a person sees (the
  activity line, the work log, the approval card, through `approvalLine`
  and `ruleLabel`); the box sends raw `{ tool, input }` and never
  pre-formats; nothing that matches on a name (`READ_ONLY`, the rules,
  `Approval.tool`, `--allowedTools`) changes. A quiet step (`isQuietTool`:
  memory writes) is recorded in the work log with `quiet: true` and never
  becomes an activity line.
- **Every bot is an assistant first.** The CLIs' own system prompts make
  the model a coding agent and ours is only appended to them (Claude Code's
  `--append-system-prompt-file`, Codex's `developerInstructions`), so
  `systemPromptFor` opens with `assistantFirst()` on every engine: answer
  as an assistant, in plain words, and work as an engineer only when the
  person asks for software or the bot's role is technical. Connected apps
  are listed with their tool prefix (`NOTION_…`) so a bot calls them
  instead of searching its files. The CLIs' own folders (`~/.claude`, `~/.codex`,
  `~/.grok`, `~/.claude.json`) are theirs: `touchesEngine` in
  `src/approvals.ts` refuses a shell command or a file change that
  reaches into them, before any approval, wherever the broker sees it,
  and the house rules say bots, skills and routines from another app are
  a brief to make with Gond's tools.
- **A session hears only what's new.** The CLIs keep a conversation in
  their own session, so `botTurn` sends two prompts: the full one (house
  rules, the last `CONTEXT_LINES` messages) and a `followUp` with only
  what arrived since that agent's last turn (`seenBy` in
  `src/responder.ts`, dropped on a failed turn). The box picks
  (`turnPrompt` in `packages/box/sessions.mjs`): the follow-up only when
  the session is one it resumed, never a fresh or recovered one. Session
  ids survive a restart in `/state/sessions.json` (`createSessionStore`),
  per agent, person and engine, forgotten with the bot, the person or a
  reset. What drops out of the window is folded, `SUMMARY_BATCH` at a
  time, into `gond_thread_summaries` (`src/summaries.ts`) by a one-turn,
  tool-less call on the person's own engine after a reply, redacted
  before it is kept; the full prompt carries it as "Earlier in this
  conversation, summarized".
- **Routines are the bots'.** A routine is made, changed, run or removed
  only by asking its bot (`create_routine`, `update_routine`,
  `run_routine`, `delete_routine` in `src/tools.ts`, with an optional
  skill by slug). The person sees each one (`routine-dialog.tsx`:
  `RoutineDetails`: when it runs in words, from `describeSchedule` in
  `lib/schedule.ts`, never the cron, then its prompt and skill) and
  switches it on or off; `PATCH /api/routines/:id` takes `enabled` and
  nothing else, and there is no route that creates, edits, deletes or
  runs one, or lists its runs. A run shows in the chat as one line, a
  clock and the routine's name (`routineName`), never its prompt. A bot
  with nothing new to say answers a run with exactly `NOTHING_NEW`
  (`QUIET_REPLY`, `isQuietReply`): the responder posts nothing, pushes
  nothing and drops the run's message, so a quiet run leaves no trace.
- Long work is started by the dispatcher (`src/dispatcher.ts`) and awaited
  in the responder (`src/responder.ts`); a tick stays quick. While the
  computer updates or resets (`src/updater.ts`), nothing new starts and
  pending messages wait. The dispatcher also chases stalled handoffs
  (`src/nudges.ts`) about once a minute. With `GOND_TURN_TIMING=1` (off
  by default, `turnTiming()`) every turn logs one line when it ends
  (`timingLine` from `createTurnClock` in `src/work.ts`): how long it
  took, on what, its model rounds and its tool calls, the screen's apart,
  so `docker compose logs api | grep took` says where a slow turn went.
- **Only handoffs nested in handoffs are hops.** `MAX_CHAIN` stops bots
  waking each other forever. A result lands a hop up from its brief
  (`resultDepth`), and a teammate that hands part of its task on keeps its
  own handoff open (`parentId`) until the last of those results is in, so
  the real result goes up the chain as results, never relayed with
  `message_bot` a hop deeper each time. A handoff whose run broke (a long
  task out of time) says so in its failed result, not in an incident a
  hop deeper, so a "carry on" brief is never further down than the first.
- **What bots say to each other stays between them.** A reply to a
  teammate's message (`message_bot`, `ask_bot`) is posted into the
  sender's conversation with `fromThreadId`, already answered, so it shows
  there as "Message from …", opens the exchange, and wakes nobody
  (`deliverReply` in `src/responder.ts`); a handoff's result goes up the
  chain from `reportBack`. Neither is ever a bubble in the person's chat
  with the bot that answered. Only a result coming back to the bot that
  handed the task out is for the person, in its own conversation. A bot a
  teammate's message woke tells the person what is for them with
  `post_message`, which posts in its chat with them and, for a turn a
  teammate started, sends the push the final answer won't.
- **Stop means stop, and everything it started.** `stopThread`
  (`src/responder.ts`) is what Stop runs: the turns in the conversation
  are aborted with the reason `"stopped"` and given a moment to wind down,
  then everything waiting there is dropped (the person's queued messages
  too), and the handoffs it gave out (down the chain), what it sent
  teammates and its follow-ups are called off, and a handoff to it closes.
  `ask_bot` turns end with
  the turn that asked, and an approval a stopped turn waited on expires.
  A stop is never an incident, whatever the engine made of it: a CLI's
  stream just breaks, so `botTurn` asks the signal (`stopCauseOf`,
  `unansweredEnding`), never the error. `stopAll` is `stopThread` over
  every conversation of a person's, run when they are deleted. Anything new
  that can wake a bot later (a timer, a queued message, a handoff) has
  to be called off here too, or it will start stopped work again.
- **"stop" in the chat is Stop.** A short message that is only a stop
  (`isStopRequest` in shared: "stop", "cancel that", "quit", "never
  mind"; "cancel the order" is not one) while anything runs in the
  conversation goes to `stopFromMessage` instead of steering: it is posted
  answered, `stopThread` runs quietly and returns a `StopReport`, and the
  bot that was working posts `stoppedReply`, its exact account of what
  halted. There is no Stop button anywhere, in a conversation or over
  all of them; the web's only stop is that message (the composer's
  `interrupt` call is the same `stopThread`). A bot can't be duplicated
  and a conversation can't be cleared: neither has a route.
- **A message to a working bot steers it.** When every bot a person's
  message is for is already working in that conversation,
  `postFromPerson` (`src/responder.ts`) hands it to their running turns
  instead of queueing it: the model works it in at its next step and the
  turn's one reply covers it. The message is posted `steered` (the web
  says "Sent while working") and put back to wait if no turn took it.
  "Send after it finishes" in the composer, and anything with files,
  waits as before. Only a person steers; routines, teammates and hidden
  prompts always queue. Each driver steers its own way (`steer` on the
  session, `POST /agents/:id/steer`): Claude Code reads another stdin
  message, known to be read by `--replay-user-messages`; Codex takes
  `turn/steer`; Grok's prompt is cancelled and the words sent next; the
  `api` engine's loop reads a `SteerQueue` between steps. A driver that
  can't take it answers false, never guesses.
- **The AI is each person's own** (`src/data/ai.ts`, Settings → AI for
  everyone). `enabled` is the engines they turned on, `engine` the one in
  use (always one of them), and `engines[engine]` its model. A CLI always
  runs on their plan; a key is the `api` engine's, so nothing can be left
  pointing at a key with no way back. How hard a model thinks is the
  model's own business: nothing sets it, and there is no setting for it.
  The Engine card
  is only ever about the plan: an engine is put on a key, or taken off it,
  by the switch on that key under API keys, and removing a key puts its
  engines back on the plan (`releaseEngines`). So nothing but that card
  writes `access`;
  `src/engines.ts` turns that and the owner's providers into what the box
  gets. A plan is the CLI signed in inside the person's own account on the
  box, which Settings → AI can do for them without a terminal
  (`/api/box/engines/:engine/sign-in`, `components/engine-signin.tsx`); an
  API key is one of their own providers. Models come from the engines
  themselves (`/api/models` in `routes/llm.ts`, one group per enabled
  engine): `codex model/list` over its app-server, `grok models`, Claude
  Code's aliases, and a key's own `/models`. Nothing here keeps a list of
  model names; picking one says which engine runs it, and any id can still
  be typed.
  Nobody's bots run on anyone else's plan or key, and there is no fallback
  to the admin's. Team settings (`gond_settings`) keep only onboarding.
  Three of each person's bots answer at once
  (`TURNS_PER_PERSON`), counted apart so one busy team never holds up
  another's; there is no setting for it. A new engine is a session class in the box with the same surface
  (`ensure`, `turnWith`, `steer`, `answerTool`, `close`), its permission questions
  sent through `askPermission`, and an entry in `CLI_ENGINES` in both the
  box and shared.
- **`api` is the engine with no CLI** (`src/native.ts`). `engineRun`
  answers it with `native`, and the responder runs the loop here instead
  of in the box: Anthropic's Messages API or the OpenAI chat API,
  whichever the person's key is, with the same tools a CLI would get plus
  the computer (`src/computer.ts`: Bash, Read, LS, Write, Edit on the box,
  as the bot's owner). Those tools carry the CLI's own tool names on
  purpose, so `requestApproval`, the saved `Bash(git:*)` rules and
  "never ask about its own folder" hold unchanged. It still goes out
  through the LLM proxy with the provider's proxy token, so the key is
  decrypted in one place as before. It is its own MCP client
  (`nativeMcpTools` in `src/mcp-client.ts`): each turn it opens the
  person's HTTP servers through `forwardMcp`, the same path the proxy
  takes (secrets, the sign-in's token, a 424 for a missing sign-in), and
  offers their tools as `mcp__<server>__<tool>`, so approvals and rules
  hold; a command server runs only on a CLI, and the prompt says so. Web search is the provider's own where it has one
  (`serverSearch`): Anthropic's API gets `web_search` (the dynamic-filtering
  version from Opus 4.6 / Sonnet 4.6 on) and MiniMax's Anthropic-compatible
  API the basic `web_search_20250305`, both run on their side and answered
  in the same reply as `server_tool_use` and `web_search_tool_result`
  blocks, logged as steps; a `pause_turn` is sent back as it is to resume,
  and the reply is the text after the last result. Other keys search with
  the browser. A PDF goes inline only to Anthropic's API (`readsPdf`);
  elsewhere the bot opens it from its inbox. Anything above the driver (the prompt, approvals,
  redaction, activity, posting) is shared, so a new API shape is two
  functions in `native.ts` and nothing else.
- **Bots use the screen through two tools, and only by structured
  actions.** `browser` and `computer` (`src/computer-tool.ts`) are the
  same on every engine: `{ actions: [...] }`, up to `MAX_SCREEN_STEPS`
  (20) JSON steps run in order (`SCREEN_STEP_TYPES` in shared: screenshot,
  click `{x, y, button?, count?}`, move, drag `{x, y, to_x, to_y}`, type,
  `type_login {name, submit?}`, key, scroll `{direction, amount?, x?, y?}`,
  wait `{ms}`, copy, paste `{text?}`, clipboard, and in the browser only
  navigate, back, forward, reload, tab, new_tab, close_tab, fill, select,
  check, read, wait_for, upload and dialog), answered with one fresh
  screenshot and a line saying what ran and which step failed
  (`screenSummary`). The browser's answer also carries the page's controls
  and headings on screen, one line each with a ref (`e12 button "Add to
  cart" @640,410`, `compactSnapshot` in the box's `snapshot.mjs` from
  Playwright's AI snapshot), what a read or copy returned, an open dialog
  and any download (saved to `~/Downloads`); a step names an element by
  `ref` instead of `x, y` and Playwright finds it exactly. `view: "text"`
  skips the picture. A checkbox, radio or switch a site draws itself (the
  real input hidden at 0 by 0, so Playwright gives it no ref) is listed
  by the row around it, with its own name and state, so `click` and
  `check` land on what a person would click; a label that finds such an
  input acts on its `<label>`. A control whose box is on screen but
  can't be hit there (scrolled out of a panel, like a long item dialog)
  is counted, not listed (`clippedOf` in the host), since a click at its
  box lands on whatever the panel shows instead. The prompt says refs
  and `check` over x and y, because a page that shifts after one click
  sends the next coordinate somewhere else. Refs hold until the next
  answer. On a page the batch hasn't seen yet a step names an element by `label` (its text or name,
  `role` and `exact` optional) and the host waits up to 8 s for it,
  trying exact, then starts-with, then contains, so `"Total"` is never
  `"Subtotal"`; that lets one batch go from a store's address to its
  total. Every answer is a model round, so the prompt asks for as much per
  batch as it can and for search pages opened by address. A model works
  from the list, several steps per batch, which is what makes it quick.
  The model never writes code for
  the screen: the box's drivers run the steps. `browser` is a persistent
  Chrome on the person's desktop (Playwright in the box, see below), kept
  open between batches and replies with its tabs and sign-ins, and is
  for every website; `computer` is the whole desktop (xdotool), for
  everything else. `screenSteps` checks a batch, turns a desktop's
  coordinates from the last screenshot's pixels into the screen's
  (`scaleOf`; a first pointed batch takes a screenshot to learn it; the
  browser's screenshot is its viewport, so its pixels are already real),
  and turns a `type_login` into the held value the model never sees. On
  Anthropic's own API `computer` is declared by its type
  (`native.anthropic`, `computer_20250124`, 1024×640, with the
  `computer-use` beta header) and its single `{ action, coordinate, … }`
  becomes a batch of one (`fromNativeAction` in shared); everywhere else
  both are JSON schemas. A screenshot comes back as tool parts
  (`ToolPart` in `driver.ts`: text then an image), which the box relays
  to a CLI as content blocks, `native.ts` sends to Anthropic inside the
  `tool_result` and to a chat API as one `user` message of `image_url`s
  after the step's `tool` messages (`stepMessages`); Grok takes no
  pictures, so it gets the PNG saved in the bot's home and its path. A
  batch with any step but a screenshot or a wait goes through
  `requestApproval` once per reply for both tools together: on Always ask
  that is one card per reply, Always allow on it saves the rule
  `computer`, Auto lets it through (it is not on `mustAsk`'s list, by
  decision). A denial holds for the rest of the reply, 300 steps end it.
  Scripting the screen is refused: `scriptsTheScreen` in
  `src/approvals.ts` turns away a Bash command or a written file that
  uses xdotool, pyautogui, pynput or a debugging port on Chrome, before
  any approval (the permission tool and the `api` engine's own tools),
  and Claude Code sessions get `--disallowedTools Bash(xdotool:*)` and
  friends at every level (`SCREEN_SCRIPTING_DENIED`). What the broker
  never sees (a CLI on Always allow, a script it can't recognise) only the
  prompt forbids. `src/desktop.ts` keeps who is
  driving per person (`markDriving` on the first input, `releaseComputer`
  in `botTurn`'s `finally`, Stop included), frees the box's lock when the
  last driver leaves, and emits the `desktop` live event (`desktopState`:
  the box's status plus the drivers). The lock on the box has three
  states, free, bots and person: the person takes it from the panel
  (`POST /api/box/desktop/control`, never `bots`), and while they hold it
  the box answers an input batch, browser or desktop, with 409
  `person_has_control`. The tool then waits for the screen back
  (`untilHandedBack`, up to `HANDBACK_WAIT_MS`, ended by Stop) and
  answers with a fresh screenshot and `HANDED_BACK_TEXT`: carry on from
  what the person left. The person taking the screen records who was
  driving (`tookControl`); giving it back (`tellHandedBack` in the
  responder) wakes the batches waiting and tells every other bot it was
  taken from, steering its running turn or with a hidden prompt, and a
  stopped conversation is forgotten (`forgetHandBack`). While the bots
  hold it, nothing the person does reaches the screen: the box turns the
  VNC viewers' input off in Xtigervnc itself (see Box), and the full view
  is view-only from the first approved batch (`drivers`), before the
  box's lock arrives. A lock the box holds for bots the API no longer
  runs (it restarted mid-turn) is freed by `desktopState`, and the box
  lets the bots' hold lapse after ten minutes without a batch, so a free
  screen is always the person's. The lock binds the tools the prompt
  names and nothing more: a bot's Bash runs as the same uid and could set
  DISPLAY itself, so it is a courtesy between the person and a bot that
  follows its house rules, not a security boundary.
- **Files the person sends reach the bot as files** (`src/inbox.ts`).
  Before a turn, `deliverAttachments` writes each one into the bot's
  folder on the box as `inbox/<id>-<name>` (`PUT /files/raw`, as the
  person), shows the model a copy of a picture with its long edge at
  1568 px (`GET /files/preview`, made by ImageMagick on the box) and a PDF
  up to 8 MB inline, and `attachmentNote` tells the bot in the prompt
  what came, where it is and what it can already see, so it never
  searches the computer for a file. Text files are also inlined as
  before. The original is never sent to a model at full size.
- **AI provider keys are secrets too, and each person's own.**
  `src/data/providers.ts` keeps one endpoint per API per person
  (`PROVIDER_KINDS`: Anthropic-compatible, OpenAI-compatible, xAI), the key
  encrypted and write-only. An engine names the APIs it can run on
  (`ENGINE_LABELS[engine].providers`, best first) and `engineRun` takes the
  first the person has a key for. A key is only ever typed in one place,
  Settings → AI → API keys, where the API is picked first and its card
  opens. The box gets the LLM proxy (`/api/llm/:kind/*` in
  `src/routes/llm.ts`) and the provider's proxy token; the token names whose row it is
  (`providerByToken`), only the proxy decrypts the key, and
  `allSecretValues()` includes every key for redaction.
- **Secrets never leave the API.** `src/data/secrets.ts` stores them
  encrypted, per person, and only `readSecret`/`injectSecrets` decrypt, at
  the moment of use: the MCP proxy in `src/routes/mcp.ts`, which fills a
  server's headers only from its owner's secrets. No route returns a value, no
  value goes to the box but a sign-in a `type_login` action types, and every bot reply and activity line passes
  through `createRedactor(allSecretValues())`. A bot asks with
  `request_secret` (a `secret` message kind, answered on
  `/api/secret-requests/:id`); it only ever hears "stored". A request's
  `target` says where the value lands: the secret store, the person's
  Composio key when the bot asked with `set_composio_key`, or a website's
  sign-in. Settings → Secrets (`secrets-card.tsx`) lists the names, saved
  sign-ins by site and keys apart, and forgets one (`GET /api/secrets`,
  `DELETE /api/secrets/:name`); a value still only goes in through a
  bot's card, a newer one replaces it, and deleting the person takes the
  lot. Never tell a person to paste a key into Settings that a bot could
  ask for.
- **A website's sign-in is a card, typed by the API.** When a page the
  bot is driving asks for an email, username, phone, password or code, it
  calls `request_login` with those fields: one `login` card
  (`login-card.tsx`), named `<SITE>_<KIND>` (`src/logins.ts`). What the
  person types is held in memory for that conversation for 30 minutes and
  typed by a `type_login` action (in a `browser` or `computer` batch) into
  the focused field as keystrokes; the bot only hears the names. "Remember for next time" also stores it as a
  secret with a `site`, encrypted like every other; a code is never
  stored, and nothing on the card is ever written in plain text. A later
  `request_login` for saved details asks first (`mustAsk`, Always allow
  saves `request_login`), then holds them the same way. `readLogin` only
  reads secrets with a site, so an API key can never be typed into a
  page.
- **Skills are each person's own library of folders**
  (`src/data/skills.ts`): a row is SKILL.md (name, description,
  instructions, any other frontmatter in `meta`) and `gond_skill_files`
  holds the scripts, references and assets next to it. `src/skills.ts`
  mirrors a person's library to `~/.skills/<slug>/` in their home only
  (on change, at start, after a reset, and before their first turn in a
  process). The system prompt carries the index; a `/slug` in the message
  puts that skill in full, with where its files are. A routine with a
  `skillId` posts `Use /slug.` ahead of its prompt, from its owner's
  library only. A bot makes one with `save_skill` (best from a folder it
  built in its home, or a .skill file) and changes one with
  `update_skill`, when a person asks it to make something a skill. A
  .skill is the folder zipped (`src/skill-bundle.ts`, pure and tested):
  Settings → Skills imports one and downloads any skill as one.
- **MCP servers go through `src/mcp.ts`**: HTTP ones become a proxy URL
  with a per-server token; stdio ones are passed as given. Each server is
  one person's (`user_id`; names are unique per person), and its routes
  answer 404 to anyone else. Every enabled server of a person's is
  attached to every one of their bots' sessions (`mcpServersFor`); nothing
  is toggled per bot, and `add_mcp_server` adds it for all of them. The
  box writes them into the session's MCP config next to `gond`; a changed config
  relaunches the session (the args key covers it). A server waiting for
  its sign-in (`authStatus` `needed`) stays off the session until it is
  signed in, and the proxy never answers the session with a 401 (403 for a
  wrong token, 424 for a sign-in it needs): Claude Code reads a 401 as an
  OAuth it should run itself and goes digging in `~/.claude`. OAuth lives in
  `src/mcp-oauth.ts`: probe on add, discovery per the MCP authorization
  spec, dynamic client registration, PKCE, tokens encrypted in the row,
  refresh in the proxy, one at a time per server (refresh tokens are
  often single-use, and a refusal while the token still works signs
  nobody out). The web only ever sees `authStatus`. A server set
  to `oauthRedirect: "localhost"` (providers that only allow local tools)
  returns to `MCP_LOOPBACK_CALLBACK`: the desktop app listens there and
  loads the server's callback in its window; a browser pastes the address
  into `/api/mcp-servers/oauth/complete`. The desktop app opens every
  provider in the system browser, which needn't be signed in to Gond, so
  a sign-in it started (`app: "desktop"` on the login) lands on the
  callback there and is handed back through that same loopback with
  `via=app` (`mcpLoginHandBack`, ahead of the session check), and the
  app's window finishes it with its own session. Android loads the
  provider in its WebView, so it comes back with the session as the web
  does.
- **A bot shows the person the screen with `send_screenshot`**
  (`computer-tool.ts`): a fresh screenshot of the browser's page or the
  whole desktop, posted in the conversation as a picture with the bot's
  caption, nothing written to the computer. It is its own tool, named
  for the job, because a bot asked for a screenshot looks for one; the
  same thing rides on a batch as `share`, which a failed step cancels.
  The prompt keeps it for when the person asks to see the screen and for
  the screen an answer is about (a cart before anything is bought, a
  confirmation), never the steps on the way, and `send_file`'s refusal of
  a path outside the home points to it.
- **Bots hand over files with `send_file`**: it reads the bytes from the box
  (`/files/raw`, links resolved and kept inside the home), refuses a file
  holding a stored secret, and posts it as an attachment. Attachments that
  could run script (HTML, SVG, anything unknown) are served as downloads
  with a sandbox CSP, never inline on the app's origin.
- **Bots edit profiles through tools, not SQL.** `set_profile` (a bot's
  own) and `update_bot` (a teammate's) go through `profilePatch()` in
  `src/tools.ts`, then `syncSoul` rewrites SOUL.md on the box. Add a field
  there, not in the route. **No tool is the primary bot's alone**: `teamTools`
  (`create_bot`, `update_bot`, `delegate_bot`, `ask_bot`) goes to every bot,
  and `primary` only shapes the prompt and decides who answers in a room
  when nobody is named and who hears of a broken run (`getPrimary`). It is
  never a tool's to set: `POST /api/bots/:id/primary` transfers it
  (Transfer primary bot in the primary bot's ⋯ menu, `transfer-primary.tsx`), and
  `ensurePrimary` keeps exactly one visible primary per person when a bot
  is made, hidden or deleted. Who does what is said in a bot's SOUL and the house
  rules, never gated in the responder. `connect_app` looks in Composio first and only
  then points at `add_mcp_server`; keep that order. `add_mcp_server` takes
  an HTTP URL only (commands stay in Settings), asks the person's approval,
  and posts a `signin` card when the server wants OAuth; the card's sign-in
  comes back to that conversation and a hidden prompt lets the bot carry on.
  A connected app's sign-in is a `signin` card too, with `composio:<toolkit>`
  as its id (`composioCard` in `packages/shared`): the card asks for a fresh
  Connect Link when the person taps it, so nothing expires in the message,
  and the connection comes back to the conversation. A bot never pastes a
  sign-in link into a reply.
- **A bot reacts with `react`**, to the person's message it is
  answering and nothing else. The prompt keeps it for thanks, agreement
  and goodbyes, and a reaction can be the whole answer: a turn that
  reacted and answers `NOTHING_NEW` or nothing posts nothing and pushes
  nothing (`reactedOnly` in the responder), the way a routine's quiet run
  does. The transcript carries every message's reactions, so a bot sees
  the person's.
- A hidden `prompt` message (author `system`) is how the API asks a bot to
  do something on its own, like greeting a new person; the dispatcher
  answers it like a message and the web never renders it.
- **Notifications** are Web Push in a browser (`src/push.ts`, `web-push`,
  VAPID keys in the data directory; `public/sw.js` shows one and a click
  focuses the window already on the conversation, or opens one). Send from
  the API only when a bot finishes for the person or needs them, and only
  when `bot.notify` is on. `sendPush` also emits the same notice as a
  `notify` live event (`userId`, `title`, `body`, `url`, `tag`; the events
  route lets only the owner hear it): on Android and the desktop that event
  becomes a native notification through the shell bridge in
  `shell-notifications.tsx`. Nothing is pushed about a conversation the
  person has in front of them: the page reports what it shows
  (`viewing-report.tsx` → `/api/push/viewing`, `src/presence.ts`), since the
  service worker can't tell on an iPhone. `POST /api/push/test` sends one
  past that check; Send a test notification in Settings → Account calls it.
- **Time is the person's browser's.** `gond_user_prefs` keeps each person's
  zone, reported by `viewing-report.tsx` with every presence ping;
  `userTimezone(userId)` in `src/data/prefs.ts` is the only reader;
  routines, the prompt and templates use the bot owner's; a change rewrites
  that person's routines. There is no team time zone. Dates shown to people
  are formatted by the browser (`toLocaleString`, no `timeZone`); only ISO
  strings cross the wire.
- **Roles.** `src/access.ts` is how a route knows who is asking:
  `requireAdmin` guards the admin's areas (mounted in `app.ts`: the
  computer's Update and Reset, onboarding, users, oidc, and every write to
  settings), `ownBot` and
  `ownThread` answer null for anything that isn't the signed-in person's,
  and a route answers 404 then, never 403. `listBots`, `listThreads`,
  `getPrimary`, `createBot`, `createRoom`, `searchMessages` and the push
  functions take the user; the responder and the bot tools use the
  conversation's owner. Connected apps, the Composio key, MCP servers,
  secrets, the AI and its providers, and the computer (terminals, the
  desktop, a bot's files, the sign-in status) are everyone's own and
  answer only for the signed-in person; nothing is shared between people.
  Skills are too. Reads everyone needs (a reduced settings view) stay
  open and are narrowed inside their routes. A live event about a
  conversation or a person reaches only its owner (`routes/events.ts`);
  `ai` and `skills` are such topics.
- **Every person has an account on the box.** `boxConfig(userId)` in
  `src/box.ts` makes the client for one person, and every request about a
  home carries them in `X-Gond-User`. The box answers `no_account` for
  someone it hasn't met, the client makes the account (`POST /accounts`:
  the admin is `agent`, anyone else a new Linux user with a home of their
  own) and tries again, so nothing is set up ahead of time. The responder
  uses the conversation's owner, the bot tools the bot's owner, the box
  routes the signed-in person; `boxHome(userId)` is the home's path once
  it is known (for `send_file`'s absolute paths). Deleting a person
  (`routes/users.ts`) removes their account, home and all
  (`removeBoxAccount`). Each person's skills mirror is written by
  `syncSkills(userId)` through `/skills`, at start and on every change.
- **The OIDC provider** is `data/oidc.ts` (secret encrypted, write-only)
  and Better Auth's `genericOAuth` plugin in `auth.ts`, built from it with
  discovery; a change calls `invalidateAuth()` so the next request gets a
  new instance. The `admin` plugin holds the role; the first account gets
  `admin` (`ensureAdmin`), everyone from the provider `user`, and rows from
  before there were users are adopted by the admin at start
  (`adoptOrphans`). The sign-in page reads `/api/auth-config`, the only
  public view of it.
- Validate request bodies by hand at the route (shape, ranges, allowed
  values) and answer with `{ error }` and a fitting status. A partial
  update parses with the `*PatchSchema` from `packages/shared`, never
  `inputSchema.partial()`: with zod 4 that fills every missing field with
  its default, so a pin would have wiped a bot's job and its approval level.
- Tests: `bun test` in `apps/api/test`. Data tests use a temporary data
  directory; logic tests stay pure.

## Box

- The box is not a throwaway. `/home/agent` (the admin's home) is a
  volume; their bots' homes, package caches and Claude sign-in are volumes
  inside it. `/home` is a volume for everyone else's homes, and `/state`
  keeps the token and the register of accounts. Never put state anywhere
  else.
- **One Linux account per person** (`accounts.mjs`). The admin is the
  `agent` user the box always had; everyone else gets `gond-<name>` (uid
  from 2001) and `/home/<name>`, mode 0700, made with `useradd` on first
  use and made again at start from `/state/accounts.json`, since
  `/etc/passwd` doesn't survive a container recreate but the homes do.
  Every route about a home takes the person from `X-Gond-User`
  (`accountFor`) and runs as them: `agentEnv(account)`, `asUser(account)`,
  `botDir(account, id)`, a terminal in their home, a desktop on their own
  display and VNC port (`desktopSlot`), and sessions, terminals and
  desktop connections answer 404 for anyone else's. Separation is Unix
  permissions inside one container: real, but not a hard security
  boundary. Without root (a dev checkout) every account shares this
  process's user and only the homes differ.
- Everything a bot runs happens as its owner's user with
  `agentEnv(account)`. Credentials are stripped from the environment
  before a session starts. The CLIs' sign-ins (`.claude`, `.codex`,
  `.grok`, each person's own) are never readable through the files API
  and survive Reset.
- **A model list comes from the CLI** (`models.mjs`,
  `/engines/:engine/models`). Codex answers `model/list` on its
  app-server, Grok prints `grok models`, and Claude Code has neither, so
  it offers its aliases (`fable`, `opus`, `sonnet`, `haiku`, best first,
  `opus` the default), which follow the newest model of each name and
  never go stale. Only their labels carry a version number, so those are
  edited by hand when a new one lands. A CLI that can't
  answer returns nothing and the app says so, rather than showing names
  that may not run.
- **A sign-in is the CLI's own login, driven here** (`sign-in.mjs`,
  `/engines/:engine/sign-in`). One job per person and engine: the login
  command in a pseudo terminal as them (the same `pty.spawn` recipe as a
  terminal, wide enough that no link wraps, `CI` dropped so the CLIs print
  the link), the link and the code parsed out of what it prints, the code
  from the sign-in page written back for Claude Code, and the outcome
  confirmed by asking the CLI itself. Only the link, the code and a short
  error ever leave; the transcript never does. Parsing and the job are
  pure functions with tests (`test/sign-in.test.mjs`) so nothing there
  needs a container to check.
- **`POST /computer` runs one batch of a bot's steps on its owner's
  screen** (`{ bot, target: "desktop" | "browser", steps, saveTo? }`,
  coordinates in real screen or page pixels, a sign-in already filled in
  as `{ type: "type", text, secret: true }`). `parseSteps` in
  `computer.mjs` checks every step (pure, tested; navigate opens http and
  https only), the batch runs in order and stops at the first step that
  fails, and the answer is one screenshot (`image`, base64 PNG, with its
  `width` and `height` and the real `screen` size; `saveTo` inside the
  home writes the PNG there instead) with `done` and `error: { index,
  message }`, plus `url`, `title`, `tabs`, `elements`, `outputs`, `dialog`
  and `downloads` for the browser, whose screenshot is a JPEG (`mime`)
  unless it is saved. After a batch with input the browser waits for the
  DOM to go quiet (150 ms without a change, at most 1.5 s), not a fixed
  pause; a click that opens a dialog ends there, and nothing but `dialog`
  runs until it is answered. Copy and paste go through `xclip` on the
  person's display, so the desktop and the browser share one clipboard. The
  desktop's steps are xdotool argv (`xdotoolArgv`; text goes on stdin,
  never in an argument). The browser is one host per person
  (`browser-host.mjs`, started as them by `browser.mjs`): it holds a
  Playwright persistent context, Chrome headed on their display with its
  profile in `~/.config/gond-browser` (which the files API never opens),
  maximized (its page the window's size; 1280×800 only headless), and
  follows a tab a page opens. It talks JSON
  lines on stdio, so no port is open to anyone else; it stays up between
  batches and closes after 30 idle minutes, when the desktop stops, or
  on a reset, and the next batch starts a new one on the same profile. A
  host that stops answering is killed. `GET /desktop` carries `control`:
  `free`, `bots` or `person`; `POST /desktop/control`
  `{ holder: "person" | "free", from?: "bots" }` moves it (`from: "bots"`
  only frees what the bots held) and 404s when no desktop runs. A batch
  with input while the person holds control is 409
  `{ code: "person_has_control" }`. Every change of holder goes through
  `changeControl`: while it is `bots`, `vncconfig` sets Xtigervnc's
  `AcceptPointerEvents`, `AcceptKeyEvents` and `AcceptCutText` off
  (`desktop.sh` passes `-AllowOverride` for them, or the server refuses),
  so a viewer's mouse, keys and clipboard are dropped by the server
  whatever the page sends, and a viewer can never resize the screen; xdotool
  goes through XTEST and is untouched. The hold lapses after
  `BOTS_HOLD_MS` without a batch. The tool-result route takes `content`
  as a string or `ToolPart[]` (text and image parts), so a screenshot
  reaches the CLI as an image block. `PUT /files/raw?path=` writes up to
  30 MB of bytes into the home as the person, and `GET
  /files/preview?path=&type=` answers a JPEG of a picture there, long
  edge 1568 px, made by ImageMagick as the person with the coder named
  from the type it was sent as (`preview.mjs`).
- Anything that uses the computer answers 503 while `update.sh` runs;
  reads of a bot's files still work. `POST /reset` is the box as it was
  built (`accounts.reset()`): every person's account goes, Linux user and
  home with it, the admin's home is emptied and every skills mirror cleared.
  The one thing kept is each person's CLI sign-ins, set aside in
  `/state/logins/<user id>` and put back by `ensure()` when that person's
  next account is made, so a reset never signs anybody out of their plan.
  Each person can also reset just their own account (Settings → Computer,
  `home-reset-card.tsx` → `POST /api/box/home/reset`, which stops their
  bots first → the box's `POST /home/reset`): their desktop, terminals and
  sessions close, every process of theirs is killed, and `refreshHome`
  empties the home but for what `homeKeeps` keeps, every memory (each
  bot's `MEMORY.md`, `memory/` and `SOUL.md`, and the team's), the CLIs'
  sign-ins and the browser profile. Everything else goes, the bots' work
  files included, and the home is made again; sessions resume.
  Everything else is made again as it is used: an account on the next
  request about a home, a bot's home and SOUL.md on its next turn, the
  skills from the API right after the reset. `DELETE /accounts/:id` closes
  a person's sessions and removes their user and home.
- In every home, `~/.team` holds the person's team space, `.team/<user
  id>` (its `MEMORY.md` loads into every turn of that person's bots, and
  nobody else's; the admin's bots still read the old `.team/MEMORY.md`
  until they write their own); `~/.skills` is a link to the person's own
  library mirror (`/srv/gond/skills/<linux name>`, root's, readable only
  by their group, written by the API through `/skills` as them);
  `~/.bots/<id>` is each bot's home. All three are hidden so
  the home looks like a person's. `bots`, `team` and `skills` from an
  older box are moved over at start.
- New endpoints: add to `route()` in `server.mjs`, keep the bearer-token
  check, take the account from the request, keep paths inside that
  person's home (`insideHome`, `boxCwd` with `account.home` and
  `forbiddenIn(account)`).
- **The desktop is Xfce with a Plank dock** (`desktop.sh`): xfwm4,
  xfdesktop and xfsettingsd with no session manager or panel, the window
  manager being the session. The dock is always shown and reserves its
  strip, so a maximized window (the bots' Chrome always is) stops above
  it instead of hiding it; its settings are written with `dconf` (the
  image has no `gsettings`) wherever the person hasn't set their own, and
  a Plank that crashes is started again while the display lives, and
  again if the screen's size ever changes, since it stays where the old
  bottom edge was. The look (Adwaita dark, the wallpaper, no
  desktop icons, compositing without shadows) is system defaults in
  `xfce/`, copied to `/etc/xdg`, so whatever a person changes stays in
  their own `~/.config`; the dock's Chrome, Files and Terminal are written
  once into theirs. Every Chrome starts through `google-chrome.sh`, which
  passes the flags the box needs and opens the bots' profile for a window
  the person opens, so they and their bots share sign-ins. The bots'
  Chrome is maximized with its page as big as the window and no
  automation bar; if the person's own window holds the profile when a bot
  needs the browser, it is closed first (`freeProfile`), since two can't
  hold it at once. The profile outlives the container, so its lock can
  name a hostname from before an update; Chrome won't open a profile
  locked by another host, and both the wrapper and `clearForeignLock`
  remove such a lock first.
- Node and the desktop come from the image; Bun is patched in
  place by `update.sh`. Keep the script step-per-tool, each
  step reporting and never stopping the next.

## Before a commit

```sh
bun run lint
bun run typecheck
bun run test
bun run --filter @gond/web build
```

Comments only where they say what the code can't: a non-obvious why, a
security invariant, a workaround for someone else's bug, a spec reference.
A name, a type or a test says the rest, and CLAUDE.md holds the prose.

All four green, then screenshots of what changed in light and dark when it
is UI (Playwright against the dev servers works; Chromium is at
`/opt/pw-browsers/chromium` in the remote environment). Commit messages:
a short subject in sentence case, then a paragraph or a list saying what
changed and why, written for the person reading the log.

## Things that stay true

- One local account per install, the admin; the setup token gates its
  registration. Everyone else comes through the OIDC provider the admin
  set up and is a user.
- All bots, everyone's, share one computer, and every person has their
  own Linux account on it: their own home, their bots' files, their CLI
  sign-ins, their terminals and their desktop. Separate bots are not a
  security boundary there; separate people are Unix permissions inside
  one container, which keeps their work apart but is not a hard boundary
  either. The container and the unprivileged users are. Rows in the
  database are: a bot, a conversation, a push subscription, a connected
  app, a Composio key, an MCP server, a secret, a skill, an AI setting and
  an API provider belong to a user, and a route never returns another person's.
- Everyone's bots run on their own plan or their own API key. Nothing
  about the AI is shared between people, and nobody falls back to the
  admin's.
- The web app never talks to the box; the API does, with a bearer token,
  over the Compose network.
- The Docker socket on the API exists only for Settings → Team →
  Update and Reset. Nothing else may use it.
- A stored secret is never returned by a route, never written in plain
  text, and never appears in a message: only injected by the API at the
  point of use. The one value that reaches the box is a sign-in detail
  a `type_login` action types into a page, as keystrokes (xdotool's stdin
  or the browser host's), never in an argument or a log.
- `.env` never holds anything checked in. `.env.example` is only what a
  person sets: `APP_URL` and `GOND_SECRET_KEY`. Anything with a safe
  default (a random secret, a timeout, a limit) is made or chosen here and
  listed in the README's Advanced settings, never added to the example.
  The API finds the Docker socket's group itself as it starts
  (`apps/api/docker-entrypoint.sh`), so no setting asks for it. Names are
  `GOND_*`; a `KRU_*` name is legacy, read for one release with a warning.
