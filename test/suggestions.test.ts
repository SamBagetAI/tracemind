/**
 * Suggestions end to end on throwaway folders: made from sessions, applied to a CLAUDE.md and to
 * Claude Code settings, undone exactly, and refused when the request does not come from the local
 * app on localhost.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseClaudeSession } from "../src/core/parse-claude.ts";
import { createApp } from "../src/server/app.ts";
import { projectRoot, sessionContext } from "../src/server/suggestions.ts";
import { openSqlite } from "../src/store/db.ts";
import { issueGroups } from "../src/store/insights.ts";
import { Store } from "../src/store/store.ts";

let claudeDir: string;
let project: string;

/** A session in `project` where the agent waited with sleep, edited before reading, and read production data. */
function session(id: string, at: number) {
  const t = (s: number) => new Date(at + s * 1000).toISOString();
  const base = { sessionId: id, cwd: project, isSidechain: false };
  const lines = [
    { ...base, type: "user", timestamp: t(0), message: { role: "user", content: "do the thing" } },
    { ...base, type: "assistant", timestamp: t(1), message: { id: `${id}a`, model: "m", content: [{ type: "tool_use", id: `${id}1`, name: "Bash", input: { command: "sleep 60" } }], usage: {} } },
    { ...base, type: "user", timestamp: t(2), message: { content: [{ type: "tool_result", tool_use_id: `${id}1`, is_error: true, content: "<tool_use_error>Blocked: sleep 60 followed by: nothing. To wait for a condition, use Monitor</tool_use_error>" }] } },
    { ...base, type: "assistant", timestamp: t(3), message: { id: `${id}b`, model: "m", content: [{ type: "tool_use", id: `${id}2`, name: "Edit", input: { file_path: "/x.ts" } }], usage: {} } },
    { ...base, type: "user", timestamp: t(4), message: { content: [{ type: "tool_result", tool_use_id: `${id}2`, is_error: true, content: "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>" }] } },
    { ...base, type: "assistant", timestamp: t(5), message: { id: `${id}c`, model: "m", content: [{ type: "tool_use", id: `${id}3`, name: "Bash", input: { command: "psql \"$P_DATABASE_URL\" -c 'select 1'" } }], usage: {} } },
    { ...base, type: "user", timestamp: t(6), message: { content: [{ type: "tool_result", tool_use_id: `${id}3`, is_error: true, content: "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Production Reads]. If you have other tasks…" }] } },
  ];
  return parseClaudeSession(id, lines.map((l) => JSON.stringify(l)).join("\n"), { person: "Ada" });
}

async function setup() {
  const store = new Store(await openSqlite(":memory:"));
  await store.migrate();
  const now = Date.now();
  for (let i = 0; i < 4; i++) await store.saveTrace("local", session(`s${i}`, now - (i + 1) * 3600_000));
  return { store, app: createApp({ store, mode: "local", localPerson: "Ada", contextCommand: '"node" "/x/tracemind/index.js" context' }) };
}

const post = (app: ReturnType<typeof createApp>, path: string, headers: Record<string, string> = {}) =>
  app.request(`http://localhost:4545${path}`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:4545", ...headers }, body: "{}" });

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "tm-sugg-"));
  claudeDir = join(root, ".claude");
  project = join(root, "shop");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(claudeDir, "CLAUDE.md"), "# Mine\n\n- Keep it short.\n");
  writeFileSync(join(project, "AGENTS.md"), "# Shop\n");
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  process.env.TRACEMIND_HOME = join(root, ".tracemind");
});

