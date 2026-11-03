# Gond's benchmark

Measures speed and quality together on a running Gond, so a change that makes bots faster but worse is caught. It costs real tokens, so it isn't part of `bun run test`.

## What it needs

- A Gond running from this checkout with `GOND_TURN_TIMING=1` on the API. `compose.bench.yml` builds one as its own project, with its own volumes and setup token `bench-setup-token`: `docker compose -p gond-bench -f docker-compose.yml -f packages/bench/compose.bench.yml up -d --build` from the repo root. Set `GOND_SCREEN_TIMING=1` on the box too to see where screen time goes in its log.
- The computer and the API must reach this machine at `BENCH_FIXTURE_HOST` (default `host.docker.internal`, which Docker Desktop and WSL's Docker provide; on plain Linux add `extra_hosts: ["host.docker.internal:host-gateway"]` to the api and box services).
- For the `claude` engine, Claude Code installed in the bench account's home on the computer, since the image doesn't carry it. The account is the admin's, `agent`: `docker exec -u agent -e HOME=/home/agent gond-bench-box-1 bash -lc "curl -fsSL https://claude.ai/install.sh | bash"`. On a plan it must also be signed in once by hand (Settings → AI); on a key (`BENCH_CLAUDE_ACCESS=api`) it needs no sign-in.

| Variable | What it is | Default |
| --- | --- | --- |
| `GOND_URL` | The Gond's address | `http://localhost:3000` |
| `BENCH_USER`, `BENCH_PASSWORD` | The account the bench uses; registered with `GOND_SETUP_TOKEN` on a fresh Gond | `bench`, required |
| `GOND_SETUP_TOKEN` | Only for a fresh Gond, to register the account | none |
| `BENCH_API_KEY` (or `BENCH_ANTHROPIC_KEY`) | The key the `api` engine runs on | required for `api` |
| `BENCH_API_PROVIDER`, `BENCH_API_BASE_URL` | `anthropic`, or `openai` for any OpenAI-compatible endpoint, and its address | `anthropic`, its own |
| `BENCH_API_MODEL`, `BENCH_CLAUDE_MODEL` | The models under test | `claude-opus-5-5`, `opus` |
| `BENCH_JUDGE_KEY`, `BENCH_JUDGE_MODEL` | The judge's key (else `ANTHROPIC_API_KEY`) and model, kept the same across runs | `claude-opus-5-5` |
| `BENCH_CLAUDE_ACCESS`, `BENCH_CLAUDE_BASE_URL`, `BENCH_CLAUDE_KEY` | Claude Code on the plan, or `api` on an Anthropic-compatible key and its address (DeepSeek's is `https://api.deepseek.com/anthropic`) | `plan` |
| `BENCH_JUDGE_URL` | Grade on an OpenAI-compatible endpoint instead of Anthropic's | none |
| `BENCH_FIXTURE_HOST`, `BENCH_FIXTURE_PORT` | Where the bench serves its pages and MCP servers | `host.docker.internal`, `4790` |

Use a Gond with nothing else on it: the bench switches its AI settings while it runs (and puts them back), and makes and deletes bots, rooms and MCP servers.

## Running it

```sh
bun run bench -- --label baseline            # all suites, both engines, 5 repeats
bun run bench -- --label quick --engines api --suites chat --repeat 1
bun run bench:compare packages/bench/results/baseline-*.json packages/bench/results/after-phase-1-*.json
```

Run the baseline three times before changing anything: compare takes every file but the last as the baseline and uses the worst of them as the floor, so run-to-run noise isn't read as a drop. It exits 1 when any engine and suite's pass rate or judge score falls below that floor.

## What a case records

Each case run gets fresh codes, so nothing can be answered from memory. It records:

- whether it passed: checks the bench can verify, such as a file on the computer, a form the fixture page received, or the right bot picked;
- a judge score from 1 to 5 against a rubric for open-ended answers;
- the time to the first words on screen and to the end of the turn;
- the setup, router and queue times, and how the Claude Code session started;
- tokens, with the cached share.

The suites are `chat`, `rooms`, `browser` and `desktop` (`src/cases.ts`).
