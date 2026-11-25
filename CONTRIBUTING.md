# Contributing

Thanks for helping. Tracemind is small on purpose: plain rules, no model calls, data that stays on
your machine.

## Set up

```bash
pnpm install
pnpm test        # the whole suite, a few seconds
pnpm typecheck
pnpm build       # the server into dist/src, the web UI into dist/web
```

To try the UI without your own sessions, fill a throwaway home with made-up ones:

```bash
TRACEMIND_HOME=/tmp/tm-demo node scripts/demo.mjs
TRACEMIND_HOME=/tmp/tm-demo node dist/src/cli/index.js ui --port 4560
```

## Before you open a pull request

- Add or change a test for what you changed (`test/`). CI runs typecheck, tests and build on
  Node 22.13 and 24, and must pass.
- Keep numbers honest: every count the UI shows should match a recount from the raw transcripts.
- How the UI looks and why is in [DESIGN.md](DESIGN.md); where things live is in the
  [guide](docs/guide.md#develop).
- Never commit real session data. Screenshots use `scripts/demo.mjs`.