describe("suggestions", () => {
  it("are made from what keeps going wrong, pointing at the right files", async () => {
    const { app } = await setup();
    const list = await (await app.request("/api/suggestions")).json();
    const titles = list.map((s: any) => s.title);
    expect(titles).toContain("Stop agents from waiting with sleep");
    expect(titles).toContain("Read files before editing them");
    expect(titles).toContain("Keep agents in shop away from production data");
    const sleep = list.find((s: any) => s.title.startsWith("Stop agents"));
    expect(sleep.action).toMatchObject({ type: "rule", scope: "global", file: join(claudeDir, "CLAUDE.md") });
    expect(sleep.sessions).toBe(4);
    const prod = list.find((s: any) => s.title.includes("production"));
    expect(prod.action.file).toBe(join(project, "AGENTS.md"));
    expect(prod.action.text).toContain("`P_DATABASE_URL`");
    expect(list.some((s: any) => s.kind === "routine")).toBe(true);
  });

  it("add a rule after a preview, and undo takes out exactly that", async () => {
    const { app } = await setup();
    const list = await (await app.request("/api/suggestions")).json();
    const sleep = list.find((s: any) => s.title.startsWith("Stop agents"));
    const file = join(claudeDir, "CLAUDE.md");
    const before = readFileSync(file, "utf8");

    const preview = await (await post(app, `/api/suggestions/${sleep.id}/preview`)).json();
    expect(preview.adds).toContain("never use `sleep`");
    expect(readFileSync(file, "utf8")).toBe(before); // a preview changes nothing

    expect((await post(app, `/api/suggestions/${sleep.id}/apply`)).status).toBe(200);
    const after = readFileSync(file, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain(`<!-- tracemind:${sleep.id} -->`);
    expect(existsSync(join(process.env.TRACEMIND_HOME!, "backups"))).toBe(true);

    // Applying twice does not add it twice.
    await post(app, `/api/suggestions/${sleep.id}/apply`);
    expect(readFileSync(file, "utf8")).toBe(after);

    const applied = (await (await app.request("/api/suggestions")).json()).find((s: any) => s.id === sleep.id);
    expect(applied.status).toBe("applied");
    expect(applied.effect.since).toEqual({ sessions: 0, hit: 0 });

    await post(app, `/api/suggestions/${sleep.id}/undo`);
    expect(readFileSync(file, "utf8").trimEnd()).toBe(before.trimEnd());
  });

  it("keep an applied or dismissed fix listed after its issue stops showing up, so it can still be undone", async () => {
    const { store, app } = await setup();
    const list = await (await app.request("/api/suggestions?days=7")).json();
    const rule = list.find((s: any) => s.title.startsWith("Stop agents"));
    const other = list.find((s: any) => s.status === "open" && s.id !== rule.id && s.kind !== "routine");
    await post(app, `/api/suggestions/${rule.id}/apply`);
    await post(app, `/api/suggestions/${other.id}/dismiss`);

    // The issues go away (no session in the window hits them any more).
    await store.db.run("DELETE FROM findings WHERE workspace = ?", ["local"]);
    const later = await (await app.request("/api/suggestions?days=1")).json();
    const kept = later.find((s: any) => s.id === rule.id);
    expect(kept).toMatchObject({ status: "applied", title: rule.title, action: rule.action });
    expect(later.find((s: any) => s.id === other.id)?.status).toBe("dismissed");

    // And it can still be undone from there.
    expect((await post(app, `/api/suggestions/${rule.id}/undo`)).status).toBe(200);
    expect(readFileSync(join(claudeDir, "CLAUDE.md"), "utf8")).not.toContain(`tracemind:${rule.id}`);
    expect((await (await app.request("/api/suggestions?days=1")).json()).find((s: any) => s.id === rule.id)).toBeUndefined();
  });

  it("install the routine as a SessionStart hook, next to the person's own hooks", async () => {
    const { app } = await setup();
    const settings = join(claudeDir, "settings.json");
    writeFileSync(settings, JSON.stringify({ model: "opus", hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }));
    const routine = (await (await app.request("/api/suggestions")).json()).find((s: any) => s.kind === "routine");
    await post(app, `/api/suggestions/${routine.id}/apply`);
    const s = JSON.parse(readFileSync(settings, "utf8"));
    expect(s.model).toBe("opus");
    expect(s.hooks.SessionStart.map((e: any) => e.hooks[0].command)).toEqual(["echo mine", '"node" "/x/tracemind/index.js" context # tracemind-context']);
    expect((await (await app.request("/api/suggestions")).json()).find((x: any) => x.id === routine.id).status).toBe("applied");
    await post(app, `/api/suggestions/${routine.id}/undo`);
    expect(JSON.parse(readFileSync(settings, "utf8")).hooks.SessionStart.map((e: any) => e.hooks[0].command)).toEqual(["echo mine"]);
  });

  it("refuse to change files from anywhere but this page on localhost, or on a server", async () => {
    const { app, store } = await setup();
    const sleep = (await (await app.request("/api/suggestions")).json()).find((s: any) => s.title.startsWith("Stop agents"));
    const file = join(claudeDir, "CLAUDE.md");
    const before = readFileSync(file, "utf8");
    expect((await post(app, `/api/suggestions/${sleep.id}/apply`, { origin: "https://evil.example" })).status).toBe(403);
    const rebound = await app.request(`http://evil.example:4545/api/suggestions/${sleep.id}/apply`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example:4545" },
      body: "{}",
    });
    expect(rebound.status).toBe(403);
    const form = await app.request(`http://localhost:4545/api/suggestions/${sleep.id}/apply`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost:4545" },
      body: "",
    });
    expect(form.status).toBe(403);
    const server = createApp({ store, mode: "server" });
    const token = await store.createToken("local", "Ada", "admin");
    const r = await server.request(`http://localhost/api/suggestions/${sleep.id}/apply`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: "{}" });
    expect(r.status).toBe(400);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("give a new session the problems of its own project", async () => {
    const { store } = await setup();
    const text = await sessionContext(store, "local", project);
    expect(text).toContain("Waited with sleep, which is blocked (4 of the last 4 sessions here)");
    expect(text).toContain("never use `sleep`");
    expect(await sessionContext(store, "local", "/somewhere/else")).toBe("");
  });
});

