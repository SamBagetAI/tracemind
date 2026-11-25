# Tracemind

Trace your coding agents and see what they knew.

Tracemind records each Claude Code session: every prompt, reply and tool call, the subagents it
started, and the **memory it used**: the CLAUDE.md and AGENTS.md files it loaded, the skills it
read, and the memory files it read and wrote. Failures are grouped into issues across sessions,
and an issue you mark resolved opens again if it happens in a later session.

It runs on your machine first. When a team wants one shared view, the same app runs as a server.

## On your machine

Needs Node 22.13 or later.

```bash
npm install -g tracemind        # or, from this repo: pnpm install && pnpm build && npm link
tracemind setup claude-code     # adds a Stop and a SessionEnd hook to ~/.claude/settings.json
tracemind import                # loads your sessions from the last 30 days
tracemind ui                    # opens http://localhost:4545
```

Data lives in `~/.tracemind/tracemind.db` (SQLite) and never leaves the machine unless you link a
server. `tracemind setup claude-code --project` adds the hooks to one repo only;
`tracemind uninstall claude-code` takes them out.

## Shared server

The server is the same app on Postgres, with workspaces and tokens.

1. Deploy this repo to Vercel (or run `tracemind serve` anywhere Node runs) with
   `DATABASE_URL` (a Postgres database, e.g. Neon) and `TRACEMIND_SETUP_SECRET` (any long
   random string).
2. Create the workspace and its first admin, from your machine:
   `tracemind cloud setup --url https://your-server --secret <setup secret> --workspace acme`.
   Setup works once; after that the secret does nothing.
3. Send what you have: `tracemind push`. New sessions are sent when Claude Code saves them.
4. Invite a teammate: `tracemind cloud token --person "Grace"`. They run
   `tracemind cloud link --url https://your-server --token <token>`.

People sign in to the web UI with their token. On a server, a session is filed under the person
who owns the token that sent it, whatever the client says.

## Suggestions

The Suggestions page turns what keeps going wrong into changes to how Claude is used:
- **A rule:** added to your global `~/.claude/CLAUDE.md` or to a project's CLAUDE.md or AGENTS.md.
- **A routine:** a SessionStart hook that tells each new session what keeps going wrong in its project.
- **A prompt to hand to Claude:** for things that need a person, such as signing a connector in or trimming a file that is too big.

Every file change is previewed first, backed up, and can be undone. Once a suggestion is applied, the page shows
how often the problem happened before and since. Changes are only made from the local app, on localhost.

## What it finds

| Issue | When |
|---|---|
| Tool error | A tool call failed. Errors that differ only in paths, ids and numbers are one issue. |
| Permission refused | A tool call was denied, blocked or rejected. |
| Step repetition | The same tool was called with the same input three or more times in a row. |
| Stopped by a person | Someone interrupted the agent. |

No model is involved: these are plain rules in `src/core/issues.ts`.

## Privacy

API keys, tokens, passwords, private keys, emails and card numbers are removed before anything
is stored, on the machine and again on the server (`src/core/redact.ts`). Long outputs are cut.
Sessions too large to send in one request are shrunk first: long outputs of steps that went fine
are cut, then steps from the middle are left out with a marker; failures and memory are kept.

## Develop

```bash
pnpm install
pnpm test        # parser, redaction, issues, both databases, the API, the trace view and the hooks
pnpm build       # the server into dist/src, the web UI into dist/web
pnpm dev:web     # the UI with hot reload on :5173, using the API of `tracemind ui` on :4545
```

`src/core` reads transcripts and finds issues, `src/store` is SQLite and Postgres behind one
interface, `src/server` is the Hono API that also serves the UI, `src/cli` is the command, `api/` is
the Vercel entry. `web/` is the UI: React, [shadcn/ui](https://ui.shadcn.com) components in
`web/src/components/ui`, and two [Magic UI](https://magicui.design) pieces (blur-fade, number
ticker). How it looks and why is in [DESIGN.md](DESIGN.md).

The Claude Code transcript format is not a public contract. Unknown lines are skipped, so a
change there loses detail rather than breaking the import.

## License

MIT
