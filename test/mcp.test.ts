import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { parseClaudeSession } from "../src/core/parse-claude.ts";
import { apiCaller } from "../src/mcp/call.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { createApp } from "../src/server/app.ts";
import { fromPgQueryable, openSqlite } from "../src/store/db.ts";
import { Store } from "../src/store/store.ts";
import { mainTranscript } from "./fixtures/session.ts";

async function localClient() {
  const store = new Store(await openSqlite(join(mkdtempSync(join(tmpdir(), "tm-mcp-")), "t.db")));
  await store.migrate();
  await store.saveTrace("local", parseClaudeSession("sess-1", mainTranscript(), { person: "Ada" }));
  const app = createApp({ store, mode: "local", localPerson: "Ada" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(apiCaller(app), { canApply: true }).connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  return { app, client };
}

const read = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
};

describe("MCP server", () => {
  it("lists the read tools and, on the local app, the tools that apply fixes", async () => {
    const { client } = await localClient();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["overview", "list_issues", "get_issue", "list_sessions", "get_session", "list_tools", "list_fixes", "preview_fix", "apply_fix", "undo_fix", "dismiss_fix", "resolve_issue", "import_routine_runs", "routine_sync_status"]));
  });

  it("gives the same numbers as the web UI's API", async () => {
    const { app, client } = await localClient();
    const o = await read(client, "overview", { days: 365 });
    const api = await (await app.request("/api/overview?days=365")).json();
    expect(o.sessions).toBe(api.sessions);
    expect(o.hitAnIssue).toBe(api.withIssues);
    expect(o.toolCallsFailed).toBe(api.toolErrors);
  });

  it("finds an issue by name and shows its error, sessions and steps", async () => {
    const { client } = await localClient();
    const { issues } = await read(client, "list_issues", { days: 365, include_one_offs: true });
    expect(issues.length).toBeGreaterThan(0);
    const one = await read(client, "get_issue", { issue: issues[0].issue, days: 365 });
    expect(one.issue).toBe(issues[0].issue);
    expect(one.sessions[0].id).toBe("sess-1");
    expect(one.sessions[0].step).toBeGreaterThan(0);
    const byKey = await read(client, "get_issue", { issue: issues[0].key, days: 365 });
    expect(byKey.issue).toBe(one.issue);
  });

  it("shows a session's failures with their full error", async () => {
    const { client } = await localClient();
    const s = await read(client, "get_session", { id: "sess-1" });
    expect(s.failedCalls).toBeGreaterThan(0);
    expect(s.failures[0].error).toContain("Cannot find module");
    expect(s.loadedAtStart).toContain("/work/shop/CLAUDE.md");
  });

  it("says what is wrong instead of failing silently", async () => {
    const { client } = await localClient();
    const r = (await client.callTool({ name: "get_issue", arguments: { issue: "nothing like this", days: 30 } })) as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("list_issues");
  });
});

describe("routine runs over MCP", () => {
  it("imports a routine's runs as sessions with their issues, and again without duplicates", async () => {
    const { app, client } = await localClient();
    const log = [
      "[2026-11-24T16:12:50.100000Z] env[info]: Allocating sandbox",
      "[2026-11-24T16:12:51.200000Z] init: model=claude-opus-5-5 cwd=/home/claude",
      '[2026-11-24T16:34:09.449099Z] tool_use mcp__remote__delete_trigger: {"trigger_id":"t"}',
      "[2026-11-24T16:34:12.549402Z] permission_denied mcp__remote__delete_trigger [classifier]: [Destructive or Unwanted Actions]",
      "[2026-11-24T16:34:12.630760Z] tool_result ERROR: Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Destructive or Unwanted Actions].",
      "[2026-11-24T16:34:23.698792Z] result: success is_error=false turns=2 duration=30s — done",
    ].join("\n");
    const first = await read(client, "import_routine_runs", { routine: "Call notes", session_id: "session_X", log });
    expect(first).toMatchObject({ imported: 1, failedCalls: 1 });
    await read(client, "import_routine_runs", { routine: "Call notes", session_id: "session_X", log });
    const list = await (await app.request("/api/sessions?limit=2000")).json();
    expect(list.filter((x: { id: string }) => x.id.startsWith("routine-")).length).toBe(1);
    const status = await read(client, "routine_sync_status");
    expect(status.routineSessions).toEqual([{ sessionId: "session_X", runs: 1, newestRunEnded: "2026-11-24T16:34:23.698Z" }]);
  });
});

describe("fixes found in any window", () => {
  it("previews a fix whatever window listed it", async () => {
    const { client } = await localClient();
    for (const days of [7, 30, 365]) {
      const { fixes } = await read(client, "list_fixes", { days, status: "all" });
      for (const f of fixes) expect(await read(client, "preview_fix", { id: f.id })).toBeTruthy();
    }
  });
});

describe("MCP over HTTP on a shared server", () => {
  async function serverApp() {
    const store = new Store(fromPgQueryable(new PGlite() as any));
    await store.migrate();
    const token = await store.createToken("acme", "Ada", "admin");
    return { app: createApp({ store, mode: "server" }), token };
  }
  const rpc = (body: unknown, token?: string) => ({
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

  it("needs a token, and never offers to change files on the server", async () => {
    const { app, token } = await serverApp();
    expect((await app.request("/mcp", rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }))).status).toBe(401);
    const init = await app.request("/mcp", rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, token));
    expect(init.status).toBe(200);
    const list = await app.request("/mcp", rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, token));
    const names = ((await list.json()).result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain("list_issues");
    expect(names).not.toContain("apply_fix");
  });
});
