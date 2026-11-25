#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/** The `tracemind` command. */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { fitTrace } from "../core/fit.ts";
import { parseClaudeSession } from "../core/parse-claude.ts";
import { MAX_STEPS } from "../core/validate.ts";
import { openSqlite } from "../store/db.ts";
import { Store } from "../store/store.ts";
import { hooksInstalled, installHooks, listTranscripts, readSessionFiles, removeHooks } from "./claude.ts";
import { type Config, dbPath, ensureHome, home, loadConfig, logPath, saveConfig } from "./config.ts";

const WS = "local";
const PUSH_MAX_BYTES = 4_000_000;

const HELP = `tracemind: trace your coding agents and see what they knew

Local
  tracemind setup claude-code [--project]   Record every Claude Code session (adds two hooks)
  tracemind uninstall claude-code [--project]
  tracemind import [--days 30]              Load past Claude Code sessions
  tracemind ui [--port 4545] [--no-open]    Open the web UI on this machine
  tracemind status                          What is recorded and where
  tracemind context                         (run by a hook) Tell a new session what keeps going wrong in its project
  tracemind setup mcp                       Give Claude Code Tracemind's MCP tools (issues, sessions, fixes)
  tracemind mcp                             (run by Claude Code) The MCP server, over stdio

Shared server
  tracemind cloud setup --url URL --secret S --workspace NAME   Create the first admin token on a new server
  tracemind cloud link --url URL --token TOKEN                  Send this machine's sessions to a server
  tracemind cloud token --person NAME [--admin]                 Create a token for a teammate (admins)
  tracemind cloud unlink
  tracemind push [--all]                    Send sessions the server does not have yet
  tracemind serve [--port 8080]             Run the shared server (needs DATABASE_URL)

Data lives in ~/.tracemind (TRACEMIND_HOME to change it). Secrets, emails and card numbers
are removed before anything is stored.`;

/** The database holds session content: only its owner may read it, including SQLite's -wal and -shm files. */
function makePrivate() {
  for (const f of [home(), dbPath(), `${dbPath()}-wal`, `${dbPath()}-shm`, logPath()]) {
    try {
      chmodSync(f, f === home() ? 0o700 : 0o600);
    } catch {
      // Not created yet.
    }
  }
}

async function openStore(): Promise<Store> {
  ensureHome();
  const store = new Store(await openSqlite(dbPath()));
  await store.migrate();
  makePrivate();
  return store;
}

