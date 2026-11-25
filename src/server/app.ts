/**
 * The JSON API and the web UI. The same code runs on a laptop (mode "local": one person, no
 * sign-in, bound to 127.0.0.1) and on a server (mode "server": tokens, workspaces, sign-in).
 * The UI is a React app built into `webRoot`; every path that is not an API call or a file gets
 * its index.html.
 */
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { InvalidTrace, validateTrace } from "../core/validate.ts";
import { daysAgo } from "../core/time.ts";
import { causeCounts, causeDetail, causeKeys, failureMarks, issueGroupsWithPrevious, sessionIssues } from "../store/insights.ts";
import type { SessionKind, Store } from "../store/store.ts";
import { apply, buildSuggestions, copyOf, effect, preview, sessionContext, setState, undo } from "./suggestions.ts";

export type Viewer = { workspace: string; person: string; role: "admin" | "member"; mode: "local" | "server" };

export type AppOptions = {
  store: Store;
  mode: "local" | "server";
  /** Local mode: who the one person is. */
  localPerson?: string;
  /** Server mode: lets `tracemind cloud setup` create the first admin token while there is none. */
  setupSecret?: string;
  /** Folder holding the built web UI (dist/web). Without it only the API is served. */
  webRoot?: string;
  /** Local mode: the command a SessionStart hook runs to give new sessions their project's problems. */
  contextCommand?: string;
};

type Env = { Variables: { viewer: Viewer } };

const COOKIE = "tm_token";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json",
};

function bearer(c: Context): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
  return m ? m[1] : null;
}

/** Requests that change something must come from this site, unless they carry a bearer token. */
function sameOrigin(c: Context): boolean {
  if (bearer(c)) return true;
  const origin = c.req.header("origin");
  if (!origin) return c.req.header("sec-fetch-site") !== "cross-site";
  try {
    return new URL(origin).host === new URL(c.req.url).host;
  } catch {
    return false;
  }
}

/** The URL's host comes from the request's Host header: a page on another name that resolves to
 *  this machine (DNS rebinding) does not get a local name here. */
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1"];
const localHost = (c: Context) => LOCAL_HOSTS.includes(new URL(c.req.url).hostname);

/** Changing files on this machine: only from the local app, asked for by this page on localhost. */
function localWrite(c: Context, mode: "local" | "server"): string | null {
  if (mode !== "local") return "Applying suggestions works in the local app (tracemind ui), not on a shared server.";
  if (!localHost(c)) return "forbidden";
  if (!sameOrigin(c) || !(c.req.header("content-type") ?? "").includes("application/json")) return "forbidden";
  return null;
}

/** The window a request asks for, in days (1–365, 30 by default), and where it starts. */
const windowDays = (c: Context) => Math.min(365, Math.max(1, Number(c.req.query("days")) || 30));
const since = (days: number) => daysAgo(days);
/** A window of `days` days and the period of the same length just before it. */
const windowOf = (days: number) => {
  const from = since(days);
  return { from, before: daysAgo(days, Date.parse(from)) };
};
/** The `kind` a request asks for (a person's sessions or routine runs), or both. */
const kindOf = (c: Context): SessionKind | undefined => {
  const k = c.req.query("kind");
  return k === "sessions" || k === "routines" ? k : undefined;
};
/** The issue `status` a request asks for, or both. */
const statusOf = (c: Context): "open" | "resolved" | undefined => {
  const s = c.req.query("status");
  return s === "open" || s === "resolved" ? s : undefined;
};

