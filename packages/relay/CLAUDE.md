# Relay: how we build it

Read with the root `CLAUDE.md`, whose rules (Bun only, copy, tests, before a
commit, things that stay true) hold here too.

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
  It also keeps the public token count (`usage.ts`, `/v1/usage`): a Gond
  signs a running total (`UsageReport`, an `epoch` per time sharing was
  turned on), the relay keeps the last per key and what each report added
  per UTC day, at most one report every `usageEveryMs` and growth held to
  `usageTokensPerHour`, in one Durable Object (`UsageTotals`) on
  Cloudflare. Anyone reads the totals; gond.io/usage (the landing site's,
  its own private repo) draws them.
