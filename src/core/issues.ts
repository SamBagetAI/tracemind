/**
 * Finds failures in a session's steps. Each finding has a key; the same key in many sessions is one issue.
 * Deliberately simple rules, no model: a tool that failed, a refused permission, the same call
 * repeated, a person stopping the agent.
 */
import type { Finding, IssueKind, Step } from "./types.ts";

const PERMISSION =
  /permission|denied|not allowed|blocked|unauthori[sz]ed|forbidden|not authenticated|EACCES|EPERM|rejected|doesn't want to proceed/i;
const ERROR_LINE =
  /error|failed|failure|cannot|can't|could not|couldn't|not found|no such|denied|refused|blocked|fatal|exception|invalid|unknown|unexpected|timed? ?out|missing|not allowed|unauthori|forbidden|rejected|doesn't want/i;
const REPEAT_LIMIT = 3;
const SIG_MAX = 60;

function normalize(line: string): string {
  return line
    .replace(/\[redacted[^\]]*\]/g, "…")
    .replace(/(?:\/[\w.@~+-]+){2,}\/?/g, "<path>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<id>")
    .replace(/"[^"]{1,200}"|'[^']{1,200}'|`[^`]{1,200}`/g, "<…>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * The line of an error that says what went wrong, with the parts that change between runs taken
 * out. Command output often comes before the error, so a line that reads like an error wins over
 * the first line; with none, the exit code stands for the error.
 */
/** Lines that are file or command content, not an error: list items, headings, tables, quotes, comments, numbered file lines. */
const CONTENT_LINE = /^(?:[-*+>|#]\s|[-*+>|#]{2,}|\d+[.)]\s|\d+\t|`{3}|\/\/|<!--|\*\*|\[[^\]]*\]\()/;
/**
 * A batch tool's report of a step that worked: "[navigate] Navigated to …", "[computer:wait] Waited
 * for 5 seconds", "[computer:left_click] left_click at (…)". Shaped narrowly, so "[vite] Internal
 * server error" or "[ERROR] …" still count as errors.
 */
const PROGRESS_LINE = /^\[[\w-]+(?::[\w-]+)?\] \w+ (?:to|for|at)\b/i;

/**
 * A line that reports an error in the usual shapes: "Error: …" or "fatal: …"; a program name
 * then a message ("ls: x: No such file", "sed: 1: …", "zsh:1: …", "(eval):1: …"); or a file
 * location followed by error/warning ("src/a.ts:12:3: error TS2304"). Not "12: const { error }"
 * from grep -n, and not "src/a.ts:12: code".
 */
const ERROR_WORDS =
  /(?:error|not found|no such|denied|invalid|unknown|cannot|can't|failed|refused|timed out|permission|no matches|not permitted|is not|unterminated|unexpected|illegal|bad |missing|unrecognized|usage)/i;
/** grep -n matches ("12:" or "src/a.ts:12:") and lines of code are output, not an error. */
const CODE_LINE = /^(?:\d+[:-]|[\w./-]+:\d+[:-])|[{};]|=>|\)\s*\{|\bconst\b|\bif\s*\(/;

function isErrorReport(line: string): boolean {
  if (/^(?:error|fatal|panic|exception|npm err!?|err!|e\d{3,}\b|\w*(?:error|exception)\b[:\s])/i.test(line)) return true;
  // A batch tool's failed step: "actions[2] (find) failed: …".
  if (/^actions\[\d+\] \([^)]*\) failed:/i.test(line)) return true;
  const named = /^(?:\(eval\)|[a-z][\w.-]{0,30})(?::\s?\d+)*: (.*)$/i.exec(line);
  if (named && ERROR_WORDS.test(named[1])) return true;
  return /^[\w./-]+:\d+(?::\d+)?:?\s*(?:error|fatal|warning)\b/i.test(line);
}

/**
 * The line of an error that says what went wrong, with the parts that change between runs taken
 * out. A tool's own error message is used as it is. Otherwise command output often holds file
 * contents before the error, so content lines are skipped, a line shaped like an error report wins,
 * then the last error-like line (errors come at the end), then the exit code.
 */
export function signature(output: string): string {
  const toolError = /<tool_use_error>([\s\S]*?)<\/tool_use_error>/.exec(output);
  const text = toolError ? toolError[1] : output;
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^node:internal/.test(l) && !/^at\s/.test(l) && !/^\^+$/.test(l));
  const exit = lines.find((l) => /^exit code \d+$/i.test(l));
  const candidates = lines.filter((l) => !/^exit code \d+$/i.test(l) && !CONTENT_LINE.test(l) && !PROGRESS_LINE.test(l));
  // A Python traceback says what happened on its last line ("KeyError: 'x'").
  const traceback = !toolError && candidates.some((l) => /^Traceback \(most recent call last\)/.test(l));
  const chosen = traceback
    ? candidates[candidates.length - 1]
    : toolError
    ? (candidates[0] ?? lines[0] ?? "")
    : (candidates.find(isErrorReport) ??
      // Errors come at the end; earlier lines are usually output (grep matches, file contents).
      candidates.slice(-3).reverse().find((l) => ERROR_LINE.test(l) && !CODE_LINE.test(l)) ??
      exit ??
      candidates[0] ??
      lines[0] ??
      "");
  const n = normalize(chosen);
  return n.length > SIG_MAX ? `${n.slice(0, SIG_MAX)}…` : n;
}

/** Words whose whole segment is set-up or a loop/test header, not a program running. */
const SKIP_SEGMENT = new Set([
  "cd", "export", "set", "unset", "local", "declare", "readonly", "source", ".", "return", "break", "continue",
  "for", "while", "until", "if", "elif", "case", "function", "[", "[[", "test", "true", "false", "EOF",
]);
/** Words that come before the program in the same segment. */
const SKIP_WORD = new Set(["then", "else", "do", "done", "fi", "esac", "!", "{", "}", "time", "sudo", "env", "nohup", "exec", "eval"]);

/**
 * The program a shell command ran: the first word that names a program, skipping `cd`, variable
 * assignments, control flow (`for`, `if`, `while`), flags and quoted text. "sh" when there is none.
 */
export function program(command: string): string {
  // What runs inside $(…) or `…` only feeds the real command.
  let text = command.replace(/`[^`]*`/g, "");
  for (let i = 0; i < 5 && /\$\([^()]*\)/.test(text); i++) text = text.replace(/\$\([^()]*\)/g, "");
  for (const segment of text.split(/&&|\|\||;|\||\n/)) {
    for (const raw of segment.trim().split(/\s+/)) {
      const w = raw.replace(/^[({]+/, "");
      if (!w || SKIP_WORD.has(w)) continue;
      if (SKIP_SEGMENT.has(w)) break;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue; // VAR=value
      if (/^[-'"$<>`#\\*?^]|[=()]/.test(w)) break; // a flag, quoted text, a variable or a redirect: not a program here
      if (!/^[\w./@+-]+$/.test(w)) break;
      return w.split("/").pop() || w;
    }
  }
  return "sh";
}

