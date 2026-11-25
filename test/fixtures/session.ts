/** A small made-up Claude Code transcript with the line types Tracemind reads. */

const base = { sessionId: "sess-1", cwd: "/work/shop", gitBranch: "fix-promo", version: "2.1.0", isSidechain: false };
let t = Date.parse("2026-11-20T10:00:00.000Z");
const at = (s = 1) => new Date((t += s * 1000)).toISOString();

const user = (content: unknown, extra: object = {}) => ({ ...base, type: "user", timestamp: at(), message: { role: "user", content }, ...extra });
const assistant = (id: string, content: unknown[], usage = { input_tokens: 10, output_tokens: 5 }) => ({
  ...base,
  type: "assistant",
  timestamp: at(),
  message: { id, model: "claude-opus-5-5", role: "assistant", content, usage },
});
const toolUse = (id: string, name: string, input: object) => ({ type: "tool_use", id, name, input });
const result = (id: string, content: string, is_error = false) => ({ type: "tool_result", tool_use_id: id, content, is_error });

export function mainTranscript(): string {
  const lines = [
    { type: "custom-title", customTitle: "Fix promo code check", sessionId: "sess-1" },
    {
      ...base,
      type: "attachment",
      timestamp: at(),
      attachment: {
        type: "instructions",
        files: [
          { path: "/work/shop/CLAUDE.md", type: "Project", content: "Run pnpm test before you commit. Contact ops@example.com." },
          { path: "/home/me/.claude/projects/shop/memory/MEMORY.md", type: "AutoMem", content: "- promo codes live in coupons.ts" },
        ],
      },
    },
    user("<system-reminder>ignore me</system-reminder>Make the promo check fail when no discount is applied. key sk_live_abcdefghijklmnop"),
    assistant("m1", [{ type: "thinking", thinking: "hmm" }, toolUse("t1", "Read", { file_path: "/work/shop/CLAUDE.md" })]),
    user([result("t1", "Run pnpm test before you commit.")]),
    // The same message id is written on two lines; its usage must count once.
    assistant("m2", [toolUse("t2", "Bash", { command: "pnpm test" })], { input_tokens: 100, output_tokens: 20 }),
    assistant("m2", [{ type: "text", text: "Running the tests." }], { input_tokens: 100, output_tokens: 20 }),
    user([result("t2", "Exit code 1\nError: Cannot find module '/work/shop/src/coupons.ts'", true)]),
    assistant("m3", [toolUse("t3", "Bash", { command: "ls src" })]),
    user([result("t3", "a.ts")]),
    assistant("m4", [toolUse("t4", "Bash", { command: "ls src" })]),
    user([result("t4", "a.ts")]),
    assistant("m5", [toolUse("t5", "Bash", { command: "ls src" })]),
    user([result("t5", "a.ts")]),
    assistant("m6", [toolUse("t6", "Skill", { skill: "testing", args: "" })]),
    user([result("t6", "loaded")]),
    assistant("m7", [toolUse("t7", "Edit", { file_path: "/home/me/.claude/projects/shop/memory/coupons.md", old_string: "a", new_string: "coupons are in src/promo" })]),
    user([result("t7", "ok")]),
    assistant("m8", [toolUse("t8", "Agent", { description: "Check the cart tests", subagent_type: "qa" })]),
    user([result("t8", "All cart tests pass.")]),
    assistant("m9", [toolUse("t9", "Bash", { command: "git push" })]),
    user([result("t9", "Permission for this action was denied by the auto mode classifier.", true)]),
    { ...base, type: "system", subtype: "stop_hook_summary", timestamp: at() },
    user([{ type: "text", text: "[Request interrupted by user]" }]),
    "{ this line is broken",
  ];
  return lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");
}

export function subagentTranscript(): string {
  const side = { ...base, isSidechain: true };
  t -= 20_000; // the subagent ran in the middle of the main session
  const lines = [
    { ...side, type: "user", timestamp: at(), message: { role: "user", content: "Check the cart tests" } },
    { ...side, type: "assistant", timestamp: at(), message: { id: "s1", model: "claude-haiku-5-5", content: [toolUse("x1", "Bash", { command: "pnpm test cart" })], usage: { input_tokens: 1, output_tokens: 1 } } },
    { ...side, type: "user", timestamp: at(), message: { role: "user", content: [result("x1", "3 passed")] } },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n");
}
