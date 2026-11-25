@AGENTS.md

# Web: how we build it

Read with the root `CLAUDE.md`, whose rules (Bun only, copy, tests, before a
commit, things that stay true) hold here too.

## Components and look

- **Use shadcn, don't hand-roll.** The skill is in `.agents/skills/shadcn`
  and its rules apply: forms are `FieldGroup`/`Field`, option sets are
  `ToggleGroup`, callouts are `Alert`, empty states are `Empty`, confirms
  are `AlertDialog` (never `window.confirm`), a date is `DatePicker`
  (`ui/date-picker.tsx`, shadcn's `Calendar` on the control tokens, never a
  native date input), a plain yes or no is
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
  - There is no brand colour: the neutrals are oah's, "cool paper" in
    the light (page #f6f7f9, white cards, ink #16181d) and true black in
    the dark (page and sidebar #000000, cards #0e0e0e);
    the bots are the only colour on a page, besides the person's own
    accent. oah's dark fills and edges are white at 4 to 12%; here each
    is a solid composite over the surface it sits on, since accent
    shades, hovers and cut-out rings mix with the tokens.
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
    `--tint-ink` on `--tint-wash` clear 4.6:1 in both themes, and
    `--tint-edge` 3:1 on the page. It paints
    their bubble, the main button on a card (`variant="tint"`), Send, and
    a card a bot posts on its own (`bg-tint-wash`). The theme init script
    sets it from `localStorage` before first paint, the store from
    `me.accent`.
  - Markers are tokens too: the primary bot's crown (`--gold`,
    `--gold-coin`, `bg-gold-coin`, its ring `--surface`, the colour of
    whatever it sits on; an svg in it is sized inline, since `Button`
    resizes svgs without a size class), status tones (`--tone-ok`,
    `-warn`, `-bad`, `-info`), window close (`--window-close`,
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
- **Wide is islands.** On a wide screen the panes float on the page as
  `island` cards (`@utility island` in `globals.css`: `bg-card`, 22 px
  corners, `shadow-subtle-2`): the chat list (`Sidebar
  variant="floating"`), a conversation's details (`RightPanel`) and
  Settings' sections. The conversation sits on the page between them,
  its messages and composer in a centred 46rem column, the composer
  lifted with `shadow-subtle-3` (the one pill with a shadow). Inside an
  island, hovers and the active row are `bg-muted` and a bot's job is
  quiet text, not a badge. A new pane at that width is an island, never
  a bordered column. Phones keep their own look.
- **Layers are fixed**: dialogs and sheets `z-50`, the computer's window
  `z-[70]`, a confirm `z-[90]`, the desktop app's window buttons
  `z-[95]`, everything that floats from a control (lists, menus,
  popovers, tooltips) and toasts `z-[100]`. A new layer
  takes a place in that order.
- **Two themes, both checked every time.** Settings → Appearance is a
  `Select` of System, Light and Dark (`THEMES` in `lib/theme/theme.ts`,
  kept on the device, `followsDevice`); the theme init script sets
  `<html class="dark">` before first paint. There is no third theme: a
  device that saved the old Gond theme opens Dark and is rewritten to it
  (`themeOf`, and the init script). Edges, rings and fills must read in
  both. `test/palette.test.ts` reads `globals.css` and fails when a
  contrast drops (text 4.5:1, the focus ring 3:1, destructive on its
  wash, every accent's shades in both themes, a bubble's rings
  drawn solid) or when a shell's copy of the page colours drifts.
- **Mascots are 3D, drawn by `GondBot`** (`components/hq/gond-bot.tsx`)
  on the geometry in `gond-bot-shapes.ts` (`COG`, `BODIES`, `EYES`), which
  the icons share. Don't redraw the cog. A shaded body, a dark visor
  (`LAYOUT` per body), glowing eyes and a mouth, every shade mixed from
  the bot's one colour (`shadesOf`), so `BOT_COLORS` and what's stored stay
  a single hex. Below 40 px the glow, sheen and catch-lights go (`fine`).
  The cog keeps a still hub and only its teeth turn; only the cog spins.
  Its keyframes live once in `globals.css`, never a `<style>` per face,
  and blink and glance run only while a face is on screen in a shown tab.
  `shape` (`BOT_SHAPES`) picks a body under the same eyes and animations;
  a new shape is a path in `BODIES`, a `LAYOUT` entry and a name in
  `BOT_SHAPES`. Retiring one removes all three and adds a migration
  putting its bots on the cog; `toBot` and `botTemplateSchema` read a
  shape they don't know as the cog. `mood` is set by Gond, never
  stored or picked: `thinking` while it works (work lines, Chats rows
  and pinned faces), `glad` as an
  answered card folds (`GLAD_MS`). The box homepage and the iPhone's
  Connect faces draw the same 3D cog. A bot may wear a picture instead
  (`usePicturePicker`, a 512 px PNG or a GIF as is, `gond_bot_avatars`,
  `Bot.avatar`); `BotAvatar` draws either. A face sent to an app as a PNG
  waits for its pictures to load first (`picturesLoaded`).

## Layout

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
- **In the Windows and Linux app the page is the title bar**
  (`<html data-shell="desktop">`, the `desktop:` variant). On a wide
  window the top row holds the chat list's search and New, the
  conversation's pills and the window's buttons (`WindowControls`, one
  pill in the corner), and the islands start below it; anything else in
  that corner leaves `--window-controls-space`. Under wide the buttons sit
  in a strip above the page (`--shell-inset-top`), since the phone
  layout's headers have no room for them. Rows that hold the window carry
  `data-window-drag`.
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

## Data and rendering

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
  `apiShared`. Background polls skip a hidden page (`pollWhileShown` in
  `lib/poll.ts`). The store keeps every unchanged item the same object
  (`keep` in `lib/keep.ts`), so a reload redraws only what changed. It
  merges a burst of events into one reload. `open` fires only on a
  reconnect (`live-events.ts`), so anything that listens for it also loads
  on mount.
- **A conversation loads a page at a time** (`useMessageHistory` in
  `hooks/use-message-history.ts`, also the exchange dialog): 60 first,
  catch-up `from` the newest line shown (its millisecond included, lines
  told apart by id), "Load earlier" and jumps before it, and one
  `GET /api/approvals?ids=` per page for its cards. A card whose approval
  isn't known yet is folded and can't be answered. The composer
  (`conversation-composer.tsx`) and the live tail (`conversation-live.tsx`)
  sit outside the memoized history, so typing and streaming never touch
  it. Sizes read through `formatBytes` (`lib/bytes.ts`).
- **A bot's message is GitHub Markdown** (`lib/markdown.ts`, mdast with
  GFM and directives; `components/markdown.tsx` walks the tree into
  React), so nothing a bot writes is ever injected as markup. Raw HTML
  shows as text (an inline `<br>` breaks), links get an href only for
  http, https or mailto (`safeHref`), footnotes stay literal, an image is
  a link (files go through `send_file`), headings are styled text with
  `role="heading"`, never h1–h6. Chat directives
  (`components/chat-blocks.tsx`): `:badge[…]{tone=}`, `::meter{…}` and
  `::choices[A | B]` (two to six options, filled pills while open, the
  picked one pressed; a tap sends the option as a reply to the message
  that asked, quoted as its question (`quotedWords`), so it closes only
  that row (`choiceAnswers` in `lib/choices.ts`) and never sets a waiting
  card aside (`keepCards`); anything else the person says closes every row
  above it; only the conversation
  provides `ChoicesContext`, so it is inert elsewhere). `{multi}` toggles
  several and Send sends them as one `joinNames` line (`answerOf`, read
  back by `pickedIn`); `{other}` adds Something else, a field whose words
  go instead, or last; `:::questions` holds two to six of them on one card
  that steps through (`questionsOf`, `Questions`) and sends one reply, a
  line per question (`answerLine`, read back by `questionAnswers`), which
  closes the card, never its rows one by one. `prepareMarkdown`
  moves a trailing `::choices` onto its own line; `badgeOf` / `meterOf` /
  `choiceRowOf` validate; anything else renders as raw source. Copy leaves
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
- **A paused card can still be answered** (`pauseOnExpiry`, `isPaused`:
  `expired` with outcome `paused`, no migration): an approval or email
  card from a turn answering the person keeps that
  turn's message and steps in its `note` (`CardWork`, never sent to the
  page) and at 15 minutes, or at a restart, pauses instead: no line, the
  turn ends, the card stays open with a "Paused" badge and stays on the
  phones. A late answer never runs the action: `decideLate` posts a
  hidden prompt (`lateAnswerText`: what ran, the answer, check first,
  never repeat) and only the same call (`actionKey`) goes through once in
  that turn (`lateYes`, spent by `takeLateYes`); anything else asks
  again. Sign-ins, secrets and money (`answerableLate`) keep the strict
  expiry. Only a bot's newest card there waits;
  the person's next line there, Stop, a newer card or
  `LATE_ANSWER_HOURS` (24) retires it. It never shows in Worth a look.
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

