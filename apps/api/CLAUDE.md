# API: how we build it

Read with the root `CLAUDE.md`, whose rules (Bun only, copy, tests, before a
commit, things that stay true) hold here too.

## Conventions

- Routes live in `src/routes/*.ts`, one file per area, mounted in
  `app.ts`. Everything under `/api` needs the session; unsafe methods
  must be same-origin (enforced in `app.ts`).
- Read a body with `readBody` (`routes/body.ts`), never a cast: every
  field is `unknown` until checked. Validate by hand at the route (shape,
  ranges, allowed values) and answer `{ error }` with a fitting status.
  A box route goes through `withBox` or `withBot` (`routes/box.ts`).
  A partial update parses
  with the `*PatchSchema` from shared, never `inputSchema.partial()`:
  zod 4 fills every missing field with its default, so a pin would wipe a
  bot's job and approval level.
- Data access lives in `src/data/*.ts`. A write the UI should see emits
  through `src/events.ts` (`botsChanged`, `threadChanged`,
  `settingsChanged`, or `emit({ topic })`). `botsChanged` takes the owner
  when known (`threadChanged` always does), so one person's bot doesn't
  make everyone reload. `approvalsChanged` and `settingsChanged` take the
  owning profile; only `serverSettingsChanged` (OIDC, onboarding, usage
  sharing) reaches everyone.
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
  query plans. A conversation's page is `messagePage`, which merges two
  index-ordered, limited halves: its own lines and the ones it sent. An OR
  there would sort the whole history. Unread counts and the profile badges read
  `gond_messages_unread` through the one `UNREAD_LINES` fragment, since a
  partial index only serves a query whose terms match its own exactly.
  A page of messages loads reactions and quotes in one query
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
  The computer keeps it too: every request about a home carries
  `X-Gond-Timezone` (`headersFor`), the box checks it (`timeZoneOf`) and
  sets `TZ` in `agentEnv`, so sites, `date` and files read the person's
  clock; a CLI session relaunches (resumed) when it changes, a browser or
  screen keeps the zone it started with. A bot's "Today is" is the
  person's date (`todayIn`), never UTC's.
- A hidden `prompt` message (author `system`) is how the API asks a bot
  to do something on its own; the dispatcher answers it like a message
  and the web never renders it.
- Tests: `bun test` in `apps/api/test`. Data tests use a temporary data
  directory; logic tests stay pure.

## The box from the API

- Anything that runs on the box goes through `src/box.ts`.
  `boxConfig(userId)` makes the client for one person, and every request
  about a home carries `X-Gond-User`. The box answers `no_account` for
  someone new; the client makes the account (`POST /accounts`) and
  retries, so nothing is set up ahead of time. `boxHome(userId)` is the
  home's path once known. Deleting a person removes their account and
  home (`removeBoxAccount`).
- The API never reads the Claude sign-in and never sends connected-app
  credentials to the box; app actions run through Composio in the API.
