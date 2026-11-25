/**
 * Tracemind as an MCP server: the same numbers as the web UI, for an agent to read and act on.
 *
 * Every tool calls Tracemind's own JSON API (src/server/app.ts) in-process, so an agent sees exactly
 * what the pages show (one window, one count model) and goes through the same checks: fixes are
 * applied only by the local app, and a shared server answers only to a valid token.
 *
 * Runs over stdio on a laptop (`tracemind mcp`) and over HTTP at /mcp on a shared server.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { describeIssue, findingsByCause, startFiles } from "../core/describe.ts";
import { isToolStep } from "../core/issues.ts";
import { parseRoutineRuns, routineSessionOf } from "../core/parse-routine.ts";
import type { Finding, MemoryEvent, Session, Step } from "../core/types.ts";
import type { Suggestion } from "../server/suggestions.ts";
import type { IssueGroup } from "../store/insights.ts";

/** Calls the API: a path under /api, and a JSON body for a POST. Throws the API's error message. */
export type ApiCall = (path: string, body?: unknown) => Promise<any>;

const VERSION = "0.1.0";
const days = z.number().int().min(1).max(365).default(30).describe("The window in days, 1 to 365 (default 30), as in the web UI's window picker.");

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 1) }] });
const clip = (s: string | null | undefined, n: number) => (!s ? "" : s.length > n ? `${s.slice(0, n)}…` : s);

/** An issue group as GET /issue-groups returns it (src/server/app.ts). */
type Group = IssueGroup & { previous?: number; fix?: "ready" | "applied" | null; fixAt?: string | null };

/** An issue as an agent needs it: its name, how often, the trend, whether a fix exists, and the key to ask about it. */
function issueRow(g: Group) {
  return {
    issue: g.plain ? g.what : `Unnamed: ${clip(g.raw, 120)}`,
    key: g.issues[0].key,
    kind: g.kindLabel,
    tools: g.tools,
    sessions: g.sessions,
    sessionsBefore: g.previous ?? null,
    fix: g.fix ?? null,
    status: g.reopened ? "back after it was resolved" : g.status,
    lastSeen: g.lastSeen,
  };
}

function fixRow(s: Suggestion) {
  const a = s.action;
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    why: s.why,
    sessionsAffected: s.sessions,
    issues: s.causes,
    change:
      a.type === "rule" ? { type: "a line in an instruction file", file: a.file, line: a.text }
      : a.type === "routine" ? { type: "a SessionStart hook in ~/.claude/settings.json that briefs new sessions on their project's known issues" }
      : a.type === "prompt" ? { type: "a prompt to run", prompt: a.text }
      : { type: s.kind },
    canApply: s.fixable,
    ...(s.status === "applied" ? { appliedAt: s.at, effect: s.effect, ...(s.checks ? { briefSinceInstalled: s.checks } : {}) } : {}),
  };
}

/** Finds an issue by its key, or by its name ("Refused by the auto-mode classifier"), in the window. */
async function issueKey(call: ApiCall, issue: string, window: number): Promise<string> {
  if (issue.includes(":")) return issue;
  const groups: Group[] = await call(`/issue-groups?days=${window}&status=all`);
  const want = issue.trim().toLowerCase();
  const g = groups.find((x) => x.what.toLowerCase() === want) ?? groups.find((x) => x.what.toLowerCase().includes(want));
  if (!g) throw new Error(`No issue named "${issue}" in the last ${window} days. list_issues shows the names and keys.`);
  return g.issues[0].key;
}