function finding(kind: IssueKind, key: string, title: string, seq: number): Finding {
  return { kind, key: `${kind}:${key}`, title, seq };
}

/**
 * `fingerprints` holds each tool call's full input by step number, so repetition means the same
 * call, not the same file (the stored input of an edit is only its path).
 */
export function findIssues(steps: Step[], fingerprints: Map<number, string> = new Map()): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  const add = (f: Finding) => {
    if (seen.has(f.key)) return;
    seen.add(f.key);
    out.push(f);
  };

  let run: { name: string; input: string; count: number; seq: number } | null = null;

  for (const s of steps) {
    if (s.kind === "interrupt") add(finding("interrupted", "user", "A person stopped the agent", s.seq));

    if (s.kind !== "tool" && s.kind !== "subagent") continue;

    if (s.isError) {
      const sig = signature(s.output) || "failed";
      const kind: IssueKind = PERMISSION.test(s.output) ? "permission_denied" : "tool_error";
      const tool = s.name === "Bash" ? `Bash ${program(s.input)}` : s.name;
      const title = kind === "permission_denied" ? `${tool} was refused: ${sig}` : `${tool} failed: ${sig}`;
      add(finding(kind, `${tool}:${sig}`, title, s.seq));
    }

    const input = fingerprints.get(s.seq) ?? s.input;
    if (run && run.name === s.name && run.input === input) {
      run.count++;
      if (run.count === REPEAT_LIMIT) {
        add(finding("step_repetition", s.name, `${s.name} called with the same input ${REPEAT_LIMIT}+ times in a row`, run.seq));
      }
    } else {
      run = { name: s.name, input, count: 1, seq: s.seq };
    }
  }
  return out;
}

export const KIND_LABEL: Record<IssueKind, string> = {
  tool_error: "Tool error",
  permission_denied: "Permission refused",
  step_repetition: "Step repetition",
  interrupted: "Stopped by a person",
};
