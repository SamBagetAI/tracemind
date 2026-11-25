/**
 * Claude Code routines (claude.ai routines, fired on a schedule) run in a cloud sandbox, not on
 * this machine, so there is no transcript on disk. claude.ai keeps a condensed log of each run:
 *
 *   [2026-11-24T16:12:54.542027Z] tool_use Bash: {"command":"date"}
 *   [2026-11-24T16:12:55.405988Z] tool_result: Tue Nov 24 18:12:55 IST 2026
 *   [2026-11-24T16:34:12.549402Z] permission_denied mcp__x__delete_trigger [classifier]: [Destructive or Unwanted Actions]
 *   [2026-11-24T16:34:12.630760Z] tool_result ERROR: Permission for this action was denied by ...
 *   [2026-11-24T16:34:23.698792Z] result: success is_error=false turns=12 duration=76s — I've added ...
 *
 * One routine posts into one long claude.ai session, turn after turn. Each turn (up to its
 * `result` line) is one run, and becomes one Tracemind session, so its failures become issues
 * like any other session's. The log is condensed: long inputs and outputs are cut ("… [+N chars]").
 */
import { findIssues } from "./issues.ts";
import { activeMs } from "./pricing.ts";
import { clip, redact } from "./redact.ts";
import type { Outcome, Session, Step, Trace } from "./types.ts";

type Event = { at: string; kind: string; name: string; text: string };

const LINE = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\] ([a-z_]+)(?:\[[a-z]+\])?(?: (ERROR))?(?: ([^\s:[]+))?(?: \[[^\]]*\])?: ?(.*)$/;

/** The log's lines as events, oldest first, without repeats (pages of the log can overlap). */
export function routineEvents(log: string | string[]): Event[] {
  const seen = new Set<string>();
  const out: Event[] = [];
  for (const page of Array.isArray(log) ? log : [log]) {
    for (const raw of page.split("\n")) {
      const m = LINE.exec(raw.trimEnd());
      if (!m || seen.has(raw)) continue;
      seen.add(raw);
      const [, at, kind, error, name = "", text] = m;
      // Microseconds cut to milliseconds, as every other time Tracemind stores.
      out.push({ at: new Date(at).toISOString(), kind: error ? `${kind}_error` : kind, name, text });
    }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

export type RoutineFire = { name: string; at: string };

export type RoutineOptions = {
  /** The routine's name, used when no fire below matches a run. */
  routine: string;
  /** The claude.ai session the routine posts into (session_… or cse_…). */
  sessionId: string;
  person: string;
  /** When each routine that posts into this session fired: a run is named after the last fire before it. */
  fires?: RoutineFire[];
};

const KIND_OF: Record<string, Step["kind"]> = { user: "prompt", assistant: "reply" };

/** Each run in the log as a Tracemind trace. A run still going (no `result` yet) is left out. */
export function parseRoutineRuns(log: string | string[], opts: RoutineOptions): Trace[] {
  const events = routineEvents(log);
  const runs: Event[][] = [];
  let cur: Event[] = [];
  for (const e of events) {
    cur.push(e);
    if (e.kind === "result") {
      runs.push(cur);
      cur = [];
    }
  }
  return runs.map((run) => runTrace(run, opts)).filter((t): t is Trace => t !== null);
}

/** What the person wrote in a follow-up turn, without context the app attached (<artifact-view-context …>). */
function followUp(input: string): string {
  // Whole context blocks go; one cut short by the log (no closing tag) takes the rest with it.
  const text = input
    .replace(/<([a-z-]+)[^>]*>[\s\S]*?<\/\1>/g, " ")
    .replace(/<[a-z-]+[\s>][\s\S]*$/, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text && !text.startsWith("<") ? text : "follow-up";
}

function runTrace(run: Event[], opts: RoutineOptions): Trace | null {
  const result = run[run.length - 1];
  const started = run[0].at;
  const steps: Step[] = [];
  const pending: Step[] = [];
  let model: string | null = null;
  for (const e of run) {
    if (e.kind === "init") {
      model = /model=(\S+)/.exec(e.text)?.[1] ?? model;
    } else if (e.kind === "tool_use") {
      const s: Step = { seq: 0, kind: e.name === "Task" || e.name === "Agent" ? "subagent" : "tool", name: e.name, input: clip(e.text, 4000), output: "", isError: false, at: e.at, durationMs: null, sidechain: false };
      steps.push(s);
      pending.push(s);
    } else if (e.kind === "permission_denied") {
      // The refusal comes before the tool's error result; mark the call it refused.
      const s = [...pending].reverse().find((p) => p.name === e.name) ?? pending[pending.length - 1];
      if (s) s.isError = true;
    } else if (e.kind === "tool_result" || e.kind === "tool_result_error") {
      // Results come back in the order the calls were made; the log does not pair them by id.
      const s = pending.shift();
      if (!s) continue;
      s.output = clip(e.text, 4000);
      s.isError = s.isError || e.kind === "tool_result_error";
      const d = Date.parse(e.at) - Date.parse(s.at);
      s.durationMs = d >= 0 && d <= 2 * 3600_000 ? d : null;
    } else if ((e.kind === "assistant" || e.kind === "user") && e.text && e.text !== "[thinking]") {
      steps.push({ seq: 0, kind: KIND_OF[e.kind], name: e.kind === "user" ? "Prompt" : "Reply", input: e.kind === "user" ? clip(e.text, 4000) : "", output: e.kind === "assistant" ? clip(e.text, 4000) : "", isError: false, at: e.at, durationMs: null, sidechain: false });
    }
  }
  if (steps.length === 0) return null;
  steps.forEach((s, i) => (s.seq = i + 1));

  const meta = Object.fromEntries([...result.text.matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1], m[2]]));
  const failed = result.text.startsWith("error") || meta.is_error === "true";
  const fire = [...(opts.fires ?? [])]
    .filter((f) => f.at <= started && Date.parse(started) - Date.parse(f.at) < 30 * 60_000)
    .sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  const name = fire?.name ?? opts.routine;
  // A turn the person started themselves ("check") is a follow-up in the routine's session.
  const byPerson = steps[0].kind === "prompt";
  const tools = steps.filter((s) => s.kind === "tool" || s.kind === "subagent");
  const outcome: Outcome = failed ? "error" : "ok";
  const session: Session = {
    id: `routine-${opts.sessionId}-${started.replace(/[^0-9]/g, "").slice(0, 17)}`,
    agent: "claude-code-routine",
    person: opts.person,
    project: `routines/${name}`,
    title: clip(byPerson ? `${name}: ${followUp(steps[0].input)}` : name, 120),
    gitBranch: null,
    model,
    agentVersion: null,
    startedAt: started,
    endedAt: result.at,
    outcome,
    stepCount: steps.length,
    toolCalls: tools.length,
    toolErrors: tools.filter((s) => s.isError).length,
    inputTokens: 0,
    outputTokens: 0,
    activeMs: activeMs(run.filter((e) => e.kind !== "env").map((e) => e.at)),
    costUsd: 0,
    brief: null,
  };
  return {
    session: { ...session, title: redact(session.title) },
    steps: steps.map((s) => ({ ...s, input: redact(s.input), output: redact(s.output) })),
    memory: [],
    findings: findIssues(steps),
  };
}
