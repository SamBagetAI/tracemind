<p align="center"><img src="web/public/slug.svg" width="200" alt="Tracemind's slug, crawling with its big brain on its back and leaving a trace"></p>

<h1 align="center">Tracemind</h1>

<p align="center">See what goes wrong in your Claude Code sessions, and fix it.</p>

<p align="center">
  <a href="https://github.com/SamBagetAI/tracemind/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/SamBagetAI/tracemind/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-1a3ad8"></a>
  <img alt="Claude Code" src="https://img.shields.io/badge/for-Claude%20Code-d97757?logo=claude&logoColor=white">
  <a href="docs/guide.md#mcp-tracemind-inside-claude"><img alt="MCP" src="https://img.shields.io/badge/MCP-14%20tools-black"></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A522.13-5fa04e?logo=nodedotjs&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white">
  <img alt="React" src="https://img.shields.io/badge/React-19.3-149eca?logo=react&logoColor=white">
  <img alt="SQLite or Postgres" src="https://img.shields.io/badge/SQLite%20%7C%20Postgres-local%20or%20shared-336791?logo=postgresql&logoColor=white">
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-10.33-f69220?logo=pnpm&logoColor=white">
</p>

![The Diary: the month in one sentence, then the three sessions worth a look](docs/screenshot-diary.png)

Tracemind reads your Claude Code sessions on your machine. It tells you how the week went, names
what keeps failing (refused commands, files edited before they were read, builds that break), and
suggests a fix to your Claude setup that you can apply, undo, and check later.

## Try it

```bash
git clone https://github.com/SamBagetAI/tracemind && cd tracemind
pnpm install && pnpm build && npm link
tracemind setup claude-code   # records every new session
tracemind import              # loads the last 30 days
tracemind ui                  # opens http://localhost:4545
```

Needs Node 22.13 or later. Your data stays in `~/.tracemind` unless you link a shared server.

## Ask Claude about it

```bash
tracemind setup mcp
```

Then ask Claude "what keeps going wrong in this repo?" or "show me the fix for the refused commands".

## More

The [guide](docs/guide.md) covers the shared server for a team, routines, every MCP tool, how fixes
work, what counts as an issue, and privacy. Try the UI on made-up data with `scripts/demo.mjs`.

MIT license.
