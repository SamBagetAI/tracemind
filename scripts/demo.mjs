#!/usr/bin/env node
/**
 * Fills a throwaway Tracemind home with made-up sessions, for screenshots and for trying the UI
 * without your own data:
 *
 *   pnpm build && TRACEMIND_HOME=/tmp/tm-demo node scripts/demo.mjs
 *   TRACEMIND_HOME=/tmp/tm-demo node dist/src/cli/index.js ui --port 4560
 *
 * Nothing here is real: the projects, titles and errors are invented.
 */
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { parseClaudeSession } from "../dist/src/core/parse-claude.js";
import { openSqlite } from "../dist/src/store/db.js";
import { Store } from "../dist/src/store/store.js";

const home = process.env.TRACEMIND_HOME;
if (!home) throw new Error("Set TRACEMIND_HOME to a throwaway folder first.");
mkdirSync(home, { recursive: true });

const ERRORS = {
  refused: "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Production Reads]. If you have other tasks that don't depend on this action, continue working on those.",
  unread: "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>",
  exit: "Exit code 2\nsrc/refunds.ts(14,7): error TS2304: Cannot find name 'Refund'.",
  module: "Exit code 1\nError: Cannot find module './config/stripe'",
  sleep: "<tool_use_error>Blocked: sleep 30 followed by: curl localhost:3000. To wait for a condition, use Monitor</tool_use_error>",
  changed: "<tool_use_error>File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.</tool_use_error>",
};

// [days ago, hour, project, title, minutes of work, failures as [tool, error kind]]
const SESSIONS = [
  [0, 9, "shop-api", "Add refunds to the checkout flow", 95, [["Bash", "refused"], ["Edit", "unread"], ["Bash", "module"], ["Bash", "module"], ["Edit", "changed"]]],
  [0, 14, "docs-site", "Fix broken links in the getting-started guide", 20, []],
  [1, 10, "shop-api", "Migrate orders table to the new schema", 140, [["Bash", "refused"], ["Bash", "refused"], ["Bash", "exit"], ["Edit", "unread"]]],
  [1, 16, "mobile-app", "Dark mode for the settings screen", 45, [["Edit", "changed"]]],
  [2, 11, "mobile-app", "Crash on login with expired token", 70, [["Bash", "sleep"], ["Bash", "exit"]]],
  [3, 9, "docs-site", "Write the API reference for webhooks", 35, []],
  [3, 15, "shop-api", "Rate-limit the public search endpoint", 60, [["Bash", "exit"], ["Edit", "unread"]]],
  [4, 10, "infra", "Rotate the staging database password", 25, [["Bash", "refused"]]],
  [5, 13, "mobile-app", "Upgrade the navigation library", 110, [["Bash", "module"], ["Bash", "module"], ["Bash", "exit"], ["Edit", "unread"], ["Bash", "sleep"], ["Edit", "changed"]]],
  [6, 9, "docs-site", "Translate the pricing page", 15, []],
  [9, 10, "shop-api", "Invoice PDFs come out blank", 80, [["Bash", "exit"], ["Bash", "refused"]]],
  [11, 14, "mobile-app", "Push notifications on Android", 50, [["Edit", "unread"]]],
  [12, 9, "docs-site", "Search for the changelog", 30, []],
];

function transcript(id, start, project, title, minutes, failures) {
  const t = (min) => new Date(start + min * 60000).toISOString();
  const base = { sessionId: id, cwd: `/Users/you/code/${project}`, gitBranch: "main", version: "2.1.0", isSidechain: false };
  const lines = [{ type: "custom-title", customTitle: title, sessionId: id }, { ...base, type: "user", timestamp: t(0), message: { role: "user", content: title } }];
  const steps = Math.max(6, Math.round(minutes / 4));
  const failAt = new Map(failures.map((f, i) => [Math.round(((i + 1) * steps) / (failures.length + 1)), f]));
  for (let i = 1; i <= steps; i++) {
    const at = (i * minutes) / (steps + 1);
    const fail = failAt.get(i);
    const tool = fail?.[0] ?? (i % 3 === 0 ? "Edit" : i % 2 === 0 ? "Read" : "Bash");
    const input = tool === "Bash" ? { command: fail?.[1] === "refused" ? "psql $PROD_DATABASE_URL -c 'select count(*) from orders'" : i % 4 === 0 ? "pnpm test" : "pnpm typecheck" } : { file_path: `/Users/you/code/${project}/src/app.ts` };
    lines.push({ ...base, type: "assistant", timestamp: t(at), message: { id: `${id}-m${i}`, model: "claude-opus-5-5", role: "assistant", content: [{ type: "tool_use", id: `${id}-t${i}`, name: tool, input }], usage: { input_tokens: 2000, cache_read_input_tokens: 60000, output_tokens: 900 } } });
    lines.push({ ...base, type: "user", timestamp: t(at + 0.3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `${id}-t${i}`, content: fail ? ERRORS[fail[1]] : "ok", is_error: !!fail } ] } });
  }
  lines.push({ ...base, type: "assistant", timestamp: t(minutes), message: { id: `${id}-end`, model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "Done." }], usage: { input_tokens: 1000, output_tokens: 300 } } });
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

const store = new Store(await openSqlite(join(home, "tracemind.db")));
await store.migrate();
const now = Date.now();
for (const [i, [ago, hour, project, title, minutes, failures]] of SESSIONS.entries()) {
  const d = new Date(now - ago * 86400000);
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() > now) d.setTime(now - (minutes + 5) * 60000);
  const id = `demo-${String(i).padStart(2, "0")}`;
  await store.saveTrace("local", parseClaudeSession(id, transcript(id, d.getTime(), project, title, minutes, failures), { person: "you" }));
}
await store.db.close();
console.log(`${SESSIONS.length} made-up sessions saved in ${home}.`);
