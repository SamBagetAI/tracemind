import { PGlite } from "@electric-sql/pglite";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installHooks, removeHooks } from "../src/cli/claude.ts";
import { parseClaudeSession } from "../src/core/parse-claude.ts";
import { createApp } from "../src/server/app.ts";
import { fromPgQueryable, openSqlite } from "../src/store/db.ts";
import { Store } from "../src/store/store.ts";
import { mainTranscript } from "./fixtures/session.ts";

const trace = () => parseClaudeSession("sess-1", mainTranscript(), { person: "Laptop name" });

/** A built UI stand-in: an index page and one asset. */
function webRoot() {
  const dir = mkdtempSync(join(tmpdir(), "tm-web-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><div id=root></div>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app-1.js"), "console.log(1)");
  return dir;
}

async function localApp() {
  const store = new Store(await openSqlite(join(mkdtempSync(join(tmpdir(), "tm-")), "t.db")));
  await store.migrate();
  await store.saveTrace("local", trace());
  return { store, app: createApp({ store, mode: "local", localPerson: "Ada", webRoot: webRoot() }) };
}

async function serverApp() {
  const store = new Store(fromPgQueryable(new PGlite() as any));
  await store.migrate();
  return { store, app: createApp({ store, mode: "server", setupSecret: "s3t", webRoot: webRoot() }) };
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

describe("the local app", () => {
  it("answers only to a localhost name, so a rebound domain can't read or change anything", async () => {
    const { app } = await localApp();
    for (const host of ["http://localhost:4545", "http://127.0.0.1:4545", "http://[::1]:4545"]) {
      expect((await app.request(`${host}/api/overview`)).status).toBe(200);
    }
    expect((await app.request("http://evil.example:4545/api/overview")).status).toBe(403);
    expect((await app.request("http://evil.example:4545/api/sessions")).status).toBe(403);
    expect((await app.request("http://evil.example:4545/mcp", json({}, { accept: "application/json, text/event-stream" }))).status).toBe(403);
    const dismiss = await app.request("http://evil.example:4545/api/cause/x/status", json({ status: "resolved" }, { origin: "http://evil.example:4545" }));
    expect(dismiss.status).toBe(403);
  });
});

describe("numbers the pages show", () => {
  it("counts the window the same way everywhere and says how it compares with the period before", async () => {
    const { app } = await localApp();
    const o = await (await app.request("/api/overview?days=3650")).json();
    const list = await (await app.request("/api/sessions?days=3650&limit=2000")).json();
    expect(o.sessions).toBe(list.length);
    expect(o.withIssues).toBe(list.filter((x: { issueCount: number }) => x.issueCount > 0).length);
    const groups = await (await app.request("/api/issue-groups?days=3650")).json();
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      expect(g.previous).toBe(0);
      expect(["ready", "applied", null]).toContain(g.fix);
    }
    const t = await (await app.request("/api/sessions/sess-1?days=3650")).json();
    for (const ref of Object.values(t.issues) as { fix: unknown }[]) expect(["ready", "applied", null]).toContain(ref.fix);
  });

  it("gives the Diary its totals, the period before, and each session's issues", async () => {
    const { app } = await localApp();
    const o = await (await app.request("/api/overview?days=3650")).json();
    expect(o.activeMs).toBeGreaterThan(0);
    expect(o.previous.sessions).toBe(0);
    const [s] = await (await app.request("/api/sessions?days=3650&issues=1")).json();
    expect(s.activeMs).toBe(o.activeMs);
    expect(s.issues.length).toBe(4);
    expect(s.issues[0]).toMatchObject({ what: expect.any(String), seq: expect.any(Number), key: expect.any(String) });
    expect(s.issues.map((i: { seq: number }) => i.seq)).toEqual([...s.issues.map((i: { seq: number }) => i.seq)].sort((a: number, b: number) => a - b));
  });

  it("shows an issue's latest command and its messages as written", async () => {
    const { app } = await localApp();
    const groups = await (await app.request("/api/issue-groups?days=3650")).json();
    const d = await (await app.request(`/api/cause/${encodeURIComponent(groups[0].issues[0].key)}?days=3650`)).json();
    expect(d.exampleStep).toMatchObject({ name: expect.any(String), input: expect.any(String) });
    const msgs = Object.values(d.messages) as string[];
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.every((m) => m.length > 0 && !m.includes("tool_use_error"))).toBe(true);
  });

  it("drops sessions outside the window from the list", async () => {
    const { app } = await localApp();
    const far = await (await app.request("/api/sessions?days=1")).json();
    const all = await (await app.request("/api/sessions")).json();
    expect(all.length).toBe(1);
    expect(far.length).toBe(Date.now() - Date.parse("2026-11-20T10:00:00Z") < 86400000 ? 1 : 0);
  });

  it("adds the Tools rows up to the Overview's totals, over the same sessions", async () => {
    const { app } = await localApp();
    const o = await (await app.request("/api/overview?days=3650")).json();
    const tools = await (await app.request("/api/tools?days=3650")).json();
    expect(tools.reduce((n: number, t: { calls: number }) => n + t.calls, 0)).toBe(o.toolCalls);
    expect(tools.reduce((n: number, t: { errors: number }) => n + t.errors, 0)).toBe(o.toolErrors);
    for (const t of tools) expect(t.sessions).toBeLessThanOrEqual(o.sessions);
    const list = await (await app.request("/api/sessions?days=3650&limit=2000")).json();
    expect(list.reduce((n: number, x: { toolErrors: number }) => n + x.toolErrors, 0)).toBe(o.toolErrors);
  });

  it("reports tool run times as median and slow, not average and max", async () => {
    const { app } = await localApp();
    const tools = await (await app.request("/api/tools?days=3650")).json();
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t).toHaveProperty("typicalMs");
      expect(t).toHaveProperty("timed");
      expect(t).not.toHaveProperty("avgMs");
      if (t.timed < 5) expect(t.slowMs).toBeNull();
    }
  });
});

