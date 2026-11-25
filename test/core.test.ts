import { describe, expect, it } from "vitest";
import { describeIssue } from "../src/core/describe.ts";
import { findIssues, program, signature } from "../src/core/issues.ts";
import { describeInput, parseClaudeSession, shortToolName } from "../src/core/parse-claude.ts";
import { clip, redact, redactCounted } from "../src/core/redact.ts";
import { InvalidTrace, validateTrace } from "../src/core/validate.ts";
import { mainTranscript, subagentTranscript } from "./fixtures/session.ts";

describe("redact", () => {
  it("removes keys, tokens, emails and card numbers", () => {
    const text = [
      "stripe sk_live_51HxABCDEFGHIJKLMN",
      "mail jonas@kestrel.io",
      "card 4242 4242 4242 4242",
      "gh ghp_abcdefghijklmnopqrstuvwxyz0123",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "DATABASE_PASSWORD=hunter2hunter2",
      '"apiKey": "abc123def456"',
      "postgres://admin:s3cret@db.example.net/app",
    ].join("\n");
    const r = redactCounted(text);
    expect(r.text).not.toMatch(/sk_live_51|jonas@|4242 4242|ghp_|abcdefghijklmnopqrstuvwxyz|hunter2|abc123def456|s3cret/);
    expect(r.text).toContain("Bearer [redacted]");
    expect(r.text).toContain("postgres://[redacted]@db.example.net");
    expect(r.count).toBeGreaterThanOrEqual(8);
  });

  it("keeps numbers that are not card numbers", () => {
    expect(redact("order 1234567890123 shipped")).toBe("order 1234567890123 shipped");
    expect(redact("took 42 ms")).toBe("took 42 ms");
  });

  it("clips long text and says how much was cut", () => {
    expect(clip("a".repeat(30), 10)).toBe("aaaaaaaaaa… [20 more characters]");
  });
});

