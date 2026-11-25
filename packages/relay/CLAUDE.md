# Relay: how we build it

Read with the root `CLAUDE.md`, whose rules (Bun only, copy, tests, before a
commit, things that stay true) hold here too.

- `packages/relay` (`gond-relay`): the Cloudflare Worker at `api.gond.io`
  (`src/worker.ts`, `wrangler.jsonc`) and the zero-dependency Ed25519
  signing helpers Gond servers import (`@gond/relay/client`,
  `@gond/relay/protocol`). The Worker name stays `gond-relay` so deploys
  preserve live Durable Object state, secrets and the `api.gond.io` route.
- **Push to phones** (`/v1/push`, `push.ts`): a Gond signs each push with
  its Ed25519 key (`pushRequest`, `signedPush`), the notice already sealed
  for that phone, and the Worker sends it through Firebase as the service
  account in the `FCM_SERVICE_ACCOUNT` Cloudflare secret, rate-limited per
  key in a `PushLimiter` Durable Object (`createPushLimiter`). Firebase
  hands an iPhone's to Apple with the APNs key uploaded to it. An iPhone
  gets a placeholder alert its extension rewrites, and a `quiet` push
  (taking a notice back) as a background one. `api.gond.io` is every
  Gond's push relay (`PUSH_RELAY_URL`), with no setting.
- **Public token count** (`/v1/usage`, `usage.ts`): a Gond signs a running
  total (`UsageReport`, an `epoch` per time sharing was turned on), and
  the Worker keeps the last per key and what each report added per UTC
  day, at most one report every `usageEveryMs` and growth held to
  `usageTokensPerHour`, in one Durable Object (`UsageTotals`) on
  Cloudflare. Anyone reads the totals; `gond.io/usage` (the landing
  site's, its own private repo) draws them.