export function createMcpServer(call: ApiCall, opts: { canApply: boolean }): McpServer {
  const server = new McpServer(
    { name: "tracemind", version: VERSION },
    {
      instructions:
        "Tracemind records Claude Code sessions and groups what went wrong into named issues, with fixes to the person's Claude setup. " +
        "Start with overview or list_issues; get_issue shows one issue's error, sessions and fix; get_session shows a session's failures. " +
        "list_fixes and preview_fix show a fix's exact change. Apply a fix only when the person asked for it, after showing them the preview.",
    },
  );

  server.registerTool(
    "overview",
    {
      title: "Overview",
      description: "How sessions went in the window: sessions, how many ran clean or hit an issue, tool calls and failures, the issues seen most, and the fixes to review.",
      inputSchema: { days },
      annotations: { readOnlyHint: true },
    },
    async ({ days }) => {
      const [o, groups, fixes] = await Promise.all([call(`/overview?days=${days}`), call(`/issue-groups?days=${days}`), call(`/suggestions?days=${days}`)]);
      return text({
        window: `last ${days} days`,
        sessions: o.sessions,
        ranClean: o.sessions - o.withIssues,
        hitAnIssue: o.withIssues,
        toolCalls: o.toolCalls,
        toolCallsFailed: o.toolErrors,
        activeHours: Math.round((o.activeMs / 3600000) * 10) / 10,
        outputTokens: o.outputTokens,
        estimatedCostUsdAtApiPrices: Math.round(o.costUsd * 100) / 100,
        previousPeriod: o.previous,
        topIssues: (groups as Group[]).filter((g) => g.plain && g.sessions > 1).slice(0, 5).map(issueRow),
        fixesToReview: (fixes as Suggestion[]).filter((s) => s.status === "open").sort((a, b) => b.sessions - a.sessions).slice(0, 3).map((s) => ({ id: s.id, title: s.title, sessionsAffected: s.sessions })),
      });
    },
  );

  server.registerTool(
    "list_issues",
    {
      title: "List issues",
      description:
        "Issues in the window, most sessions first: what went wrong, how many sessions hit it (and in the period before), and whether a fix exists. " +
        "By default only issues that hit two or more sessions; errors Tracemind has no name for yet are listed separately.",
      inputSchema: {
        days,
        include_one_offs: z.boolean().default(false).describe("Also list issues that hit one session."),
        status: z.enum(["open", "resolved", "all"]).default("open"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ days, include_one_offs, status }) => {
      const groups: Group[] = await call(`/issue-groups?days=${days}${status === "all" ? "" : `&status=${status}`}`);
      const named = groups.filter((g) => g.plain && (include_one_offs || g.sessions > 1));
      const unnamed = groups.filter((g) => !g.plain);
      return text({ window: `last ${days} days`, issues: named.map(issueRow), unnamedErrors: unnamed.slice(0, 15).map(issueRow), unnamedTotal: unnamed.length });
    },
  );

  server.registerTool(
    "get_issue",
    {
      title: "Get an issue",
      description: "One issue: how often and since when, its latest error in full, what the error said across commands, the sessions that hit it (with the step), and its fix if one exists.",
      inputSchema: {
        issue: z.string().min(1).describe("The issue's key from list_issues, or its name, e.g. \"Refused by the auto-mode classifier\"."),
        days,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ issue, days }) => {
      const key = await issueKey(call, issue, days);
      const d = await call(`/cause/${encodeURIComponent(key)}?days=${days}`);
      const messages = new Map<string, { message: string; commands: number; tools: Set<string> }>();
      for (const i of d.cause.issues as { kind: string; title: string; tool: string }[]) {
        const msg = describeIssue(i as never).raw;
        const e = messages.get(msg) ?? { message: msg, commands: 0, tools: new Set<string>() };
        e.commands++;
        e.tools.add(i.tool);
        messages.set(msg, e);
      }
      return text({
        issue: d.cause.plain ? d.cause.what : "Error without a name yet",
        kind: d.cause.kindLabel,
        status: d.cause.reopened ? "back after it was resolved" : d.cause.status,
        sessionsInWindow: d.cause.sessions,
        sessionsAllTime: d.allTimeSessions,
        firstSeen: d.cause.firstSeen,
        lastSeen: d.cause.lastSeen,
        latestError: clip(d.example, 1500),
        whatItSaid: [...messages.values()].sort((a, b) => b.commands - a.commands).slice(0, 8).map((m) => ({ message: m.message, commands: m.commands, tools: [...m.tools].slice(0, 6) })),
        sessions: (d.sessions as { id: string; title: string; project: string; endedAt: string; seq: number }[]).slice(0, 10).map((s) => ({ id: s.id, title: s.title, project: s.project, lastActive: s.endedAt, step: s.seq })),
        fix: d.suggestion ? fixRow(d.suggestion) : null,
      });
    },
  );

  server.registerTool(
    "list_sessions",
    {
      title: "List sessions",
      description: "Sessions that started in the window, newest first, with their failed tool calls and issue count. Filter by title text, project folder, or only those that hit an issue.",
      inputSchema: {
        days,
        query: z.string().optional().describe("Text in the session title."),
        project: z.string().optional().describe("The project folder, as shown in a session's project."),
        only_with_issues: z.boolean().default(false),
        limit: z.number().int().min(1).max(200).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ days, query, project, only_with_issues, limit }) => {
      const q = new URLSearchParams({ days: String(days), limit: "2000" });
      if (query) q.set("q", query);
      if (project) q.set("project", project);
      const list: (Session & { activeMs: number; costUsd: number; issueCount: number })[] = await call(`/sessions?${q}`);
      const shown = list.filter((s) => !only_with_issues || s.issueCount > 0);
      return text({
        window: `last ${days} days`,
        total: shown.length,
        sessions: shown.slice(0, limit).map((s) => ({ id: s.id, title: s.title, project: s.project, branch: s.gitBranch, person: s.person, started: s.startedAt, lastActive: s.endedAt, toolCalls: s.toolCalls, failedCalls: s.toolErrors, issues: s.issueCount, activeMinutes: Math.round(s.activeMs / 60000), estimatedCostUsd: Math.round(s.costUsd * 100) / 100 })),
      });
    },
  );

  server.registerTool(
    "get_session",
    {
      title: "Get a session",
      description:
        "One session: a one-line diagnosis, the files it loaded at the start, the issues it hit, and each failed step with its full input and error. " +
        "Set all_steps to also get every step (long sessions are cut to the steps around failures).",
      inputSchema: {
        id: z.string().min(1).describe("The session id from list_sessions or get_issue."),
        all_steps: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, all_steps }) => {
      const t = await call(`/sessions/${encodeURIComponent(id)}?days=365`);
      const steps: Step[] = t.steps;
      const findings: Finding[] = t.findings;
      const issues: Record<string, { cause?: string; what?: string; sessions?: number; fix?: string | null } | undefined> = t.issues;
      const failed = steps.filter((s) => isToolStep(s) && s.isError);
      const issueAt = new Map<number, string>();
      for (const f of findings) issueAt.set(f.seq, issues[f.key]?.what ?? f.title);
      const s: Session = t.session;
      const brief = (x: Step) => ({ step: x.seq, kind: x.kind, name: x.name, input: clip(x.input, all_steps ? 300 : 1200), ...(x.isError ? { error: clip(x.output, 1500) } : all_steps ? { output: clip(x.output, 200) } : {}), ...(issueAt.has(x.seq) ? { issue: issueAt.get(x.seq) } : {}) });
      return text({
        id: s.id,
        title: s.title,
        project: s.project,
        branch: s.gitBranch,
        model: s.model,
        started: s.startedAt,
        lastActive: s.endedAt,
        steps: steps.length,
        toolCalls: s.toolCalls,
        failedCalls: failed.length,
        loadedAtStart: startFiles(t.memory as MemoryEvent[]).map((m) => m.ref),
        issues: findingsByCause(findings, issues).map((f) => {
          const ref = issues[f.key] ?? {};
          return { issue: ref.what ?? f.title, firstStep: f.seq, sessions: ref.sessions ?? 1, fix: ref.fix ?? null };
        }),
        ...(all_steps ? { allSteps: steps.slice(0, 600).map(brief) } : { failures: failed.slice(0, 40).map(brief) }),
      });
    },
  );

  server.registerTool(
    "list_tools",
    {
      title: "Tool reliability",
      description: "Each tool the agents called in the window: calls, failures, failure rate, median and slowest-5% run time (time waiting for the person is left out).",
      inputSchema: { days },
      annotations: { readOnlyHint: true },
    },
    async ({ days }) => {
      const tools: { name: string; calls: number; errors: number; typicalMs: number | null; slowMs: number | null }[] = await call(`/tools?days=${days}`);
      return text({
        window: `last ${days} days`,
        tools: tools
          .sort((a, b) => b.errors - a.errors || b.calls - a.calls)
          .slice(0, 60)
          .map((t) => ({ tool: t.name, calls: t.calls, failed: t.errors, failedPercent: t.calls ? Math.round((t.errors / t.calls) * 1000) / 10 : 0, medianMs: t.typicalMs, slowest5PercentMs: t.slowMs })),
      });
    },
  );

  server.registerTool(
    "list_fixes",
    {
      title: "List fixes",
      description: "Fixes Tracemind suggests for the person's Claude setup, from the issues that keep coming back: what each changes, why, and how many sessions it would help. Applied fixes include how often the issue happened before and since.",
      inputSchema: { days, status: z.enum(["open", "applied", "dismissed", "all"]).default("open") },
      annotations: { readOnlyHint: true },
    },
    async ({ days, status }) => {
      const list: Suggestion[] = await call(`/suggestions?days=${days}`);
      return text({ window: `last ${days} days`, fixes: list.filter((s) => status === "all" || s.status === status).sort((a, b) => b.sessions - a.sessions).map(fixRow) });
    },
  );

  server.registerTool(
    "preview_fix",
    {
      title: "Preview a fix",
      description: "Exactly what applying a fix would change: the lines added to which file (with the end of the file as it is now), or the hook added to ~/.claude/settings.json and what a new session would be told. Changes nothing.",
      inputSchema: { id: z.string().min(1).describe("The fix id from list_fixes.") },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => text(await call(`/suggestions/${encodeURIComponent(id)}/preview`, {})),
  );

  if (opts.canApply) {
    server.registerTool(
      "apply_fix",
      {
        title: "Apply a fix",
        description:
          "Applies a fix to this machine: adds its line to the instruction file (a copy of the file is kept, and undo_fix removes exactly that line) or installs its SessionStart hook. " +
          "Only when the person asked for this fix; show them preview_fix first.",
        inputSchema: { id: z.string().min(1).describe("The fix id from list_fixes.") },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async ({ id }) => {
        const r = await call(`/suggestions/${encodeURIComponent(id)}/apply`, {});
        return text(`Applied. Changed ${r.file}. undo_fix with the same id takes it out.`);
      },
    );

    server.registerTool(
      "undo_fix",
      {
        title: "Undo a fix",
        description: "Takes an applied fix back out: removes exactly the line it added, or the hook it installed.",
        inputSchema: { id: z.string().min(1) },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      },
      async ({ id }) => {
        await call(`/suggestions/${encodeURIComponent(id)}/undo`, {});
        return text("Undone.");
      },
    );
  }

  server.registerTool(
    "dismiss_fix",
    {
      title: "Dismiss or restore a fix",
      description: "Moves a fix out of the review list (dismiss) or back into it (restore). Changes no file.",
      inputSchema: { id: z.string().min(1), action: z.enum(["dismiss", "restore"]).default("dismiss") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ id, action }) => {
      await call(`/suggestions/${encodeURIComponent(id)}/${action}`, {});
      return text(action === "dismiss" ? "Dismissed." : "Back in the review list.");
    },
  );

  server.registerTool(
    "resolve_issue",
    {
      title: "Resolve or reopen an issue",
      description: "Marks an issue resolved (with an optional note on what was done), or opens it again. Issues also resolve by themselves after five quiet sessions over a day in their projects, and open again by themselves if a later session hits them.",
      inputSchema: {
        issue: z.string().min(1).describe("The issue's key or name."),
        action: z.enum(["resolve", "reopen"]).default("resolve"),
        note: z.string().max(500).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ issue, action, note }) => {
      const key = await issueKey(call, issue, 365);
      await call(`/cause/${encodeURIComponent(key)}/status`, { status: action === "resolve" ? "resolved" : "open", note: note ?? "" });
      return text(action === "resolve" ? "Marked resolved. It opens again if it happens again." : "Reopened.");
    },
  );

  server.registerTool(
    "routine_sync_status",
    {
      title: "Routine runs already imported",
      description:
        "For each claude.ai routine session already imported into Tracemind: how many runs and when the newest ended. " +
        "Use it before import_routine_runs to fetch only newer runs (stop paging a run log once it reaches this time).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const list: Session[] = await call("/sessions?kind=routines&limit=2000");
      const by = new Map<string, { sessionId: string; runs: number; newestRunEnded: string }>();
      for (const s of list) {
        const sessionId = routineSessionOf(s.id);
        if (!sessionId) continue;
        const e = by.get(sessionId) ?? { sessionId, runs: 0, newestRunEnded: "" };
        e.runs++;
        if (s.endedAt > e.newestRunEnded) e.newestRunEnded = s.endedAt;
        by.set(sessionId, e);
      }
      return text({ routineSessions: [...by.values()] });
    },
  );

  server.registerTool(
    "import_routine_runs",
    {
      title: "Import routine runs",
      description:
        "Imports the runs of a claude.ai routine into Tracemind, from its run log (RemoteTrigger get_run_log on the routine's session). " +
        "Each finished run becomes a session, and its failed or refused calls become issues. Importing the same runs again updates them; nothing is duplicated. " +
        "Pass the log as `path` when the tool result was saved to a file, otherwise as `log`, unchanged. Several pages of the same session can be passed together.",
      inputSchema: {
        routine: z.string().min(1).describe("The routine's name, e.g. \"Campaign replies check-in\"."),
        session_id: z.string().min(1).describe("The claude.ai session the routine posts into (persistent_session_id, or the run session id)."),
        log: z.union([z.string(), z.array(z.string())]).optional().describe("The run log text, or several pages of it."),
        path: z.string().optional().describe("A file holding the run log (local app only)."),
        fires: z.array(z.object({ name: z.string(), at: z.string() })).optional().describe("Fire times of the routines that post into this session, to name each run after the routine that started it."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ routine, session_id, log, path, fires }) => {
      let pages: string[] = Array.isArray(log) ? log : log ? [log] : [];
      if (path) {
        if (!opts.canApply) throw new Error("Reading a file works in the local app only; pass the log as text.");
        const { readFileSync, statSync } = await import("node:fs");
        if (statSync(path).size > 20 * 1024 * 1024) throw new Error("That file is over 20 MB; pass the log in pages.");
        pages = [...pages, readFileSync(path, "utf8")];
      }
      if (pages.length === 0) throw new Error("Pass the run log as `log` or `path`.");
      const me = await call("/me");
      const runs = parseRoutineRuns(pages, { routine, sessionId: session_id, person: me.person, fires });
      let issues = 0;
      for (const t of runs) issues += (await call("/ingest", t)).findings ?? 0;
      const newest = runs.map((r) => r.session.endedAt).sort().pop() ?? null;
      return text({ imported: runs.length, failedCalls: runs.reduce((n, r) => n + r.session.toolErrors, 0), issuesFound: issues, newestRunEnded: newest });
    },
  );

  return server;
}