function log(line: string) {
  try {
    ensureHome();
    appendFileSync(logPath(), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Logging must never break a hook.
  }
}

/**
 * The command Claude Code runs for a hook. It goes through a small launcher in ~/.tracemind/bin
 * instead of naming one Node binary, so a Node upgrade (nvm moves the binary) does not break it:
 * the launcher uses the Node Tracemind was set up with if it is still there, else any Node 22.13+
 * on the PATH, and exits quietly if there is none, so Claude Code is never blocked.
 */
function selfCommand(sub: string, write = false): string {
  const script = realpathSync(fileURLToPath(import.meta.url));
  const flags = script.endsWith(".ts") ? "--experimental-strip-types --no-warnings" : "--no-warnings";
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  const launcher = join(home(), "bin", "tracemind-run");
  // Only setup writes the launcher; other commands name it, so starting the UI from another copy
  // of Tracemind never re-points the hooks the person installed.
  if (!write && existsSync(launcher)) return `"${launcher}" ${sub}`;
  const text = `#!/bin/sh
# Written by tracemind setup. Runs Tracemind with a Node that can (22.13 or later).
script=${q(script)}
for node in ${q(process.execPath)} "$(command -v node 2>/dev/null)"; do
  [ -n "$node" ] && [ -x "$node" ] || continue
  "$node" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null || continue
  exec "$node" ${flags} "$script" "$@"
done
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) no Node 22.13 or later found, nothing recorded" >> ${q(logPath())}
exit 0
`;
  // Written next to it and renamed over it, so a hook firing meanwhile never runs half a file;
  // and only when it changed.
  if (!existsSync(launcher) || readFileSync(launcher, "utf8") !== text) {
    mkdirSync(dirname(launcher), { recursive: true, mode: 0o700 });
    const tmp = `${launcher}.${process.pid}`;
    writeFileSync(tmp, text, { mode: 0o700 });
    chmodSync(tmp, 0o700);
    renameSync(tmp, launcher);
  }
  return `"${launcher}" ${sub}`;
}

/** The built web UI: dist/web next to dist/src when installed, or in dist/ when run from source. */
function webRoot(): string {
  const here = dirname(realpathSync(fileURLToPath(import.meta.url)));
  for (const dir of [resolve(here, "../../web"), resolve(here, "../../dist/web")]) {
    if (existsSync(resolve(dir, "index.html"))) return dir;
  }
  throw new Error("The web UI is not built. Run: pnpm build");
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function ingestFile(store: Store, cfg: Config, id: string, path: string) {
  const { lines, subagents } = readSessionFiles(path);
  const trace = parseClaudeSession(id, lines, { person: cfg.person, subagents });
  if (trace.steps.length === 0) return null;
  await store.saveTrace(WS, trace);
  return trace;
}

async function pushSessions(store: Store, cfg: Config, ids: string[], timeoutMs: number): Promise<{ sent: number; failed: string[] }> {
  if (!cfg.server) throw new Error("No server linked. Run: tracemind cloud link --url URL --token TOKEN");
  let sent = 0;
  const failed: string[] = [];
  for (const id of ids) {
    const trace = await store.trace(WS, id);
    if (!trace) continue;
    const { issues: _, ...full } = trace;
    // Vercel refuses request bodies over 4.5 MB; leave room for headers.
    const body = fitTrace(full, PUSH_MAX_BYTES, MAX_STEPS);
    try {
      const res = await fetch(new URL("/api/ingest", cfg.server.url), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.server.token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
      await store.markPushed(WS, id);
      sent++;
    } catch (e) {
      failed.push(`${id}: ${(e as Error).message}`);
    }
  }
  return { sent, failed };
}

async function api(url: string, path: string, init: RequestInit & { token?: string; secret?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.secret) headers["x-setup-secret"] = init.secret;
  const res = await fetch(new URL(path, url), { ...init, headers, signal: AbortSignal.timeout(15000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} from the server`);
  return body;
}

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
}

async function main(argv: string[]) {
  process.umask(0o077);
  const [cmd, sub, ...rest] = argv;
  const cfg = loadConfig();

  switch (cmd) {
    case "hook": {
      // Called by Claude Code at the end of each turn and of each session. Never fails loudly.
      try {
        const input = JSON.parse((await readStdin()) || "{}");
        const path: string | undefined = input.transcript_path;
        const id: string | undefined = input.session_id;
        if (!path || !id || !existsSync(path)) return;
        const store = await openStore();
        const trace = await ingestFile(store, cfg, id, path);
        if (trace && cfg.server && cfg.autoPush !== false) {
          const r = await pushSessions(store, cfg, [id], 4000);
          for (const f of r.failed) log(`push failed ${f}`);
        }
        await store.db.close();
      } catch (e) {
        log(`hook error: ${(e as Error).stack ?? e}`);
      }
      return;
    }

    case "context": {
      // Called by Claude Code when a session starts (the routine a suggestion installs). Prints the
      // problems that keep happening in this project so the new session knows them. Never fails loudly.
      try {
        const input = JSON.parse((await readStdin()) || "{}");
        const cwd: string = input.cwd ?? process.cwd();
        const store = await openStore();
        const { sessionContext } = await import("../server/suggestions.ts");
        const text = await sessionContext(store, WS, cwd);
        await store.db.close();
        if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }));
      } catch (e) {
        log(`context error: ${(e as Error).stack ?? e}`);
      }
      return;
    }

    case "setup":
    case "uninstall": {
      if (sub === "mcp") {
        // Registered with Claude Code's own command, for every project (user scope). It runs through
        // the same launcher as the hooks, so a Node upgrade does not break it either.
        selfCommand("mcp", true);
        const launcher = join(home(), "bin", "tracemind-run");
        const args = cmd === "setup" ? ["mcp", "add", "tracemind", "--scope", "user", "--", launcher, "mcp"] : ["mcp", "remove", "tracemind", "--scope", "user"];
        const r = spawnSync("claude", args, { stdio: "inherit" });
        if (r.error) {
          console.log(`The claude command was not found. Add this MCP server to your client by hand:
  { "mcpServers": { "tracemind": { "command": ${JSON.stringify(launcher)}, "args": ["mcp"] } } }`);
          return;
        }
        if (r.status === 0 && cmd === "setup") console.log("Claude Code can now use Tracemind's tools (issues, sessions, fixes) in every project. Start a new session to load them.");
        process.exitCode = r.status ?? 1;
        return;
      }
      if (sub !== "claude-code") throw new Error(`Supported: tracemind ${cmd} claude-code, tracemind ${cmd} mcp`);
      const { values } = parseArgs({ args: rest, options: { project: { type: "boolean" } } });
      const scope = values.project ? "project" : "user";
      if (cmd === "uninstall") {
        const file = removeHooks(scope, process.cwd());
        console.log(file ? `Removed Tracemind's hooks from ${file}` : "No hooks to remove.");
        return;
      }
      saveConfig(cfg);
      const file = installHooks(selfCommand("hook", true), scope, process.cwd());
      const store = await openStore();
      await store.db.close();
      console.log(`Claude Code will now record each session (hooks added to ${file}).
Sessions are saved as ${cfg.person} in ${dbPath()}.

Next:
  tracemind import     load the sessions you already have
  tracemind ui         open the web UI`);
      return;
    }

    case "import": {
      const { values } = parseArgs({ args: [sub, ...rest].filter(Boolean) as string[], options: { days: { type: "string", default: "30" } } });
      const days = Math.max(1, Number(values.days) || 30);
      const files = listTranscripts(days);
      const store = await openStore();
      let saved = 0;
      let errors = 0;
      for (const [i, f] of files.entries()) {
        try {
          if (await ingestFile(store, cfg, f.id, f.path)) saved++;
        } catch (e) {
          errors++;
          log(`import ${f.path}: ${(e as Error).message}`);
        }
        if (process.stdout.isTTY) process.stdout.write(`\rImporting ${i + 1}/${files.length}`);
      }
      const { pruneIssues } = await import("../store/insights.ts");
      await pruneIssues(store, WS);
      await store.db.close();
      console.log(`${process.stdout.isTTY ? "\n" : ""}Imported ${saved} sessions from the last ${days} days${errors ? `, ${errors} could not be read (see ${logPath()})` : ""}.`);
      return;
    }

    case "ui": {
      const { values } = parseArgs({ args: [sub, ...rest].filter(Boolean) as string[], options: { port: { type: "string", default: "4545" }, "no-open": { type: "boolean" } } });
      const { serve } = await import("@hono/node-server");
      const { createApp } = await import("../server/app.ts");
      const store = await openStore();
      const app = createApp({ store, mode: "local", localPerson: cfg.person, webRoot: webRoot(), contextCommand: selfCommand("context") });
      const port = Number(values.port);
      const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
        const url = `http://localhost:${port}`;
        console.log(`Tracemind is running at ${url} (Ctrl+C to stop)`);
        if (!values["no-open"]) openBrowser(url);
      });
      server.on("error", (e: NodeJS.ErrnoException) => {
        if (e.code !== "EADDRINUSE") throw e;
        console.error(`Port ${port} is already in use, most likely by another \`tracemind ui\`.
Stop that one (Ctrl+C in its terminal), or use another port: tracemind ui --port ${port + 1}`);
        process.exit(1);
      });
      return;
    }

    case "mcp": {
      // stdout carries the MCP protocol: nothing else may be printed to it.
      const { createApp } = await import("../server/app.ts");
      const { createMcpServer } = await import("../mcp/server.ts");
      const { apiCaller } = await import("../mcp/call.ts");
      const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
      const store = await openStore();
      const app = createApp({ store, mode: "local", localPerson: cfg.person, contextCommand: selfCommand("context") });
      await createMcpServer(apiCaller(app), { canApply: true }).connect(new StdioServerTransport());
      return;
    }

    case "status": {
      const store = await openStore();
      const all = await store.sessions(WS, { limit: 1 });
      const o = await store.overview(WS, new Date(0).toISOString());
      const unpushed = cfg.server ? (await store.unpushed(WS, 100000)).length : 0;
      await store.db.close();
      const hooks = hooksInstalled(process.cwd());
      // The hook launcher exits quietly when it finds no usable Node; say so here, where someone looks.
      const lastLog = existsSync(logPath()) ? readFileSync(logPath(), "utf8").trimEnd().split("\n").pop() ?? "" : "";
      const noNode = lastLog.includes("no Node 22.13") ? `\nWarning:  ${lastLog}. Run tracemind setup claude-code again.` : "";
      console.log(`Person:   ${cfg.person}
Data:     ${dbPath()}
Sessions: ${o.sessions}${all[0] ? ` (last ${all[0].endedAt})` : ""}
Issues:   ${o.openIssues} open
Hooks:    ${hooks.length ? hooks.join(" and ") + " settings" : "not installed (tracemind setup claude-code)"}
Server:   ${cfg.server ? `${cfg.server.url} as ${cfg.server.person} in ${cfg.server.workspace}, ${unpushed} not pushed` : "none"}${noNode}`);
      return;
    }

    case "push": {
      const { values } = parseArgs({ args: [sub, ...rest].filter(Boolean) as string[], options: { all: { type: "boolean" } } });
      const store = await openStore();
      const ids = values.all ? (await store.sessions(WS, { limit: 100000 })).map((s) => s.id) : await store.unpushed(WS, 100000);
      const r = await pushSessions(store, cfg, ids, 30000);
      await store.db.close();
      console.log(`Sent ${r.sent} of ${ids.length} sessions to ${cfg.server!.url}.`);
      for (const f of r.failed.slice(0, 10)) console.log(`  failed ${f}`);
      if (r.failed.length) process.exitCode = 1;
      return;
    }

    case "cloud": {
      const { values } = parseArgs({
        args: rest,
        options: {
          url: { type: "string" },
          token: { type: "string" },
          secret: { type: "string" },
          workspace: { type: "string" },
          person: { type: "string" },
          admin: { type: "boolean" },
        },
      });
      if (sub === "setup") {
        if (!values.url || !values.secret || !values.workspace) throw new Error("Usage: tracemind cloud setup --url URL --secret S --workspace NAME");
        const person = values.person ?? cfg.person;
        const r = await api(values.url, "/api/setup", { method: "POST", secret: values.secret, body: JSON.stringify({ workspace: values.workspace, person }) });
        cfg.server = { url: values.url, token: r.token, workspace: r.workspace, person: r.person };
        cfg.autoPush = true;
        saveConfig(cfg);
        console.log(`Workspace ${r.workspace} is ready and this machine is linked as its admin, ${r.person}.
Sign in to ${values.url} with this token (it is also saved in ~/.tracemind/config.json):

  ${r.token}

Then: tracemind push`);
        return;
      }
      if (sub === "link") {
        if (!values.url || !values.token) throw new Error("Usage: tracemind cloud link --url URL --token TOKEN");
        const me = await api(values.url, "/api/me", { token: values.token });
        cfg.server = { url: values.url, token: values.token, workspace: me.workspace, person: me.person };
        cfg.autoPush = true;
        saveConfig(cfg);
        console.log(`Linked to ${values.url} as ${me.person} in ${me.workspace}. New sessions are sent when Claude Code saves them.
Send the ones you already have with: tracemind push`);
        return;
      }
      if (sub === "token") {
        if (!cfg.server) throw new Error("Link a server first: tracemind cloud link --url URL --token TOKEN");
        if (!values.person) throw new Error("Usage: tracemind cloud token --person NAME [--admin]");
        const r = await api(cfg.server.url, "/api/tokens", {
          method: "POST",
          token: cfg.server.token,
          body: JSON.stringify({ person: values.person, role: values.admin ? "admin" : "member" }),
        });
        console.log(`Token for ${r.person} (${r.role}) in ${r.workspace}. Send it to them privately; it is shown once:

  ${r.token}

They run: tracemind cloud link --url ${cfg.server.url} --token <token>`);
        return;
      }
      if (sub === "unlink") {
        delete cfg.server;
        saveConfig(cfg);
        console.log("This machine no longer sends sessions to a server.");
        return;
      }
      throw new Error("Usage: tracemind cloud setup|link|token|unlink");
    }

    case "serve": {
      const { values } = parseArgs({ args: [sub, ...rest].filter(Boolean) as string[], options: { port: { type: "string", default: process.env.PORT ?? "8080" } } });
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error("Set DATABASE_URL to a Postgres database.");
      const { serve } = await import("@hono/node-server");
      const { createApp } = await import("../server/app.ts");
      const { openPostgres } = await import("../store/db.ts");
      const store = new Store(await openPostgres(url));
      await store.migrate();
      const app = createApp({ store, mode: "server", setupSecret: process.env.TRACEMIND_SETUP_SECRET, webRoot: webRoot() });
      serve({ fetch: app.fetch, port: Number(values.port), hostname: "0.0.0.0" }, () => console.log(`Tracemind server on port ${values.port}`));
      return;
    }

    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;

    default:
      throw new Error(`Unknown command: ${cmd}\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
