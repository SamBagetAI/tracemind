/**
 * Turns a session's steps into the rows the session page shows. Pure functions, tested in
 * test/trace-view.test.ts.
 *
 * - Failures of the same tool in a row with the same error become one row ("Edit ×5").
 * - In focus mode, three or more steps in a row that went fine (tool calls and the agent's replies)
 *   and are not next to a failure fold into one row that says what they were ("6 steps went fine: 4 Bash, 2 Reply").
 */
import { errorLine } from "../../../src/core/issues";
import { findingsByCause } from "../../../src/core/describe";
import type { Finding, IssueRef, Step, Trace } from "./api";

export { findingsByCause, startFiles } from "../../../src/core/describe";

export type Row =
  | { type: "step"; step: Step; finding?: Finding; issue?: IssueRef }
  | { type: "repeat"; steps: Step[]; finding?: Finding; issue?: IssueRef }
  | { type: "fold"; steps: Step[] };

const isTool = (s: Step) => s.kind === "tool" || s.kind === "subagent";

/**
 * The part of an error worth reading. Refusals from Claude Code's auto-mode classifier are mostly
 * boilerplate; their reason tag ("Production Reads") is what says why.
 */
export function errorDetail(output: string): string {
  const reason = /Reason:\s*\[([^\]]+)\]/.exec(output);
  if (/auto mode classifier/i.test(output) && reason) return `reason: ${reason[1]}`;
  return errorLine(output);
}

function sameFailure(a: Step, b: Step) {
  return a.isError && b.isError && isTool(a) && isTool(b) && a.name === b.name && errorLine(a.output).slice(0, 80) === errorLine(b.output).slice(0, 80);
}

/** A shell command without the `cd /some/path &&` in front that agents put on almost every call. */
export function commandLine(input: string): string {
  const first = input.split("\n")[0];
  return first.replace(/^(?:\s*cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*)+/, "") || first;
}

export function buildRows(trace: Pick<Trace, "steps" | "findings" | "issues">, focus: boolean): Row[] {
  const findingAt = new Map(trace.findings.map((f) => [f.seq, f]));
  const steps = trace.steps;
  // A finding is recorded once per session, at the first step that hit it. Later steps that
  // failed the same way point at the same issue.
  const byError = new Map<string, Finding>();
  for (const s of steps) {
    const f = findingAt.get(s.seq);
    if (f && s.isError) byError.set(`${s.name}\n${errorLine(s.output).slice(0, 80)}`, f);
  }
  for (const s of steps) {
    if (s.isError && !findingAt.has(s.seq)) {
      const f = byError.get(`${s.name}\n${errorLine(s.output).slice(0, 80)}`);
      if (f) findingAt.set(s.seq, f);
    }
  }

  // Failures of the same kind in a row.
  const grouped: Row[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    let j = i;
    while (j + 1 < steps.length && sameFailure(s, steps[j + 1])) j++;
    const run = steps.slice(i, j + 1);
    const finding = run.map((x) => findingAt.get(x.seq)).find(Boolean);
    const issue = finding ? trace.issues[finding.key] : undefined;
    grouped.push(run.length > 1 ? { type: "repeat", steps: run, finding, issue } : { type: "step", step: s, finding, issue });
    i = j;
  }
  if (!focus) return grouped;

  // Fold quiet stretches: tool calls that went fine, not right before or after a failure.
  const failedNear = (k: number) => {
    const r = grouped[k];
    const bad = (x: Row | undefined) => !!x && (x.type === "repeat" || (x.type === "step" && (x.step.isError || x.step.kind === "interrupt")));
    return bad(r) || bad(grouped[k - 1]) || bad(grouped[k + 1]);
  };
  const quiet = (k: number) => {
    const r = grouped[k];
    // The agent's replies in between fold too: they are what makes twenty short folds out of one quiet stretch.
    return r.type === "step" && (isTool(r.step) || r.step.kind === "reply") && !r.step.isError && !failedNear(k);
  };
  const out: Row[] = [];
  for (let k = 0; k < grouped.length; k++) {
    if (!quiet(k)) {
      out.push(grouped[k]);
      continue;
    }
    let e = k;
    while (e + 1 < grouped.length && quiet(e + 1)) e++;
    const run = grouped.slice(k, e + 1) as Extract<Row, { type: "step" }>[];
    if (run.length >= 3) out.push({ type: "fold", steps: run.map((r) => r.step) });
    else out.push(...run);
    k = e;
  }
  return out;
}

