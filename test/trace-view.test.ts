import { describe, expect, it } from "vitest";
import type { Step } from "../web/src/lib/api";
import { buildRows, commandLine, diagnosis, failureAnchors, foldSummary, longestFailureRun, nextAnchor, timeline } from "../web/src/lib/trace";
import { causeKey, describeIssue, num, plainText, sessionsLevel, shortPath, topTools, when } from "../web/src/lib/format";

let t = Date.parse("2026-10-18T10:00:00Z");
function step(seq: number, name: string, opts: Partial<Step> = {}): Step {
  t += 1000;
  return { seq, kind: "tool", name, input: `${name} ${seq}`, output: "ok", isError: false, at: new Date(t).toISOString(), durationMs: 100, sidechain: false, ...opts };
}
const fail = (seq: number, name: string, msg = "Error: boom") => step(seq, name, { isError: true, output: msg });

const steps: Step[] = [
  step(1, "Prompt", { kind: "prompt" }),
  step(2, "Bash"),
  step(3, "Bash"),
  step(4, "Read"),
  step(5, "Read"),
  step(6, "Bash"),
  fail(7, "Edit", "hook error: isolated worktree"),
  fail(8, "Edit", "hook error: isolated worktree"),
  fail(9, "Edit", "hook error: isolated worktree"),
  fail(10, "Edit", "file has not been read yet"),
  step(11, "Reply", { kind: "reply" }),
  step(12, "Edit"),
];
const findings = [
  { key: "tool_error:Edit:hook", kind: "tool_error" as const, title: "Edit failed: hook error", seq: 7 },
  { key: "tool_error:Edit:read", kind: "tool_error" as const, title: "Edit failed: file has not been read yet", seq: 10 },
];
const issues = { "tool_error:Edit:hook": { status: "open" as const, num: 3, sessions: 1 }, "tool_error:Edit:read": { status: "open" as const, num: 4, sessions: 14 } };

describe("buildRows", () => {
  it("collapses the same failure in a row and keeps its issue", () => {
    const rows = buildRows({ steps, findings, issues }, false);
    const repeat = rows.find((r) => r.type === "repeat");
    expect(repeat?.type === "repeat" && repeat.steps.map((s) => s.seq)).toEqual([7, 8, 9]);
    expect(repeat?.type === "repeat" && repeat.issue?.num).toBe(3);
    // A different error right after is its own row.
    expect(rows.some((r) => r.type === "step" && r.step.seq === 10 && r.issue?.num === 4)).toBe(true);
  });

  it("folds three or more quiet tool calls in focus mode, but not the one next to a failure", () => {
    const rows = buildRows({ steps, findings, issues }, true);
    const fold = rows.find((r) => r.type === "fold");
    expect(fold?.type === "fold" && fold.steps.map((s) => s.seq)).toEqual([2, 3, 4, 5]);
    expect(rows.some((r) => r.type === "step" && r.step.seq === 6)).toBe(true);
    expect(rows[0].type === "step" && rows[0].step.kind).toBe("prompt");
  });

  it("shows every step when not in focus mode", () => {
    const rows = buildRows({ steps, findings, issues }, false);
    expect(rows.some((r) => r.type === "fold")).toBe(false);
  });
});

describe("commands and repeated errors", () => {
  it("drops the cd in front of a command", () => {
    expect(commandLine("cd /Users/me/app; git status --short")).toBe("git status --short");
    expect(commandLine('cd "/a b" && cd sub && pnpm test')).toBe("pnpm test");
    expect(commandLine("ls -la")).toBe("ls -la");
  });

  it("points a later step that failed the same way at the same issue", () => {
    const s = [fail(1, "Bash", "Permission denied by the classifier"), step(2, "Read"), fail(3, "Bash", "Permission denied by the classifier")];
    const f = [{ key: "k", kind: "permission_denied" as const, title: "Bash was refused", seq: 1 }];
    const rows = buildRows({ steps: s, findings: f, issues: { k: { status: "open", num: 9, sessions: 3 } } }, false);
    const third = rows.find((r) => r.type === "step" && r.step.seq === 3);
    expect(third?.type === "step" && third.issue?.num).toBe(9);
  });
});

