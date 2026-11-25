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
import { describeIssue } from "../core/describe.ts";

/** Calls the API: a path under /api, and a JSON body for a POST. Throws the API's error message. */
export type ApiCall = (path: string, body?: unknown) => Promise<any>;

const VERSION = "0.1.0";
const days = z.number().int().min(1).max(365).default(30).describe("The window in days, 1 to 365 (default 30), as in the web UI's window picker.");

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 1) }] });
const clip = (s: string | null | undefined, n: number) => (!s ? "" : s.length > n ? `${s.slice(0, n)}…` : s);

type Group = {
  what: string; plain: boolean; raw: string; kindLabel: string; tools: string; sessions: number; previous?: number;
  status: string; reopened: boolean; fix?: string | null; firstSeen: string; lastSeen: string; issues: { key: string }[];
};

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

type Suggestion = {
  id: string; kind: string; title: string; why: string; sessions: number; status: string; causes: string[];
  action: { type: string; file?: string; text?: string; scope?: string }; examples: { id: string; title: string; seq?: number }[];
  effect?: unknown; at?: string | null; checks?: unknown;
};

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
    canApply: a.type === "rule" || a.type === "routine",
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
      const list: { id: string; title: string; project: string; gitBranch: string | null; startedAt: string; endedAt: string; toolCalls: number; toolErrors: number; issueCount: number; person: string; activeMs: number; costUsd: number }[] = await call(`/sessions?${q}`);
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
      type Step = { seq: number; kind: string; name: string; input: string; output: string; isError: boolean; durationMs: number | null; at: string };
      const steps: Step[] = t.steps;
      const tool = (s: Step) => s.kind === "tool" || s.kind === "subagent";
      const failed = steps.filter((s) => tool(s) && s.isError);
      const issueAt = new Map<number, string>();
      for (const f of t.findings as { key: string; seq: number; title: string }[]) issueAt.set(f.seq, t.issues[f.key]?.what ?? f.title);
      const byCause = new Map<string, { issue: string; firstStep: number; sessions: number; fix: string | null }>();
      for (const f of t.findings as { key: string; seq: number; title: string }[]) {
        const ref = t.issues[f.key] ?? {};
        const k = ref.cause ?? f.key;
        if (!byCause.has(k)) byCause.set(k, { issue: ref.what ?? f.title, firstStep: f.seq, sessions: ref.sessions ?? 1, fix: ref.fix ?? null });
      }
      const s = t.session;
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
        loadedAtStart: [...new Set((t.memory as { source: string; ref: string }[]).filter((m) => m.source === "instructions").map((m) => m.ref))],
        issues: [...byCause.values()],
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
      description: "Marks an issue resolved (with an optional note on what was done), or opens it again. A resolved issue opens again by itself if a later session hits it.",
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

  return server;
}