describe("local mode", () => {
  it("serves every API the pages use without signing in", async () => {
    const { app } = await localApp();
    for (const path of ["/api/me", "/api/overview", "/api/sessions", "/api/sessions?marks=1", "/api/sessions/sess-1", "/api/issue-groups", "/api/tools", "/api/memory", "/api/suggestions"]) {
      expect((await app.request(path)).status, path).toBe(200);
    }
    expect((await app.request("/api/sessions/nope")).status).toBe(404);
    expect((await app.request("/api/nothing-here")).status).toBe(404);
  });

  it("gives a session page what it needs: issue numbers, counts across sessions, issue counts per session", async () => {
    const { app } = await localApp();
    const t = await (await app.request("/api/sessions/sess-1")).json();
    const refs = Object.values(t.issues) as { num: number; sessions: number; status: string }[];
    expect(refs).toHaveLength(4);
    expect(refs.map((r) => r.num).sort()).toEqual([1, 2, 3, 4]);
    expect(refs.every((r) => r.sessions === 1 && r.status === "open")).toBe(true);
    expect(t.nav).toMatchObject({ newer: null, older: null, index: 0, total: 1 });
    const [s] = await (await app.request("/api/sessions")).json();
    expect(s.issueCount).toBe(4);
    const o = await (await app.request("/api/overview?days=36500")).json();
    expect(o.strip).toBeUndefined();
    expect(o.replies).toBe(1); // the session starts with the person's prompt
    const groups = await (await app.request("/api/issue-groups?days=365")).json();
    expect(groups.reduce((n: number, g: { issues: unknown[] }) => n + g.issues.length, 0)).toBe(4);
  });

  it("serves the UI for pages, files from assets, and nothing outside it", async () => {
    const { app } = await localApp();
    for (const page of ["/", "/sessions/sess-1", "/issues/tool_error%3AEdit%3Afile%20has%20not%20been%20read%20yet.%20read%20it", "/memory"]) {
      const res = await app.request(page);
      expect(res.status, page).toBe(200);
      expect(await res.text()).toContain('<div id=root>');
    }
    const asset = await app.request("/assets/app-1.js");
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect((await app.request("/assets/missing.js")).status).toBe(404);
    expect(await (await app.request("/assets/..%2f..%2fetc%2fpasswd")).text()).not.toContain("root:");
  });

  it("resolves and reopens an issue, and refuses it from another site", async () => {
    const { app, store } = await localApp();
    const [issue] = await store.issues("local");
    const path = `http://localhost/api/cause/${encodeURIComponent(issue.key)}/status`;
    const evil = await app.request(path, json({ status: "resolved" }, { origin: "https://evil.example" }));
    expect(evil.status).toBe(403);
    const ok = await app.request(path, json({ status: "resolved", note: "fixed it" }, { origin: "http://localhost" }));
    expect(await ok.json()).toEqual({ ok: true });
    expect(await store.issue("local", issue.key)).toMatchObject({ status: "resolved", resolvedBy: "Ada", note: "fixed it" });
    await app.request(path, json({ status: "open" }, { origin: "http://localhost" }));
    expect((await store.issue("local", issue.key))!.status).toBe("open");
    expect((await app.request("http://localhost/api/cause/nope/status", json({ status: "resolved" }, { origin: "http://localhost" }))).status).toBe(404);
  });
});