describe("summaries", () => {
  it("names what a fold holds", () => {
    expect(foldSummary(steps.slice(1, 6))).toBe("3 Bash, 2 Read");
  });

  it("finds the longest run of one tool failing", () => {
    // Steps 7–9 failed the same way; step 10 failed differently, so it starts a run of its own.
    expect(longestFailureRun(steps)).toEqual({ name: "Edit", from: 7, to: 9, count: 3 });
  });

  it("states facts in the diagnosis", () => {
    const session = { toolCalls: 10 } as never;
    const d = diagnosis({ session, steps, findings, issues });
    expect(d.lead).toBe("4 of 10 tool calls failed.");
    expect(d.rest).toBe("Edit failed 3 times in a row, at steps 7–9. 1 of its 2 issues happened in other sessions too.");
  });

  it("places steps on the session clock", () => {
    const tl = timeline(steps);
    expect(tl.marks[0].at).toBe(0);
    expect(tl.marks[tl.marks.length - 1].at).toBeGreaterThan(0.9);
  });

  it("gives every step the same width by step", () => {
    const tl = timeline(steps, "step");
    expect(new Set(tl.marks.map((m) => m.width))).toEqual(new Set([1 / steps.length]));
    expect(tl.marks[1].at).toBeCloseTo(1 / steps.length);
  });

  it("jumps between failed rows, a repeat counting once, and wraps round", () => {
    const rows = buildRows({ steps, findings, issues }, true);
    const anchors = failureAnchors(rows);
    const failedSeqs = steps.filter((s) => s.isError).map((s) => s.seq);
    expect(anchors.length).toBeLessThan(failedSeqs.length);
    expect(anchors.every((a) => failedSeqs.includes(a))).toBe(true);
    expect(nextAnchor(anchors, null, 1)).toBe(anchors[0]);
    expect(nextAnchor(anchors, null, -1)).toBe(anchors[anchors.length - 1]);
    expect(nextAnchor(anchors, anchors[anchors.length - 1], 1)).toBe(anchors[0]);
    expect(nextAnchor([], null, 1)).toBeNull();
  });
});

describe("format", () => {
  it("says issues the way a person would", () => {
    expect(describeIssue({ kind: "permission_denied", title: "Bash git was refused: permission for this action was denied by the claude code aut…" })).toMatchObject({ tool: "Bash git", what: "Refused by the auto-mode classifier" });
    expect(describeIssue({ kind: "tool_error", title: "Bash ls failed: exit code #" }).what).toBe("Exited with an error code");
    expect(describeIssue({ kind: "interrupted", title: "A person stopped the agent" }).what).toBe("Stopped by a person");
  });

  it("puts one cause on different tools under one key, and names the top tools", () => {
    const a = { kind: "permission_denied" as const, title: "Bash cat was refused: permission for this action was denied by the claude code aut…" };
    const b = { kind: "permission_denied" as const, title: "Bash git was refused: permission for this action was denied by the claude code aut…" };
    expect(causeKey(a)).toBe(causeKey(b));
    expect(causeKey({ kind: "tool_error", title: "Edit failed: file has not been read yet" })).not.toBe(causeKey(a));
    expect(topTools([{ tool: "Bash cat", sessions: 19 }, { tool: "Bash git", sessions: 14 }, { tool: "Bash ls", sessions: 2 }, { tool: "railway/get_logs", sessions: 1 }])).toBe("cat, git, ls +1");
  });

  it("marks unknown errors as the error's own words", () => {
    const d = describeIssue({ kind: "tool_error", title: "Bash foo failed: some brand new failure we never saw" });
    expect(d.plain).toBe(false);
    expect(d.what).toBe("Some brand new failure we never saw");
  });

  it("formats numbers, zero, levels and markdown the same way everywhere", () => {
    expect(num(5614)).toBe("5,614");
    expect(num(0)).toBe("—");
    expect([sessionsLevel(1), sessionsLevel(3), sessionsLevel(9)]).toEqual(["none", "low", "high"]);
    expect(plainText("- [Owner decisions are final](owner.md) — when **Sam** says")).toBe("Owner decisions are final — when Sam says");
  });

  it("shortens paths and dates", () => {
    expect(shortPath("/Users/sam/.claude/projects/-Users-sam-harness-hub/memory/MEMORY.md")).toBe("~/…/harness-hub/memory/MEMORY.md");
    expect(when("2026-11-24T10:00:00Z", Date.parse("2026-11-24T12:00:00Z"))).toBe("2h ago");
    expect(when("2026-10-18T10:00:00Z", Date.parse("2026-11-24T12:00:00Z"))).toBe("18 Oct");
  });
});