## Settings

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

## Where the features live

One line each: where to start, and what must not change.

- **Rooms** (`room-dialog.tsx` for New and Edit, `PATCH /api/rooms/:id`,
  `RoomAvatar`): two to six bots (`ROOM_MIN_BOTS`, `ROOM_MAX_BOTS`),
  enforced by the routes, the dialog and `create_room`; an older room can
  only move toward the limits. The name is optional (`roomNameFor`).
  Changes post one line (`roomChange`). A room pins like a bot.
- **Who a room line goes to** is `roomTargets` in shared, used by both
  `targetsFor` and the composer so they never disagree. In order: whom it
  names (an @handle, a bot's name as a word, or
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
- **The composer**: one pill, attach (a paperclip) at its start. A message past one
  line moves its buttons (attach to the left, Later and Send to
  the right) to a row beneath (`stacked`), held until it's empty so
  the wider text can't flip it back. `lib/composer-layout.ts` gates it on
  the draft: empty is always inline, even without a resize notification.
  Send empties the field as it's tapped; a failed send puts its text back
  ahead of anything typed since (`unsentBack`).
- **Drafts and history** (`lib/drafts.ts`, `lib/sent-history.ts`): a
  draft is per conversation in `localStorage`, shown as "Draft: …", kept
  in memory while typed and written after a pause, on `pagehide`, on hide
  and on leaving the conversation. Up in
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
  the dispatcher); unsending removes its files.
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
- **Bot files** (`bot-files.tsx`, `GET /api/bots/:id/files`,
  `/files/raw`): dotfiles left out; a download is always a sandboxed
  attachment, a picture inline only when its bytes are one
  (`pictureType`, never an SVG), a file holding a stored secret is
  refused, and the text view hides every secret.
