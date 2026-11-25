import { describe, expect, it } from "vitest";
import { describeIssue } from "../src/core/describe.ts";
import { parseRoutineRuns, routineEvents } from "../src/core/parse-routine.ts";

/** Two runs of a routine and one turn the person started, in the condensed log format claude.ai returns. */
const LOG = `[2026-11-24T16:12:50.100000Z] env[info]: Allocating sandbox
[2026-11-24T16:12:51.200000Z] init: model=claude-opus-5-5 cwd=/home/claude
[2026-11-24T16:12:53.844876Z] assistant: [thinking]
[2026-11-24T16:12:54.542027Z] tool_use Bash: {"command":"date"}
[2026-11-24T16:12:55.329360Z] tool_use mcp__Gmail__search_threads: {"query":"newer_than:3h"}
[2026-11-24T16:12:55.405988Z] tool_result: Tue Nov 24 18:12:55 2026
[2026-11-24T16:12:55.792696Z] tool_result: {}
[2026-11-24T16:34:09.449099Z] tool_use mcp__remote__delete_trigger: {"trigger_id":"trig_1"}
[2026-11-24T16:34:12.549402Z] permission_denied mcp__remote__delete_trigger [classifier]: [Destructive or Unwanted Actions]
[2026-11-24T16:34:12.630760Z] tool_result ERROR: Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Destructive or Unwanted Actions]. If you have other tasks…
[2026-11-24T16:34:23.562770Z] assistant: Added the call notes to the sheet.
[2026-11-24T16:34:23.698792Z] result: success is_error=false turns=12 duration=76s permission_denials=1 — Added the call notes to the sheet.
[2026-11-25T07:00:24.320518Z] env[info]: Allocating sandbox
[2026-11-25T07:00:27.252302Z] init: model=claude-opus-5-5 cwd=/home/claude
[2026-11-25T07:00:32.539095Z] tool_use mcp__Gmail__search_threads: {"query":"newer_than:15h"}
[2026-11-25T07:00:33.120084Z] tool_result: {"threads":[]}
[2026-11-25T07:01:31.993684Z] assistant: Nothing new in the campaign.
[2026-11-25T07:01:31.993684Z] result: success is_error=false turns=15 duration=65s — Nothing new in the campaign.
[2026-11-25T08:33:56.303571Z] user: what did you do today?
[2026-11-25T08:34:05.607570Z] assistant: Only the 9:00 check-in.
[2026-11-25T08:34:05.690629Z] result: success is_error=false turns=2 duration=9s — Only the 9:00 check-in.
[2026-11-25T10:00:01.000000Z] env[info]: Allocating sandbox
[2026-11-25T10:00:02.000000Z] tool_use Bash: {"command":"date"}`;

const opts = {
  routine: "Campaign replies check-in",
  sessionId: "session_01ABC",
  person: "Ada",
  fires: [
    { name: "Or Barel call notes", at: "2026-11-24T16:12:40Z" },
    { name: "Campaign replies check-in", at: "2026-11-25T07:00:00Z" },
  ],
};

describe("routine runs", () => {
  it("reads every kind of line, including an error result and a refusal", () => {
    const kinds = routineEvents(LOG).map((e) => e.kind);
    expect(kinds).toContain("tool_result_error");
    expect(kinds).toContain("permission_denied");
    expect(routineEvents(LOG).find((e) => e.kind === "permission_denied")?.name).toBe("mcp__remote__delete_trigger");
  });

  it("makes one session per finished run, named after the routine that fired it", () => {
    const runs = parseRoutineRuns(LOG, opts);
    expect(runs).toHaveLength(3); // the run still going at 10:00 has no result yet
    expect(runs.map((r) => r.session.title)).toEqual(["Or Barel call notes", "Campaign replies check-in", "Campaign replies check-in: what did you do today?"]);
    expect(runs[0].session).toMatchObject({ agent: "claude-code-routine", project: "routines/Or Barel call notes", model: "claude-opus-5-5", toolCalls: 3, toolErrors: 1, outcome: "ok" });
    expect(runs[1].session.toolErrors).toBe(0);
  });

  it("turns a refused call into the same issue a local session would get", () => {
    const [first] = parseRoutineRuns(LOG, opts);
    const refused = first.steps.find((s) => s.name === "mcp__remote__delete_trigger")!;
    expect(refused.isError).toBe(true);
    expect(refused.output).toContain("auto mode classifier");
    expect(first.findings.map((f) => describeIssue(f).what)).toContain("Refused by the auto-mode classifier");
  });

  it("gives the same session id when the same log is read again, so importing twice does not duplicate", () => {
    const a = parseRoutineRuns(LOG, opts).map((r) => r.session.id);
    const b = parseRoutineRuns([LOG.split("\n").slice(0, 14).join("\n"), LOG], opts).map((r) => r.session.id);
    expect(b).toEqual(a);
  });
});