describe("server mode", () => {
  it("accepts a setup secret that was saved with a trailing newline", async () => {
    const store = new Store(fromPgQueryable(new PGlite() as any));
    await store.migrate();
    const app = createApp({ store, mode: "server", setupSecret: "s3t\n" });
    expect((await app.request("/api/setup", json({ workspace: "acme", person: "Ada" }, { "x-setup-secret": "s3t" }))).status).toBe(200);
  });


  it("sets up once, then needs a token", async () => {
    const { app } = await serverApp();
    expect((await app.request("/api/setup", json({ workspace: "acme", person: "Ada" }, { "x-setup-secret": "wrong" }))).status).toBe(403);
    const ok = await app.request("/api/setup", json({ workspace: "acme", person: "Ada" }, { "x-setup-secret": "s3t" }));
    expect(ok.status).toBe(200);
    const { token } = await ok.json();
    expect((await app.request("/api/setup", json({ workspace: "x", person: "Eve" }, { "x-setup-secret": "s3t" }))).status).toBe(409);

    expect((await app.request("/api/sessions")).status).toBe(401);
    const me = await app.request("/api/me", { headers: { authorization: `Bearer ${token}` } });
    expect(await me.json()).toMatchObject({ workspace: "acme", person: "Ada", role: "admin" });
  });

  it("files a pushed trace under the token's owner and workspace", async () => {
    const { app, store } = await serverApp();
    const admin = await store.createToken("acme", "Ada", "admin");
    const r = await app.request("/api/tokens", json({ person: "Grace" }, { authorization: `Bearer ${admin}` }));
    const { token: grace } = await r.json();

    const res = await app.request("/api/ingest", json(trace(), { authorization: `Bearer ${grace}` }));
    expect(res.status).toBe(200);
    const [s] = await store.sessions("acme");
    expect(s.person).toBe("Grace");

    expect((await app.request("/api/tokens", json({ person: "Eve" }, { authorization: `Bearer ${grace}` }))).status).toBe(403);
    const other = await store.createToken("globex", "Eve", "admin");
    const list = await app.request("/api/sessions", { headers: { authorization: `Bearer ${other}` } });
    expect(await list.json()).toEqual([]);
  });

  it("refuses a malformed trace", async () => {
    const { app, store } = await serverApp();
    const token = await store.createToken("acme", "Ada", "member");
    const res = await app.request("/api/ingest", json({ session: { id: "x" } }, { authorization: `Bearer ${token}` }));
    expect(res.status).toBe(400);
  });

  it("signs in with a token cookie", async () => {
    const { app, store } = await serverApp();
    const token = await store.createToken("acme", "Ada", "member");
    const form = (body: string) => ({ method: "POST", headers: { origin: "http://h", "content-type": "application/x-www-form-urlencoded" }, body });
    const bad = await app.request("http://h/api/login", form("token=tm_bad"));
    expect(bad.headers.get("location")).toBe("/login?error=1");
    const good = await app.request("http://h/api/login", form(`token=${token}`));
    expect(good.status).toBe(302);
    const cookie = good.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    const me = await app.request("http://h/api/me", { headers: { cookie: cookie.split(";")[0] } });
    expect(await me.json()).toMatchObject({ workspace: "acme", person: "Ada" });
    // The page itself loads for anyone; the API behind it is what needs the token.
    expect((await app.request("http://h/")).status).toBe(200);
  });
});

describe("Claude Code hooks", () => {
  it("adds its hooks next to existing ones, once, and removes only its own", () => {
    const dir = mkdtempSync(join(tmpdir(), "tm-"));
    const file = join(dir, ".claude", "settings.json");
    installHooks('"node" "/x/tracemind/index.js" hook', "project", dir);
    const other = { hooks: [{ type: "command", command: "echo other" }] };
    const s = JSON.parse(readFileSync(file, "utf8"));
    s.hooks.Stop.unshift(other);
    s.model = "opus";
    writeFileSync(file, JSON.stringify(s));

    installHooks('"node" "/x/tracemind/index.js" hook', "project", dir);
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.model).toBe("opus");
    expect(after.hooks.Stop).toHaveLength(2);
    expect(after.hooks.SessionEnd).toHaveLength(1);

    removeHooks("project", dir);
    const removed = JSON.parse(readFileSync(file, "utf8"));
    expect(removed.hooks.Stop).toEqual([other]);
    expect(removed.hooks.SessionEnd).toBeUndefined();
  });
});
