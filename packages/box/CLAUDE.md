# Box: how we build it

Read with the root `CLAUDE.md`, whose rules (Bun only, copy, tests, before a
commit, things that stay true) hold here too.

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
  (memories, `SOUL.md`, the team's, CLI sign-ins, browser profiles), and
  the API forgets their bots' sessions (`forgetAgentSessions`). Memory is
  the database's, so no reset touches it.
  Everything else is made again as used. `DELETE /accounts/:id` removes a
  person entirely.
- **One process serves everyone, so nothing in it blocks.** CLI probes
  (`claudeVersion`, `authStatus`) run through `queryClaude` with a
  deadline, one lookup in flight; shared files stream from their checked
  descriptor; a skill folder's writes run one change at a time; `/stats`
  reads `/proc` asynchronously.
- **Sessions** (`agents.mjs`): `AgentSession.spawn` resolves as soon as
  Claude Code runs and the prompt goes to stdin at once. A CLI too old
  for an optional flag (`OPTIONAL_FLAGS`, `FLAG_FLOORS`) exits before
  init, the turn ends `flagRejected` and is relaunched without them, as
  after a failed resume. Usage per result
  (`model_usage_since_last_result`, or the change in `modelUsage` on an
  older CLI) is a `usage` event; `rate_limit_event` is a `limits` event
  (`usageSince`, `planLimits`, `countUsage`). A changed system prompt
  reaches a running session as only the `## ` sections that changed or
  went (`promptChangeReminder`), since every word stays in its history.
  Claude Code's own auto memory is off (`SESSION_ENV`): it kept notes in
  `~/.claude/projects` that Gond never loads, so a bot said it saved
  what only one engine would see. Notes kept there before are moved into
  the bot's MEMORY.md once (`foldClaudeMemory`, `fold-memory`).
- **Models** (`models.mjs`): the list is the CLI's own, asked as the
  person (`claudeModelInfo`: the `models` of its answer to an `initialize`
  control request, no model called, the person's hooks off with
  `disableAllHooks` since the handshake starts a session, the process
  stopped once it answers or at its timeout). `modelsFromInfo` keeps its
  order and leaves out only broken or repeated rows, the `default` pointer
  and a row naming a model already listed, never a model by name or
  version; names and details are one line, capped; `opus` is marked
  default when listed. `createModelLists` keeps a good list five minutes
  (`MODELS_TTL_MS`), one look at a time. A failed look is retried every
  minute and keeps the last good list at most `LAST_GOOD_MS` (24 hours)
  after the CLI gave it, then `FALLBACK_CLAUDE_MODELS`, version-free
  aliases (a test fails on a digit), so the list is never empty, a
  retired model is gone within a day at worst, and nothing in it is
  edited by hand. A sign-in, an update or a reset forgets the lists.
- **Sign-in** (`sign-in.mjs`): the CLI's own login in a pty as the
  person (wide so links don't wrap, `CI` dropped), the link parsed out,
  the code written back, the result confirmed by the CLI. Only the link,
  the code and a short error leave; never the transcript. Pure and tested
  (`test/sign-in.test.mjs`).
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