- **A Gond may have no computer** (`GOND_BOX_URL` unset): `boxConfig`
  is null and the API's own engines answer without one. The tools that
  need it are left out (`withoutComputer`, `COMPUTER_TOOLS`, the screen,
  shell and `run_with_secrets`), and so are the rules and notes about it
  (`houseRules(userId, false)`, whose `WITHOUT_COMPUTER` swaps must each
  match a line, `toolNotesFor`); a CLI engine posts a setup card. A box
  set up without its token yet reads as away, never as a crash. While a
  computer that is set up is away, only people on a CLI engine wait
  (`needsComputer`, the dispatcher's room per person); everything else a
  turn needs (memory, sessions, pictures) is the API's.

## Turns

- Long work is started by the dispatcher (`src/dispatcher.ts`) and
  awaited in the responder (`src/responder.ts`); a tick stays quick. The
  tick is every 2 s, but a new message or a bot coming free wakes it
  (`wake`). While the computer updates or resets (`src/updater.ts`)
  nothing new starts. Stalled handoffs are chased by `src/nudges.ts`.
  Five of each profile's bots answer at once (`TURNS_PER_PERSON`), no
  setting. A turn's setup runs side by side (SOUL.md only when changed,
  `soulsWritten`; memory; skills; apps; MCP listings cached five minutes,
  `listings`); the API's own engines don't wait for SOUL.md and the
  skills' folders to reach the computer. `GOND_TURN_TIMING=1` logs one timing line per turn
  (`timingLine`, `createTurnClock` in `src/work.ts`: setup parts, the
  router's time, how the CLI session started, tokens) and keeps the last
  500 for `GET /api/usage/turns`, 404 while off; `GOND_SCREEN_TIMING=1`
  on the box logs each screen batch (`screenTimer`).
- **A session hears only what's new.** `botTurn` sends a full prompt
  (house rules, the last `CONTEXT_LINES`) and a `followUp` with only
  what arrived since that agent's last turn (`runKey`, and what it saw in
  `gond_agent_sessions`: `agentSession`, `saveAgentSession`).
  `pickUp` forgets a CLI session whose last turn ran on another engine or
  account (`closeAgent`), and sends the full prompt when more lines
  arrived than the window holds. The transcript and the memory a prompt
  carries are read in `src/transcript.ts`. The box sends the follow-up only to a
  session it resumed (`turnPrompt` in `packages/box/sessions.mjs`).
  Each agent's session id is kept with it there and named to the box
  (`session`); the box keeps its own copy in `/state/sessions.json`
  (`createSessionStore`) and resumes that only for an API that names none
  (`sessionToStart`), so an upgrade loses no session. A session is tied
  to the model service it was made on (`backendOf`), and never resumed on
  another: Claude can't read another
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
- **Memory lives in the database** (`gond_bot_memory`, `gond_team_memory`,
  `src/data/memories.ts`), never in files: topic `""` is a MEMORY.md, the
  rest are topics (`topicName` reads `memory/x.md` and the like), read
  with `memory_read` and written whole with `memory_write`, both with
  `team` for the team's. File tools aimed at where it was kept are turned
  to those (`isMemoryFile`, in the native tools and the CLI's permission
  prompt). In a space whose owner left memory out, every memory tool
  refuses. Memory from before is moved in from the computer
  (`src/memory-moves.ts`): every bot and profile there was at the
  migration waits in `gond_memory_moves` (one made later never does), is
  moved at its first turn or by the sweep at start (`startMemoryMoves`),
  and until then reads `UNREADABLE` and can't be saved over, with or
  without a computer. Only what the database holds leaves the computer,
  the first move keeping a copy in `.memory-moved/`; only an unreachable
  computer (`away`) holds a move back, while a file it refuses stays
  where it is. A MEMORY.md a bot writes there later is merged in at its
  next turn (`mergeMemory`: neither side is lost, and `moved_hash` keeps
  a file that couldn't be removed from coming back). A reset first moves
  in what still waits, and wipes nothing if it can't.
- **Memory** (`src/memory.ts`): `MEMORY.md` loads up to
  `MAX_MEMORY_BYTES` (24 KB), the team's up to `MAX_TEAM_MEMORY_BYTES`
  (12 KB). Headings say how full it is, nudging from `NEARLY_FULL` (80%);
  past the limit `fitMemory` drops the middle, never the newest notes.
  `memory_update` and `team_memory_update` refuse anything over, and a
  save goes through only for a memory unchanged since the turn last saw
  it (`saveMemory`, `memoryRead`; a topic the turn never read counts as
  unseen); otherwise the bot hears it as it is now and merges into it, so
  two bots never drop each other's notes. The
  house rules say how to tend it (a pointer line per topic,
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
  took sets that bot's waiting cards there aside, unless it replies to a
  message (a tap on choices), which waits for the card (`setAside`: `expired`,
  outcome `aside`, "Set aside"), and the tool hears `setAsideText` with
  the line after it. Its decision is "deny", so a caller that never looks
  at `aside` still runs nothing.
- **Streaming** (`createWriting` in `src/writing.ts`): the whole redacted
  text so far, at most every `WRITING_INTERVAL_MS`, only for a turn whose
  answer goes to the person, never while it could still be `NOTHING_NEW`
  (`couldBeQuiet`), null when a tool call starts or the turn ends. A
  handoff (`message_bot`, `delegate_bot`; `isHandoff` in the box's
  `agents.mjs` and in `native.ts`, which `test/handoff.test.ts` keeps in
  agreement) ends nothing: what the bot wrote before
  it stays on screen and in the reply, since it was meant for the person;
  before any other tool it was narration and is dropped (`ReplyText`). Claude
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
  (`src/resume.ts`), and closes every open card, pausing those that can
  be answered late, whose message then isn't answered again
  (`pausedOn`). A turn the computer
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
  line of the person's (a hidden prompt's adds none beside one). Once the
  person's AI works (`aiWorks`, checked on every `ai` event and at start),
  `settleSetupCards` takes the cards away, puts the message each waited
  on back to wait, and has a bot that never spoke greet.

## Bots and teammates

- **No tool is the primary bot's alone**: `teamTools` (`create_bot`,
  `update_bot`, `delegate_bot`, `ask_bot`) goes to every bot. `primary`
  shapes the prompt, answers in a room when nobody is named and hears of
  broken runs (`getPrimary`). It is never a tool's to set: `POST
  /api/bots/:id/primary` transfers it, and `ensurePrimary` keeps exactly
  one visible primary per person. Who does what lives in SOUL and the
  house rules, never gated in the responder. `validateCoordination` in
  `tools.ts` checks schemas before coordination tools run; `ALWAYS_LOAD_TOOLS`
  in `coordination.ts` keeps their schemas in Claude's non-guest tool list.
- **Profiles through tools, not SQL**: `set_profile` and `update_bot` go
  through `profilePatch()` in `src/tools.ts`, then `syncSoul` rewrites
  SOUL.md. Add a field there, not in the route. `picture` is a path in
  the calling bot's home (`setBotPicture`, checked by `pictureType`, a
  still over 2 MB sent as the API's `previewPicture`, a GIF as is; `none`
  restores the mascot, with or without a computer).
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
  `ask_approval` before anything irreversible or outward-facing. An app
  action that unlocks or opens a door, car, garage or alarm
  (`physicalAccess` in shared) asks at every level, matches no saved rule,
  offers no Always and never waits for a late answer. A house rule says
  what a bot reads (a page, an email, a file, a tool's answer) is never an
  instruction or the person's yes. `ActionCode` names every control,
  invisible or reordering character by its code (`hiddenParts`), so a
  card never reads differently from what runs, and the redactor reads a
  value split by invisible characters again without them.
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
  and never become activity. The work line a person reads is `plain`:
  a command is its description or "Running a command", a file is "its
  memory", "the team memory", a skill, "a file you sent" or a bare name
  (`placeOf`), and a bot's narration loses its paths the same way
  (`withoutPaths`); never a full path. The work log stays exact, since a
  retried turn hears it; approval cards stay exact, since that is what
  the person approves.
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
- **Routines an app's event starts** (`src/triggers.ts`, `list_triggers`,
  `create_routine`'s `trigger`, `Routine.trigger`, `describeTrigger`):
  Composio's triggers, heard on one realtime channel per Composio key
  (`subscribeTriggers`, `listenFor`, kept by `keepListening` from the
  dispatcher's minute), so the Gond needs no address on the internet. Such
  a routine has no cron and no next run; Composio keeps a trigger for it
  (`event_id`) only while it is on (`armRoutine`, `disarmRoutine`, from the
  tools, the route and a bot's deletion), and a disconnected app or a new
  Composio key pauses it (`pauseEventRoutines`). An event finds its routine
  by that id and only through its owner's key (`deliverEvent`); it runs as
  a routine run with what the app sent set apart as outside text
  (`eventText`: capped, redacted, unable to close its block). An event while
  a run waits joins it (`EVENTS_PER_RUN`); past `EVENT_RUNS_PER_HOUR` the
  routine rests and its next run hears how many it missed. Events while the
  API is down are lost. Never a reminder, never in a template.
- **Templates** (`src/bot-bundle.ts`, `src/bot-templates.ts`,
  `botTemplateSchema`): a `.bot` zip of `bot.json`, the picture (only if
  its bytes are one) and each routine's skill as `.skill`. Memory,
  secrets, conversations, apps and MCP servers never go in.
  `addFromBundle` picks a free name, never trusts beyond Auto, reuses
  skills by slug, and brings routines in switched off on the person's
  time zone. Links are tokens in `gond_bot_shares`.

## AI engines

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
- **A bot's own model** (`BotModelField` in its Edit dialog, `model` on
  `POST`/`PATCH /api/bots`): one of the models the engine in use lists,
  kept with where it was picked (`modelSource`: engine and plan or API,
  `currentModel`), and run by `engineRun` only while the AI still runs
  there (`botModelFor`), so moving the AI never sends an id it doesn't
  know. Empty is Settings → AI's. `update_bot` sets it only to a model the
  AI lists (`matchModel`, `modelsInUse` in `src/models.ts`), never a guess;
  `list_bots` shows it. The router and check-ins keep the small model;
  templates never carry it.
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
- **Voice models** (`SPEECH_FAMILIES`, `speechModels`, `chosenModel` in
  shared; `src/speech-models.ts`; `GET /api/voice/models`): come from the
  voice key's own `/models`, OpenAI's or xAI's, kept ten minutes
  (`listedModels`); Gond keeps no list of them. Every version of a family
  it can talk to is offered, newest first, and the newest is the default.
  A family's pattern pins the major version Gond knows (a new one may talk
  differently), except xAI's realtime voice. A saved pick of null is the
  default and follows each newer model; picking the default item saves
  null. A pick runs only while the key offers it, so a shutdown or a move
  to another provider's key falls back to the default. A key that lists
  none, or won't say, runs on `VOICE_MODELS` and `CALL_MODELS`. A server
  of the person's own (`own`) adds its other ids and takes any id for the
  microphone.
- **Transcription** (`src/routes/voice.ts`, `src/data/voice.ts`,
  `voiceProvider`, `VOICE_MODELS`): the person's voice key, through
  `upstreamUrl` and `authHeaders`, on xAI's `stt` when it points at xAI. The format comes from the file's
  extension (Bun's multipart parser drops a part's type). Audio is never
  stored or logged.
- **Calls** (`src/calls.ts`, `src/voice-link.ts`, `src/routes/calls.ts`):
  `POST /api/threads/:id/call` takes only the primary bot's own chat
  (`callableBot`, so the route decides, not the button). On OpenAI the
  call's model picks the protocol (`callProtocol`): GPT-Live's own session, or the
  Realtime API (`realtimeLink`, `realtimeSession`, the path xAI takes,
  transcribing the person with `gpt-transcribe`), whose voices are fewer
  (`openAiCallVoices`). The API holds
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

## The screen

- **Bots use the screen through two tools, only by structured actions**
  (`src/computer-tool.ts`): `browser` (a persistent Chrome per bot,
  Playwright in the box, for every website) and `computer` (the whole
  desktop, xdotool). `{ actions: [...] }`, up to `MAX_SCREEN_STEPS` (20)
  of `SCREEN_STEP_TYPES`, answered with one screenshot and a line
  (`screenSummary`). The browser also returns its controls with refs
  (`compactSnapshot` in the box's `snapshot.mjs`), outputs, dialogs and
  downloads. After a turn's first list, each says only what changed since
  the one the model last saw (`listChanges`; the API sends that list's id
  as `since`, `lastList`, only within one turn and only for the model's own
  batches; `full_list` asks for all of it), compared only on the same tab
  and document, since a page loaded again numbers its refs anew. The
  screenshot labels each listed element with its ref (`drawMarks`, in a
  closed shadow root, taken away before anything else runs); a zoomed
  picture and one shared with the person (`marks: false`) go without.
  Steps name elements by `ref` or `label` (waits up to 8 s,
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

## Files, secrets, sign-ins

- **Files the person sends** (`src/inbox.ts`, `deliverAttachments`): each
  is written to `inbox/<id>-<name>` in the bot's folder when there is a
  computer; the model sees a picture's 1568 px preview (`previewPicture`)
  and a PDF up to 8 MB inline, and `attachmentNote` says what came and
  where. Any type is
  taken (`attachmentType`: the browser's type when Gond knows it, other
  text as plain text, else by the name, else `application/octet-stream`)
  and served as a sandboxed download unless it can't run script. Text
  and SVG are inlined as text (`attachmentText`, never bytes with a NUL);
  the original never goes to a model at full size. A
  HEIC or HEIF photo (`isHeic`, told by its bytes) is kept as a JPEG,
  made at upload (`jpegFromHeic`). Both are the API's (`src/image-work.ts`):
  ImageMagick built as WebAssembly (`@imagemagick/magick-wasm`, pinned)
  in one worker (`image-worker.ts`), one picture at a time with a time
  limit, read only by the coder its type names and under size limits, so
  a hostile picture reaches neither the API's memory nor its files and a
  slow one never holds up a request. Never a native image library in the
  API.
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
  expiry. A saved card never keeps its security code (`saveCard`,
  `forgetCardCodes`): paying with one asks for it each time
  (`checkCardCode`, `CardCodeField`), held only with that payment.
  `use_card` with the site and total posts the card request; that
  yes is the payment's approval (no extra `ask_approval`, no Always). The
  card is held for the conversation `CARD_HELD_MS` (10 min, `holdCard`)
  under `CARD_FIELDS` and typed with `type_login` (`select: true`,
  `selectOptions`). `readSecret` excludes cards; `request_secret` refuses
  card pieces; the redactor knows every grouping (`cardNumberForms`); and
  screen answers drop held values (`heldIn`). A screenshot still can show
  one.
- **Shopping** (`src/data/shopping.ts`, `src/shopping.ts`,
  `routes/shopping.ts`, `prepare_checkout` and `submit_checkout` in
  `computer-tool.ts`): products, checkouts and orders are encrypted rows of
  `gond_commerce`, the address apart (`private`), in private conversations
  only (never a space). A quote is bound to its revision and its live
  page's items and total; the purchase card is the payment's yes whatever
  the bot's level, and expires at `GOND_APPROVAL_TIMEOUT_MINUTES` with
  Gond's `CARD_EXPIRED_LINE` (`expireDueCheckouts`). One open checkout per
  bot locks its browser to that checkout. Only `submit_checkout` submits,
  once (`claimSubmission`); an unknown outcome is reconciled from the
  merchant, never retried. Stop calls off a checkout not yet submitted
  (`stopCheckoutsIn`); a restart turns `submitting` into `unknown` and
  expires approvals, since the approved card is held in memory. Orders are
  checked on a lease by hidden prompts (`runDueShoppingChecks`).
  `GOND_SHOPPING_PREVIEW` blocks every purchase step.
  `present_products` keeps only photos that load and fills a product
  left without one from its store page (`src/product-photos.ts`,
  `withPhotos`); every fetch stays on public HTTPS that resolves off the
  private network, redirects included (`getPublic`).
- **Website sign-ins** (`src/logins.ts`, `login-card.tsx`):
  `request_login` posts one card (`<SITE>_<KIND>`); values are held in
  memory for the conversation for 30 minutes and typed by `type_login`;
  the bot only hears names. The card names the host of the page the bot's
  browser has open (`siteOnPage`, `pageHost`), and what it holds is typed
  only on that site (`boundSite`, a registrable domain): the browser host
  checks the page just before typing (`heldTo`, `onSite`), and a detail
  held to a site never goes to the desktop. "Remember" stores a secret with a `site`; a
  code is never stored. A later request for saved details asks first
  (`mustAsk`). Matching is loose (`savedLoginFor`, `coverLogin`);
  `fresh` asks again; "Use a saved sign-in" fills from the API, the web
  never sees a value. `readLogin` reads only secrets with a site, so an
  API key is never typed into a page.
- **Your details** (`src/details.ts`, `data/details.ts`,
  `routes/details.ts`, `gond_details`, `details-card.tsx` in Settings →
  Your details): a profile's household records (people, IDs, insurance,
  vehicles; `DETAIL_KINDS`, `checkDetail`), every field sealed together.
  A field is a known detail (`DETAIL_FIELD_TYPES`: its name, input and
  check, `checkDetailValue`: a day as YYYY-MM-DD, an email, a phone, a VIN)
  picked from a list, or one the person names (`CUSTOM_DETAIL`, any words);
  the route checks it again, and a field saved before types or named by a
  bot is matched by its name (`detailTypeFor`). A
  private field's value never leaves the API: routes and `list_details`
  say only that it is saved, a private field left empty keeps its value,
  and one made readable must be typed again. Private values are secrets to
  the redactor (`privateDetailValues`). `use_details` asks on a strict card
  every time, whatever the level (`EVERY_TIME_TOOLS`, no Always, never
  late), then holds each value for 30 minutes under a `detailTypeName`
  (never a card's), bound to the site of the page the browser shows
  (`boundSite`), for `type_login`; with no page open it refuses. A
  screenshot can still show one. `save_details` saves readable fields only,
  on a card (`mustAsk`), and never overwrites a private one. An expiry
  reminds the primary bot by hidden prompt at 90, 30 and 7 days and on the
  day (`expiryStage`, `runDetailReminders`), in the person's daytime, each
  marked before it posts (`markReminded`); a new date starts over. Never in
  a space, an export or a template.

## Apps, MCP, skills

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
  `~/.claude`. A server that doesn't answer an opening `initialize` in
  `OPENING_WAIT_MS` is told "not now" for a minute (`forwardMcp`), and
  only a sign-in landing or ending changes a session's launch config
  (the `X-Gond-Mcp-Auth` header), so a dead server can't hold every
  session start for Claude Code's 30 s. The `api` engine serves a stale
  listing while it refreshes one beside the turn. OAuth follows the MCP authorization spec with dynamic
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

## People, notifications, updates

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
  pulls images, backs up the database (`createBackup("pre-update")`) and
  stops there, saying why, when it can't (`backupFailed`; only the admin's
  "Update without a backup" goes on), updates the computer (`updateComputer`), recreates web,
  and last starts a helper from the new API image to replace the API
  (`replaceSelf`), since a container can't recreate itself.
  `recreateContainer` drops what inspect folded in from the old image
  (env including the version, command, labels). Pages check `GET
  /api/version` on focus or reconnect and reload on change.
- **Data and backups** (`src/backup.ts`, `src/storage-worker.ts`,
  `routes/server.ts`, `server-storage-section.tsx` in Settings → Data &
  backups, admin only). Nothing heavy runs on the API's thread: a backup
  (`VACUUM INTO`), the storage figures and cleanup each run in a worker on
  a connection of its own (`inWorker`), backups and cleanups one at a time.
  Never a full `VACUUM`: it holds every write until the whole file is
  rewritten, so cleanup deletes in small batches and the space is used
  again, while the file keeps its size. A backup is checked against the
  disk first (`roomFor`, `HEADROOM`), removing only older ones of its own
  kind and only when that's enough, and goes under a temporary name
  renamed into `<dataDir>/backups/` (`0600`); a half-made one is cleared
  (`clearPartial`). The last 3 manual and 2 pre-update are kept (`KEEP`).
  Retention (`usage_keep_days`, `attachments_keep_days`) runs daily from
  the dispatcher (`runScheduledRetention`). A removed file is marked
  `removed` on its message in the same transaction that deletes it
  (`markRemoved`), so the chat draws "Removed to save space", the viewer
  skips it and a bot hears it's gone; its message stays.
  `SIGTERM`/`SIGINT` stop the dispatcher, usage sharing, federation and
  calls, drain HTTP and run `checkpointAndCloseDb` (`index.ts`).

## Spaces

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

## Show me how

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