describe("error detail", () => {
  it("keeps only the reason of a classifier refusal", async () => {
    const { errorDetail } = await import("../web/src/lib/trace");
    expect(errorDetail("Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Production Reads]. If you have other tasks…")).toBe("reason: Production Reads");
    expect(errorDetail("Exit code 1\nError: boom")).toBe("Error: boom");
  });
});

describe("round six", () => {
  it("counts a session's issues by cause, as the side panel does", () => {
    const sameCause = {
      "tool_error:Edit:hook": { status: "open" as const, num: 3, sessions: 1, cause: "c1" },
      "tool_error:Edit:read": { status: "open" as const, num: 4, sessions: 1, cause: "c1" },
    };
    const d = diagnosis({ session: { toolCalls: 10 } as never, steps, findings, issues: sameCause });
    expect(d.rest).toContain("Its one issue is new.");
  });

  it("folds the agent's replies into a quiet stretch", () => {
    let u = Date.parse("2026-10-19T10:00:00Z");
    const mk = (seq: number, kind: Step["kind"], name: string): Step => ({ seq, kind, name, input: "", output: "ok", isError: false, at: new Date((u += 1000)).toISOString(), durationMs: 1, sidechain: false });
    const quiet = [mk(1, "prompt", "Prompt"), mk(2, "tool", "Bash"), mk(3, "reply", "Reply"), mk(4, "tool", "Read"), mk(5, "reply", "Reply"), mk(6, "tool", "Bash")];
    const rows = buildRows({ steps: quiet, findings: [], issues: {} }, true);
    expect(rows.map((r) => r.type)).toEqual(["step", "fold"]);
  });

  it("says database errors are database errors, not missing files", () => {
    expect(describeIssue({ kind: "tool_error", title: "Bash node failed: neondberror: column <…> does not exist" }).what).toBe("Database query failed");
    expect(describeIssue({ kind: "tool_error", title: "Bash cat failed: cat: x: no such file or directory" }).what).toBe("File or folder not found");
  });
});

describe("tool ranking", () => {
  it("puts a small but real failure rate above many clean calls, and does not over-trust one call", async () => {
    const { rankTools, wilsonLow } = await import("../web/src/lib/rank");
    const t = (name: string, errors: number, calls: number) => ({ name, errors, calls, typicalMs: null, slowMs: null, timed: 0, sessions: 1 });
    const order = rankTools([t("clean", 0, 300), t("tabs", 2, 15), t("once", 1, 1), t("bash", 50, 500)]).map((x) => x.name);
    expect(order).toEqual(["bash", "tabs", "once", "clean"]);
    expect(wilsonLow(1, 2)).toBeLessThan(wilsonLow(10, 20));
    expect(order[order.length - 1]).toBe("clean");
  });

  it("orders tools with enough calls by their failure rate, as the page says", async () => {
    const { rankTools } = await import("../web/src/lib/rank");
    const t = (name: string, errors: number, calls: number) => ({ name, errors, calls, typicalMs: null, slowMs: null, timed: 0, sessions: 1 });
    const order = rankTools([t("bash", 50, 500), t("edit", 5, 25), t("read", 3, 300)]).map((x) => x.name);
    expect(order).toEqual(["edit", "bash", "read"]);
  });
});