describe("issue groups", () => {
  it("count distinct sessions per cause and agree with themselves across windows", async () => {
    const { store } = await setup();
    const groups = await issueGroups(store, "local", new Date(Date.now() - 30 * 86400000).toISOString());
    const sleep = groups.find((g) => g.what === "Waited with sleep, which is blocked")!;
    expect(sleep.sessions).toBe(4);
    expect(sleep.daily.reduce((a, b) => a + b, 0)).toBe(4);
    expect(sleep.daily).toHaveLength(31);
  });

  it("know a worktree belongs to its repository and scratch folders to none", () => {
    expect(projectRoot("/Users/a/app/.claude/worktrees/zen-1")).toBe("/Users/a/app");
    expect(projectRoot("/private/tmp/x")).toBeNull();
    expect(projectRoot("/Users/a/Library/Application Support/Claude/scratch-workspaces/1/2")).toBeNull();
  });
});

describe("counts follow one window", () => {
  it("lists each example session once", async () => {
    const { app } = await setup();
    for (const s of await (await app.request("/api/suggestions?days=30")).json()) {
      const ids = s.examples.map((e: { id: string }) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("counts a session's issues in the window, or all time when the session is older than it", async () => {
    const { app, store } = await setup();
    const recent = await (await app.request("/api/sessions/s0?days=30")).json();
    expect(recent.issueWindow).toBe(30);
    expect(Object.values(recent.issues).every((i: any) => i.sessions === 4)).toBe(true);
    // An old session: moved 200 days back.
    const old = await store.trace("local", "s1");
    const t = new Date(Date.now() - 200 * 86400000).toISOString();
    await store.saveTrace("local", { ...old!, session: { ...old!.session, id: "old", startedAt: t, endedAt: t } });
    const o = await (await app.request("/api/sessions/old?days=30")).json();
    expect(o.issueWindow).toBeNull();
    expect(Object.values(o.issues).every((i: any) => i.sessions === 5)).toBe(true);
  });
});

describe("one cause, one count", () => {
  it("gives the same number on the Issues list, the cause page and its history", async () => {
    const { app } = await setup();
    const groups = await (await app.request("/api/issue-groups?days=30")).json();
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      const d = await (await app.request(`/api/cause/${encodeURIComponent(g.issues[0].key)}?days=30`)).json();
      expect(d.cause.sessions).toBe(g.sessions);
      expect(d.history.reduce((n: number, x: { sessions: number }) => n + x.sessions, 0)).toBe(g.sessions);
      expect(d.cause.firstSeen <= d.sessions[d.sessions.length - 1].startedAt).toBe(true);
    }
  });

  it("shows a session's issues with their cause's count and name", async () => {
    const { app } = await setup();
    const t = await (await app.request("/api/sessions/s0?days=30")).json();
    const groups = await (await app.request("/api/issue-groups?days=30")).json();
    for (const ref of Object.values(t.issues) as any[]) {
      const g = groups.find((x: any) => x.id === ref.cause);
      expect(ref.sessions).toBe(g.sessions);
      expect(ref.what).toBe(g.what);
    }
  });

  it("marks a cause that has a fix ready", async () => {
    const { app } = await setup();
    const groups = await (await app.request("/api/issue-groups?days=30")).json();
    expect(groups.find((g: any) => g.what === "Waited with sleep, which is blocked").fix).toBe("ready");
  });
});