export function createApp(opts: AppOptions) {
  const { store, mode } = opts;
  const contextCommand = opts.contextCommand ?? "tracemind context";
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    await next();
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "same-origin");
    c.header("x-frame-options", "DENY");
  });

  // The local app has no sign-in: it answers only to a localhost name, so a web page that re-points
  // its own domain at this machine (DNS rebinding) can't read sessions or change anything.
  if (mode === "local") {
    app.use("*", async (c, next) => (localHost(c) ? next() : c.text("Forbidden", 403)));
  }

  app.get("/healthz", (c) => c.json({ ok: true }));

  // ---- first admin token, once ----
  app.post("/api/setup", async (c) => {
    if (mode !== "server" || !opts.setupSecret) return c.json({ error: "setup is off" }, 404);
    if (c.req.header("x-setup-secret") !== opts.setupSecret) return c.json({ error: "wrong setup secret" }, 403);
    if ((await store.tokenCount()) > 0) return c.json({ error: "this server is already set up" }, 409);
    const body = await c.req.json().catch(() => ({}));
    const workspace = String(body.workspace ?? "").trim();
    const person = String(body.person ?? "").trim();
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(workspace)) return c.json({ error: "workspace: lowercase letters, digits and dashes" }, 400);
    if (!person || person.length > 120) return c.json({ error: "person is required" }, 400);
    const token = await store.createToken(workspace, person, "admin");
    return c.json({ token, workspace, person, role: "admin" });
  });

  const identify = async (c: Context<Env>): Promise<Viewer | null> => {
    if (mode === "local") return { workspace: "local", person: opts.localPerson ?? "me", role: "admin", mode };
    const token = bearer(c) ?? getCookie(c, COOKIE) ?? null;
    if (!token) return null;
    const owner = await store.tokenOwner(token);
    return owner ? { ...owner, mode } : null;
  };

  // ---- sign-in (server mode); the form is on the UI page /login, and posts here ----
  app.post("/api/login", async (c) => {
    if (mode === "local") return c.redirect("/");
    if (!sameOrigin(c)) return c.text("Forbidden", 403);
    const form = await c.req.parseBody();
    const token = String(form.token ?? "").trim();
    const owner = token ? await store.tokenOwner(token) : null;
    if (!owner) return c.redirect("/login?error=1", 302);
    setCookie(c, COOKIE, token, {
      httpOnly: true,
      secure: new URL(c.req.url).protocol === "https:",
      sameSite: "Lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return c.redirect("/");
  });
  app.post("/api/logout", (c) => {
    if (!sameOrigin(c)) return c.text("Forbidden", 403);
    deleteCookie(c, COOKIE, { path: "/" });
    return c.redirect("/login");
  });

  // ---- API ----
  const api = new Hono<Env>();
  api.use("*", async (c, next) => {
    const v = await identify(c);
    if (!v) return c.json({ error: "a valid token is required" }, 401);
    c.set("viewer", v);
    await next();
  });

  /**
   * Suggestions per workspace and window, kept for 15 seconds: one page load reads them from up to
   * four endpoints (the fix marks, a cause, a session, the list). Any write through the API clears
   * them; a session the hook imports straight into the database shows up within the 15 seconds.
   */
  const cache = new Map<string, { at: number; list: ReturnType<typeof buildSuggestions> }>();
  const suggestionsFor = (ws: string, days: number) => {
    const k = `${ws}|${days}`;
    const hit = cache.get(k);
    if (hit && Date.now() - hit.at < 15_000) return hit.list;
    const list = buildSuggestions(store, ws, mode === "local", days);
    cache.set(k, { at: Date.now(), list });
    list.catch(() => cache.delete(k));
    return list;
  };
  api.use("*", async (c, next) => {
    if (c.req.method === "GET") return next();
    cache.clear();
    await next();
    cache.clear();
  });

  api.post("/ingest", bodyLimit({ maxSize: 8 * 1024 * 1024, onError: (c) => c.json({ error: "trace too large" }, 413) }), async (c) => {
    const v = c.get("viewer");
    let trace;
    try {
      trace = validateTrace(await c.req.json());
    } catch (e) {
      if (e instanceof InvalidTrace || e instanceof SyntaxError) return c.json({ error: (e as Error).message }, 400);
      throw e;
    }
    // On a server the person is whoever owns the token, never what the client said.
    await store.saveTrace(v.workspace, trace, { person: mode === "server" ? v.person : trace.session.person });
    return c.json({ ok: true, id: trace.session.id, findings: trace.findings.length });
  });

  api.get("/me", (c) => c.json(c.get("viewer")));

  api.get("/overview", async (c) => {
    const v = c.get("viewer");
    // The period of the same length just before, for "1 of 2 the week before".
    const { from, before } = windowOf(windowDays(c));
    const kind = kindOf(c);
    const [now, previous] = await Promise.all([store.overview(v.workspace, from, kind), store.totals(v.workspace, before, from, kind)]);
    return c.json({ since: from, ...now, previous });
  });

  api.get("/sessions", async (c) => {
    const q = c.req.query();
    const limit = Math.min(2000, Number(q.limit) || 50);
    const offset = Math.max(0, Number(q.offset) || 0);
    const ws = c.get("viewer").workspace;
    const list = await store.sessions(ws, { outcome: q.outcome, project: q.project, person: q.person, q: q.q, since: q.days ? since(windowDays(c)) : undefined, kind: kindOf(c), limit, offset });
    const [marks, issues] = await Promise.all([
      q.marks === "1" ? failureMarks(store, ws, list) : null,
      q.issues === "1" ? sessionIssues(store, ws, list.map((s) => s.id)) : null,
    ]);
    return c.json(list.map((s) => ({ ...s, ...(marks ? { marks: marks[s.id] ?? [] } : {}), ...(issues ? { issues: issues[s.id] ?? [] } : {}) })));
  });

  api.get("/sessions/:id", async (c) => {
    const ws = c.get("viewer").workspace;
    const from = since(windowDays(c));
    const [t, nav] = await Promise.all([store.trace(ws, c.req.param("id")), store.neighbours(ws, c.req.param("id"), from)]);
    if (!t) return c.json({ error: "not found" }, 404);
    // Each issue's session count over the same window as the rest of the app.
    const keys = Object.keys(t.issues);
    // Counts are per cause (all variants), the same numbers the Issues list shows. A session older
    // than the window keeps all-time counts: "0 sessions in 30 days" would be wrong for an issue
    // this very session hit.
    const inWindow = !!c.req.query("days") && t.session.startedAt >= from;
    const [counts, fx] = await Promise.all([keys.length ? causeCounts(store, ws, inWindow ? from : "0000") : new Map<string, never>(), keys.length ? fixes(ws, windowDays(c)) : new Map<string, { fix: "ready" | "applied"; at: string | null }>()]);
    for (const k of keys) {
      const cc = counts.get(k);
      const f = cc ? fx.get(cc.cause) : undefined;
      const fix = f?.fix ?? null;
      const fixAt = f?.at ?? null;
      t.issues[k] = { ...t.issues[k], sessions: cc?.sessions ?? t.issues[k].sessions, cause: cc?.cause, what: cc?.what, fix, fixAt } as typeof t.issues[string];
    }
    return c.json({ ...t, nav, issueWindow: inWindow ? Number(c.req.query("days")) : null });
  });

  /**
   * For each cause: whether a fix exists for it and whether it was applied (and when). Only changes
   * Tracemind can make count as fixes; an investigation is a prompt, not a fix.
   */
  const fixes = async (ws: string, days: number) => {
    const out = new Map<string, { fix: "ready" | "applied"; at: string | null }>();
    for (const sg of await suggestionsFor(ws, days)) {
      if (sg.status === "dismissed" || !sg.fixable) continue;
      for (const cid of sg.causes) {
        if (out.get(cid)?.fix === "applied") continue;
        out.set(cid, sg.status === "applied" ? { fix: "applied", at: sg.at } : { fix: "ready", at: null });
      }
    }
    return out;
  };

  api.get("/issue-groups", async (c) => {
    const ws = c.get("viewer").workspace;
    const s = statusOf(c);
    const days = windowDays(c);
    const { from, before } = windowOf(days);
    const [[groups, previous], fix] = await Promise.all([issueGroupsWithPrevious(store, ws, from, before), fixes(ws, days)]);
    const prev = new Map(previous.map((g) => [g.id, g.sessions]));
    const shown = s ? groups.filter((g) => g.status === s) : groups;
    return c.json(shown.map((g) => ({ ...g, previous: prev.get(g.id) ?? 0, fix: fix.get(g.id)?.fix ?? null, fixAt: fix.get(g.id)?.at ?? null })));
  });

  api.get("/cause/:key", async (c) => {
    const ws = c.get("viewer").workspace;
    const d = await causeDetail(store, ws, c.req.param("key"), since(windowDays(c)));
    if (!d) return c.json({ error: "not found" }, 404);
    // The same window as the Suggestions page and the Fix column, so they always agree.
    let suggestion =
      (await suggestionsFor(ws, windowDays(c))).filter((sg) => sg.causes.includes(d.cause.id) && sg.status !== "dismissed")
        // A change made for this cause first; the session-start brief, which covers several, after.
        .sort((a, b) => Number(a.kind === "routine") - Number(b.kind === "routine"))[0] ?? null;
    // Before and since for this issue alone: a fix covering several issues counts them together.
    if (suggestion?.status === "applied" && suggestion.at) suggestion = { ...suggestion, effect: await effect(store, ws, [d.cause.id], suggestion.at), effectScope: "issue" } as typeof suggestion;
    return c.json({ ...d, suggestion });
  });

  api.post("/cause/:key/status", async (c) => {
    if (!sameOrigin(c)) return c.json({ error: "forbidden" }, 403);
    const v = c.get("viewer");
    // Every variant of the cause the key belongs to.
    const key = c.req.param("key");
    const keys = [...(await causeKeys(store, v.workspace)).values()].find((ks) => ks.includes(key));
    if (!keys) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const status = body.status === "resolved" ? "resolved" : "open";
    for (const k of keys) await store.setIssueStatus(v.workspace, k, status, v.person, String(body.note ?? ""));
    return c.json({ ok: true });
  });

  api.get("/tools", async (c) => {
    return c.json(await store.tools(c.get("viewer").workspace, since(windowDays(c)), kindOf(c)));
  });
  api.get("/memory", async (c) => c.json(await store.memory(c.get("viewer").workspace, since(windowDays(c)))));

  api.get("/suggestions", async (c) => c.json(await suggestionsFor(c.get("viewer").workspace, windowDays(c))));

  // A suggestion's id does not depend on the window, but which suggestions exist does: a fix for an
  // issue that is frequent this month may not make the year's list. So every window the UI offers is
  // searched, the widest first.
  const findSuggestion = async (c: Context<Env>) => {
    for (const days of [365, 90, 30, 7]) {
      const s = (await suggestionsFor(c.get("viewer").workspace, days)).find((x) => x.id === c.req.param("id"));
      if (s) return s;
    }
    return null;
  };

  api.post("/suggestions/:id/preview", async (c) => {
    const s = await findSuggestion(c);
    if (!s) return c.json({ error: "not found" }, 404);
    const p = preview(s, contextCommand);
    if (s.action.type === "routine") {
      // What a new session would be told, for the most recently used project that has something to say.
      const recent = await store.sessions(c.get("viewer").workspace, { limit: 40 });
      for (const project of [...new Set(recent.map((r) => r.project))]) {
        const text = await sessionContext(store, c.get("viewer").workspace, project);
        if (text) return c.json({ ...p, sample: text, sampleProject: project });
      }
    }
    return c.json(p);
  });

  api.post("/suggestions/:id/:verb", async (c) => {
    const verb = c.req.param("verb");
    if (!["apply", "undo", "dismiss", "restore"].includes(verb)) return c.json({ error: "not found" }, 404);
    const v = c.get("viewer");
    const s = await findSuggestion(c);
    if (!s) return c.json({ error: "not found" }, 404);
    if (verb === "dismiss" || verb === "restore") {
      if (!sameOrigin(c)) return c.json({ error: "forbidden" }, 403);
      await setState(store, v.workspace, s.id, verb === "dismiss" ? "dismissed" : "open", verb === "dismiss" ? { fix: copyOf(s) } : {});
      return c.json({ ok: true });
    }
    const refused = localWrite(c, mode);
    if (refused) return c.json({ error: refused }, refused === "forbidden" ? 403 : 400);
    try {
      if (verb === "apply") return c.json({ ok: true, file: await apply(store, v.workspace, s, contextCommand) });
      await undo(store, v.workspace, s);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  api.post("/tokens", async (c) => {
    const v = c.get("viewer");
    if (mode !== "server" || v.role !== "admin") return c.json({ error: "only an admin can create tokens" }, 403);
    const body = await c.req.json().catch(() => ({}));
    const person = String(body.person ?? "").trim();
    const role = body.role === "admin" ? "admin" : "member";
    if (!person || person.length > 120) return c.json({ error: "person is required" }, 400);
    return c.json({ token: await store.createToken(v.workspace, person, role), workspace: v.workspace, person, role });
  });

  api.all("*", (c) => c.json({ error: "not found" }, 404));
  app.route("/api", api);

  // ---- MCP: the same API for agents, over HTTP on a shared server (a laptop uses `tracemind mcp`) ----
  // Stateless: each request gets its own server, which calls the API with the caller's own token.
  app.all("/mcp", async (c) => {
    if (mode === "server" && !bearer(c)) return c.json({ error: "a valid token is required (Authorization: Bearer …)" }, 401);
    const auth: Record<string, string> = bearer(c) ? { authorization: `Bearer ${bearer(c)}` } : {};
    const { createMcpServer } = await import("../mcp/server.ts");
    const { apiCaller } = await import("../mcp/call.ts");
    const { WebStandardStreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");
    const server = createMcpServer(apiCaller(app, auth), { canApply: false });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  // ---- the web UI ----
  if (opts.webRoot) {
    const root = normalize(opts.webRoot);
    let index: string | null = null;
    app.get("*", async (c) => {
      const path = decodeURIComponent(new URL(c.req.url).pathname);
      const file = normalize(join(root, path));
      // Only real built files: an issue key or session id can contain a dot and is a page, not a file.
      const isFile = /^\/(?:assets\/)?[\w.-]+\.[a-z0-9]{1,6}$/i.test(path);
      if (isFile && file.startsWith(root + sep) && extname(file)) {
        try {
          const body = await readFile(file);
          const immutable = path.startsWith("/assets/");
          return c.body(body, 200, {
            "content-type": TYPES[extname(file)] ?? "application/octet-stream",
            "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
          });
        } catch {
          return c.text("Not found", 404);
        }
      }
      index ??= await readFile(join(root, "index.html"), "utf8");
      return c.html(index, 200, { "cache-control": "no-cache" });
    });
  }

  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "server error" }, 500);
  });
  return app;
}