- **Usage** (`usage-section.tsx`, `GET /api/usage?range=`): spent is
  dollars only where the provider billed them; Gond keeps no price list.
  Refetches on `usage` and `ai`. Usage metrics (`SharingCard`, the
  admin's, off by default; `InfoTip` explains it on hover or tap) is
  `src/usage-sharing.ts`: while on, about hourly, the whole server's tokens
  since it was turned on (`serverTokens`, one number) go signed to the
  relay; nothing else does.
- **Watches and "worth a look"** (`components/noticed.tsx`,
  `worth-a-look.tsx`): `RunMarker`, "Why you're seeing this", "Less like
  this" (`POST /api/threads/:id/messages/:id/less`). Nothing from the
  conversation on screen is repeated in the sheet.
- **Templates** (`bot-template.tsx`, `SharedTemplate` in the shell).
- **Transfer primary** (`transfer-primary.tsx`).
- **Size** (`appearance-card.tsx`, `SIZES` in `lib/theme/theme.ts`,
  `postcss-rem.mjs`): Default or Large (115%), each device's own, with no
  zoom. Sizes are written in px and built as rem (16px to 1rem; under 2px
  and media conditions stay), and the theme init script (`SIZE_SCRIPT`)
  sets the root font before the first paint. A size set from JavaScript
  goes through `rem()` in `lib/utils.ts`, never raw px, or it won't grow;
  measured values (the composer's height, a swipe) stay px. The insets
  stay px, since the bars don't grow. An iPhone app offers it only with
  "scale" in `features()` (`sizeOffered`), and draws its chrome to match
  (`setScale`, `chromeScale` in `NativeViews.swift`); menus and toasts
  stay the system's.
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
- **Saved approvals** (`saved-rules.tsx` in a bot's Edit dialog, `GET`
  and `DELETE /api/bots/:id/rules`): every Always allow rule in words
  (`ruleLabel`), shown only when the bot has some, removed on Save so the
  next one asks again; forgetting one clears `rule` on the cards that
  saved it (`removeRule`). A card just answered Always offers Undo
  (`UndoAlways`).
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
- **Shopping** (`shopping-card.tsx`, a message's `commerceId`): products
  in a carousel with a detail dialog (variant, store, quantity, Buy now),
  the checkout as an `ActionCard` that asks for the address and then the
  payment (Pay is `tint`) and folds to one line once it ends, and the
  order with its shipments. A card reloads on its conversation's
  `thread` event, never on a poll of its own.