/** "4 Bash, 2 Read, 1 update_plan", most frequent first. */
export function foldSummary(steps: Step[]): string {
  const counts = new Map<string, number>();
  for (const s of steps) counts.set(s.name, (counts.get(s.name) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${n} ${name}`)
    .join(", ");
}

type Run = { name: string; from: number; to: number; count: number };

/** The longest run of the same tool failing the same way in a row (two different errors are two runs). */
export function longestFailureRun(steps: Step[]): Run | null {
  let best: Run | null = null;
  let cur: (Run & { error: string }) | null = null;
  for (const s of steps) {
    if (!isTool(s)) continue;
    const error = s.isError ? errorLine(s.output).slice(0, 80) : "";
    if (s.isError && cur && cur.name === s.name && cur.error === error) {
      cur.to = s.seq;
      cur.count++;
    } else if (s.isError) {
      cur = { name: s.name, from: s.seq, to: s.seq, count: 1, error };
    } else {
      cur = null;
    }
    if (cur && (!best || cur.count > best.count)) best = { name: cur.name, from: cur.from, to: cur.to, count: cur.count };
  }
  return best;
}

/** One sentence of facts about the session: no guessing at causes. */
export function diagnosis(trace: Pick<Trace, "session" | "steps" | "findings" | "issues">): { lead: string; rest: string } {
  const s = trace.session;
  const failed = trace.steps.filter((x) => isTool(x) && x.isError).length;
  if (failed === 0 && trace.findings.length === 0) {
    return { lead: "Ran clean.", rest: `${s.toolCalls} tool calls and none failed.` };
  }
  const lead = failed ? `${failed} of ${s.toolCalls} tool calls failed.` : "No tool call failed, but the session was stopped.";
  const parts: string[] = [];
  const run = longestFailureRun(trace.steps);
  if (run && run.count >= 3) parts.push(`${run.name} failed ${run.count} times in a row, at steps ${run.from}–${run.to}.`);
  // Counted by cause, as the Issues list and the side panel count them: two variants of one cause are one issue.
  const causes = findingsByCause(trace.findings, trace.issues).map((f) => trace.issues[f.key]?.sessions ?? 0);
  const recurring = causes.filter((n) => n > 1).length;
  if (recurring) parts.push(recurring === causes.length ? (causes.length === 1 ? "Its one issue happened in other sessions too." : `All ${causes.length} of its issues happened in other sessions too.`) : `${recurring} of its ${causes.length} issues happened in other sessions too.`);
  else if (causes.length) parts.push(causes.length === 1 ? "Its one issue is new." : `All ${causes.length} of its issues are new.`);
  return { lead, rest: parts.join(" ") };
}

/**
 * The rows a person jumps between with j and k: each failed row, by the seq its row is anchored at.
 * A failure folded away cannot be, since folds only hold steps that went fine.
 */
export function failureAnchors(rows: Row[]): number[] {
  const out: number[] = [];
  for (const r of rows) {
    if (r.type === "repeat") out.push(r.steps[0].seq);
    else if (r.type === "step" && r.step.isError) out.push(r.step.seq);
  }
  return out;
}

/** The anchor after (dir 1) or before (dir -1) the current one, wrapping round; the first when none is current. */
export function nextAnchor(anchors: number[], current: number | null, dir: 1 | -1): number | null {
  if (anchors.length === 0) return null;
  const i = current == null ? -1 : anchors.indexOf(current);
  if (i < 0) return dir === 1 ? anchors[0] : anchors[anchors.length - 1];
  return anchors[(i + dir + anchors.length) % anchors.length];
}

/**
 * Where each step sits, for the time strip. By step (the default) every step gets the same width,
 * so a burst of fast failures is as visible as one long build; by time, steps sit on the session's clock.
 */
export function timeline(steps: Step[], scale: "step" | "time" = "time"): { total: number; marks: { seq: number; at: number; width: number; kind: Step["kind"]; isError: boolean; name: string; durationMs: number | null }[] } {
  if (steps.length === 0) return { total: 0, marks: [] };
  const t0 = Date.parse(steps[0].at);
  const total = Math.max(1, ...steps.map((s) => Date.parse(s.at) - t0 + (s.durationMs ?? 0)));
  const n = steps.length;
  return {
    total,
    marks: steps.map((s, i) => ({
      seq: s.seq,
      at: scale === "step" ? i / n : (Date.parse(s.at) - t0) / total,
      width: scale === "step" ? 1 / n : (s.durationMs ?? 0) / total,
      kind: s.kind,
      isError: s.isError,
      name: s.name,
      durationMs: s.durationMs,
    })),
  };
}