describe("parseClaudeSession", () => {
  const trace = parseClaudeSession("sess-1", mainTranscript(), { person: "Ada", subagents: [subagentTranscript()] });
  const s = trace.session;

  it("reads the session's facts", () => {
    expect(s.title).toBe("Fix promo code check");
    expect(s.project).toBe("/work/shop");
    expect(s.gitBranch).toBe("fix-promo");
    expect(s.model).toBe("claude-opus-5-5");
    expect(s.person).toBe("Ada");
    expect(s.outcome).toBe("interrupted");
  });

  it("counts usage once per message", () => {
    // m1, m3..m9 at 10/5 each (8 messages), m2 once at 100/20, subagent s1 at 1/1.
    expect(s.inputTokens).toBe(8 * 10 + 100 + 1);
    expect(s.outputTokens).toBe(8 * 5 + 20 + 1);
  });

  it("builds one timeline with the subagent's steps in it", () => {
    const names = trace.steps.map((x) => x.name);
    expect(names[0]).toBe("Prompt");
    expect(trace.steps.find((x) => x.input === "pnpm test cart")?.sidechain).toBe(true);
    expect(trace.steps.map((x) => x.seq)).toEqual(trace.steps.map((_, i) => i + 1));
    expect(trace.steps.find((x) => x.kind === "subagent")?.input).toBe("Check the cart tests (qa)");
  });

  it("strips reminders and secrets from prompts", () => {
    const prompt = trace.steps[0].input;
    expect(prompt).not.toContain("ignore me");
    expect(prompt).not.toContain("sk_live_abcdefghijklmnop");
    expect(prompt).toContain("Make the promo check fail");
  });

  it("joins tool results to their calls", () => {
    const bash = trace.steps.find((x) => x.input === "pnpm test")!;
    expect(bash.isError).toBe(true);
    expect(bash.output).toContain("Cannot find module");
    expect(bash.durationMs).toBeGreaterThan(0);
    expect(s.toolErrors).toBe(2);
  });

  it("names a batch tool's failed step, not the steps before it that worked", async () => {
    const { signature } = await import("../src/core/issues.ts");
    const out = "[navigate] Navigated to https://x.test/a\n[computer:wait] Waited for 5 seconds\n\nactions[2] (find) failed: The accessibility tree does not contain a Run button";
    expect(signature(out)).toMatch(/^actions\[#\] \(find\) failed: the accessibility tree/i);
    expect(describeIssue({ kind: "tool_error", title: `browser_batch failed: ${signature(out)}` }).what).toBe("Browser element was not on the page");
    expect(signature("[vite] Internal server error: x is not defined")).toMatch(/^\[vite\] internal server error/i);
    expect(describeIssue({ kind: "tool_error", title: "Bash git failed: ! [rejected] main -> main (fetch first)" }).what).toBe("Git refused the operation");
    expect(describeIssue({ kind: "tool_error", title: "Bash node failed: typeerror: fetch failed getaddrinfo enotfound x.test" }).what).toBe("Could not reach the host");
  });

  it("leaves out time spent waiting for a person", () => {
    const b = { sessionId: "w", cwd: "/w", isSidechain: false };
    const lines = [
      { ...b, type: "user", timestamp: "2026-11-20T10:00:00.000Z", message: { role: "user", content: "go" } },
      { ...b, type: "assistant", timestamp: "2026-11-20T10:00:01.000Z", message: { id: "a", role: "assistant", content: [{ type: "tool_use", id: "q", name: "AskUserQuestion", input: { questions: [] } }] } },
      { ...b, type: "user", timestamp: "2026-11-20T10:20:00.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "q", content: "yes" }] } },
      { ...b, type: "assistant", timestamp: "2026-11-20T10:20:01.000Z", message: { id: "b", role: "assistant", content: [{ type: "tool_use", id: "r", name: "Read", input: { file_path: "/w/a" } }] } },
      { ...b, type: "user", timestamp: "2026-11-20T10:20:03.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "r", content: "x" }] } },
    ];
    const t = parseClaudeSession("w", lines.map((l) => JSON.stringify(l)).join("\n"), { person: "p" });
    expect(t.steps.find((x) => x.name === "AskUserQuestion")?.durationMs).toBeNull();
    expect(t.steps.find((x) => x.name === "Read")?.durationMs).toBe(2000);
  });

  it("records what the agent knew", () => {
    const refs = trace.memory.map((m) => `${m.source}:${m.op}:${m.ref}`);
    expect(refs).toContain("instructions:read:/work/shop/CLAUDE.md");
    expect(refs).toContain("instructions:read:/home/me/.claude/projects/shop/memory/MEMORY.md");
    expect(refs).toContain("file:read:/work/shop/CLAUDE.md");
    expect(refs).toContain("skill:read:testing");
    expect(refs).toContain("file:write:/home/me/.claude/projects/shop/memory/coupons.md");
    const claude = trace.memory.find((m) => m.source === "instructions" && m.ref.endsWith("CLAUDE.md"))!;
    expect(claude.preview).not.toContain("ops@example.com");
    for (const m of trace.memory) expect(m.seq).toBeGreaterThanOrEqual(0);
  });

  it("finds failures", () => {
    const kinds = trace.findings.map((f) => f.kind).sort();
    expect(kinds).toEqual(["interrupted", "permission_denied", "step_repetition", "tool_error"]);
  });

  it("tolerates an empty or broken transcript", () => {
    const t = parseClaudeSession("x", "not json\n\n", { person: "Ada" });
    expect(t.steps).toEqual([]);
    expect(t.session.title).toBe("Untitled session");
  });
});

describe("issues", () => {
  it("makes one signature for errors that differ only in paths, ids and numbers", () => {
    const a = signature("Exit code 1\nError: Cannot find module '/a/b/c.ts' at line 12");
    const b = signature("Exit code 1\nError: Cannot find module '/x/y/z.ts' at line 99");
    expect(a).toBe(b);
    expect(a).toContain("cannot find module");
  });

  it("does not repeat a finding within a session", () => {
    const step = (seq: number) => ({ seq, kind: "tool" as const, name: "Bash", input: `pnpm test ${seq}`, output: "Error: boom", isError: true, at: "", durationMs: 1, sidechain: false });
    const found = findIssues([step(1), step(2)]);
    expect(found.length).toBe(1);
    expect(found[0].title).toBe("Bash pnpm failed: error: boom");
  });

  it("prefers the line that reads like an error over command output", () => {
    expect(signature("Exit code 2\nfile1\nfile2\nls: nope: No such file or directory")).toBe("ls: nope: no such file or directory");
    expect(signature("Exit code 1\nlock posted")).toBe("exit code #");
  });

  it("names the program a command ran", () => {
    expect(program("cd /x && NODE_ENV=test pnpm vitest")).toBe("pnpm");
    expect(program("/usr/bin/git status")).toBe("git");
    expect(program("for f in *.ts; do wc -l $f; done")).toBe("wc");
    expect(program("set -e; python3 run.py")).toBe("python3");
    expect(program("if [ -f x ]; then cat x; fi")).toBe("cat");
    expect(program("P=$(grep '^P_DATABASE_URL=' .env | cut -d= -f2); psql \"$P\"")).toBe("psql");
    expect(program("-m1 foo")).toBe("sh");
  });

  it("counts repetition by the full input, not the stored summary", () => {
    const edit = (seq: number) => ({ seq, kind: "tool" as const, name: "Edit", input: "/a.ts", output: "ok", isError: false, at: "", durationMs: 1, sidechain: false });
    const steps = [edit(1), edit(2), edit(3)];
    expect(findIssues(steps, new Map([[1, "a"], [2, "b"], [3, "c"]]))).toEqual([]);
    expect(findIssues(steps, new Map([[1, "a"], [2, "a"], [3, "a"]]))[0].kind).toBe("step_repetition");
  });
});

describe("helpers", () => {
  it("shortens MCP tool names", () => {
    expect(shortToolName("mcp__github__create_issue")).toBe("github/create_issue");
    expect(shortToolName("mcp__1e7812ba-40d4-4812-a439-8fed59ebd7f6__harness_hub_search")).toBe("harness_hub_search");
    expect(shortToolName("Bash")).toBe("Bash");
  });

  it("describes tool input in one line", () => {
    expect(describeInput("Grep", { pattern: "foo", path: "src" })).toBe("foo  in src");
    expect(describeInput("Other", { a: 1 })).toBe('{"a":1}');
  });
});

describe("validateTrace", () => {
  const good = parseClaudeSession("sess-1", mainTranscript(), { person: "Ada" });

  it("accepts a parsed trace", () => {
    expect(validateTrace(JSON.parse(JSON.stringify(good))).steps.length).toBe(good.steps.length);
  });

  it("refuses malformed input", () => {
    expect(() => validateTrace(null)).toThrow(InvalidTrace);
    expect(() => validateTrace({ ...good, session: { ...good.session, id: "../etc" } })).toThrow(/session.id/);
    expect(() => validateTrace({ ...good, session: { ...good.session, outcome: "great" } })).toThrow(/outcome/);
    expect(() => validateTrace({ ...good, steps: "x" })).toThrow(/lists/);
  });
});

describe("error lines from command output", () => {
  it("skips file content and takes the error report", () => {
    const out = "Exit code 1\n# Rules\n- **mandatory: before any push** run the tests\n| a | b |\nsed: 1: \"s/x/\": unterminated substitute pattern";
    expect(signature(out)).toBe("sed: #: <…>: unterminated substitute pattern");
  });

  it("uses a tool's own error message as it is", () => {
    expect(signature("<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>")).toContain("file has not been read yet");
  });

  it("falls back to the exit code when nothing reads like an error", () => {
    expect(signature("Exit code 1\n- a list item that mentions an error\n## blocked heading")).toBe("exit code #");
  });

  it("summarises a tool input without a known field by its first text", () => {
    expect(describeInput("update_plan", { items: [{ content: "Look at the pipeline", status: "in_progress" }] })).toBe("Look at the pipeline");
  });
});

describe("grep and compiler output", () => {
  it("does not take grep -n matches for errors, but takes compiler errors", () => {
    expect(signature("Exit code 1\n12:  const { error: signInError } = await auth()\n40:  if (error) throw error")).toBe("exit code #");
    expect(signature("Exit code 2\nsrc/a.ts:12:3: error TS2304: Cannot find name 'x'.")).toContain("error ts#");
    expect(signature("Exit code 1\n(eval):1: no matches found: vitest*.*")).toContain("no matches found");
  });
});

it("names a Python traceback by its exception", () => {
  expect(signature('Exit code 1\nTraceback (most recent call last):\n  File "x.py", line 3, in <module>\n    d["k"]\nKeyError: \'k\'')).toBe("keyerror: <…>");
});
