# Gond: how we build it

Brand mark: the Gond mascot (a white cog with ink eyes) on the ink tile, made by `brandMark` and `mascot` in `scripts/brand.ts` from the geometry in `gond-bot-shapes.ts` (the app draws the same geometry in 3D; icons stay flat) and written to `packages/shared/brand/gond-mark.svg` (pinned by sha in `brand.test.ts`, byte-equal to the desktop's `logo.svg` and the figure the landing pins); every web, Android, iPhone and desktop icon derives from it; build with `bun run brand:build`, check with `bun run brand:build -- --check`; never edit the mark or a derived asset by hand, and never redraw the mascot for it.
The mascot spans `MARK_MASCOT` (74%) of what a surface shows (the launcher layers and splash `LAUNCHER_MASCOT`, the maskable icon `MASKABLE_MASCOT`); surfaces always 24 px or smaller (favicon frames to 48, status bar icons, the web badge) take `SMALL_MASCOT`, wider eyes in one place; one-colour layers are the cog with the eyes cut out. `brand.test.ts` fails a surface without both eyes, with the old cog-with-hole (a hole between the eyes, `r="12"`, a retired hash), outside its span or safe circle, or a silhouette that is not white.

Read this before changing anything. The README says what Gond is; this
says how it is made and which rules must hold. It names the files and
functions to start from; the code holds the details.

Rules for one part of the repo live beside it and load when you work
there: `apps/web/CLAUDE.md` (components, look, layout, data, features),
`apps/api/CLAUDE.md` (conventions, turns, bots, engines, the screen,
files and secrets, apps, notifications, Spaces, Show me how),
`packages/box/CLAUDE.md`, `packages/relay/CLAUDE.md`, and one in each of
`apps/desktop`, `apps/android`, `apps/ios` and `apps/mac`. Read the one for
the code you touch before changing it.

## The shape

- Bun workspaces monorepo. **Bun for everything, never npm or npx**: `bun
  install`, `bun run`, `bun x` / `bunx --bun`, `bun test`.
- `apps/web`: talks to the API through `/api/*` rewrites, so one origin
  and one cookie.
- `apps/api`: owns the database, drives the box, runs the dispatcher that
  answers messages and fires routines.
- `packages/box`: the bots' computer. Plain Node ESM (`.mjs`), no build
  step, runs as root only to drop to each person's user. Claude Code
  sessions in `agents.mjs` on the shared base in `bridge.mjs`; the `gond`
  MCP bridge in `packages/box/gond-mcp.mjs` preserves tool `_meta`, including
  `anthropic/alwaysLoad` for `ALWAYS_LOAD_TOOLS` in `apps/api/src/coordination.ts`.
  Guests and the self-driven engine get no hint; `message_bot`'s `kind` stays
  optional. Calls without arguments reach the API as an empty object; preserve
  schema-loading guidance in every bot's prompt.
- `packages/shared`: types, zod schemas, constants, templates, the app
  catalog. If web and api both need it, it goes here. One module per
  topic, all re-exported from `index.ts`. Every zod schema lives in
  `schemas.ts` or `shopping-schemas.ts` and the package is
  `sideEffects: false`, so the browser never loads zod. A module the web
  imports takes a schema only as a type (`import type`), never at runtime.
  Names are joined with `joinNames`.
- `packages/relay` (`gond-relay`): carries sealed envelopes between Gond
  servers for Spaces, push to phones and the public token count; its rules
  are in `packages/relay/CLAUDE.md`.
- CI builds the images (and `gond-relay`'s) and publishes them to GHCR.
  Builds start alongside the
  checks and nothing is published or released unless they pass. When a
  release tag lands with its main push, the tag's run publishes (`latest`
  too) and the main run leaves it alone.

### The apps around the web app

The desktop, Android, iPhone and Mac apps are shells: each ships one Connect
screen of its own, drawn with the web's tokens, then shows the Gond you
connected to, so every other screen is the web app. Each has exactly one
bridge, and every call on it checks that the page is on the saved
server's origin first, so a page from another origin (an OAuth provider
mid sign-in) can't use it. The address rules are mirrored in each app with
the same tests.

- **The apps are built only when they change, each on its own, never just
  because Gond ships.** A web or API change reaches them without a build.
  The `changes` job in `build.yml` compares a push with the commit before
  and a release tag with the release before, per app: `DESKTOP_FILES`
  (`apps/desktop/`, `assets/`), `ANDROID_FILES` (`apps/android/`,
  `assets/`), `IOS_FILES` (`apps/ios/`, `assets/`), `MAC_FILES`
  (`apps/mac/`, the iPhone files it builds, `assets/`), never a `.md`
  file, so an app's `CLAUDE.md` builds nothing. A release carries
  each unchanged app's last build (`carry_desktop`: installers and
  `latest.json`; `carry_android`: the APK; `carry_mac`: the dmg;
  `gh release download`), so the latest release always has what the
  updater and downloads read and no
  desktop app updates to an identical build. An app's version is the
  release it was last built for. After changing how an app builds, run
  the workflow by hand, which builds them all. Anything an app build
  starts to read from outside its folders goes into its pattern.

## Copy

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

## Tests

Prioritize development velocity without sacrificing meaningful
correctness.

- Don't write tests automatically for every function or change. Add one
  when it protects important behaviour, prevents a realistic regression
  or checks a meaningful edge case.
- Prefer a few high-value behavioural tests over exhaustive variations.
  Avoid redundant tests, heavy mocking and tests that only restate the
  implementation.
- While developing, run only the tests for the code you changed, not the
  full suite after every small edit. Run the full relevant suite before
  finishing a substantial change.
- Never change or delete an existing test just to make a failing
  implementation pass.
- Keep tests deterministic, fast and maintainable. Working, correct
  software matters more than test counts or coverage.

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
