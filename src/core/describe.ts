/**
 * Issues in words a person uses, and grouped by cause. Shared by the server (which counts
 * sessions per group) and the web UI (which shows them), so both always agree.
 */

import type { IssueKind } from "./types.ts";

export type { IssueKind };

export const KIND: Record<IssueKind, string> = {
  tool_error: "Tool error",
  permission_denied: "Refused",
  step_repetition: "Repeated step",
  interrupted: "Stopped",
};

/** Known error signatures, said the way a person would. Order matters: the first match wins. */
/**
 * Causes other code acts on by name (fixes, the brief, advice). Named here once, so rewording one
 * cannot quietly switch those off.
 */
export const CAUSE = {
  classifier: "Refused by the auto-mode classifier",
  sleep: "Waited with sleep, which is blocked",
  exitCode: "Exited with an error code",
  unread: "Edited a file before reading it",
  changedSinceRead: "Edited a file that changed since it was read",
  textNotFound: "Text to replace was not in the file",
  notSignedIn: "Not signed in to the service",
  safetyCheck: "Refused by a built-in safety check",
  stopped: "Stopped by a person",
  repeated: "Same call repeated 3+ times in a row",
} as const;

/** How a sentence names an error that has no plain name yet. */
export const UNNAMED = "an error without a name yet";

const PLAIN: [RegExp, string][] = [
  [/denied by the claude code aut|auto mode classifier/i, CAUSE.classifier],
  [/blocked: sleep/i, CAUSE.sleep],
  [/^exit code #$/i, CAUSE.exitCode],
  [/file has not been read yet/i, CAUSE.unread],
  [/modified since read/i, CAUSE.changedSinceRead],
  [/string to replace not found/i, CAUSE.textNotFound],
  [/inputvalidationerror/i, "Called with input it does not accept"],
  [/hook error/i, "Blocked by a hook"],
  [/doesn't want to proceed|user rejected|rejected by (?:the )?user/i, "Rejected by the person"],
  [/no such tool available/i, "Called a tool that is not available"],
  [/unauthori[sz]ed|not authenticated|please run <…> again/i, CAUSE.notSignedIn],
  [/denied by a built-in|built-in claude code safety/i, CAUSE.safetyCheck],
  [/no matches found/i, "Shell pattern matched no files"],
  [/neondberror|sqlstate|(?:column|relation|table|role|database|schema|function) [^\n]{0,60}does not exist/i, "Database query failed"],
  [/\(eval\):#?\d*:? ?=+ not found/i, "zsh read == as a command"],
  [/invalid command code/i, "sed -i written the GNU way on macOS"],
  [/illegal (?:option|line count)|invalid option|unrecognized option/i, "Used a flag the macOS tool does not have"],
  [/accessibility tree|no element found|ref is stale|not present in the accessib|outside the viewport|element coordinates|ref_# is|element may have/i, "Browser element was not on the page"],
  [/no tab available|no preview is open|preview not found|preview tab .* no l|preview_stop takes|in use by preview|no \.claude\/launch\.json/i, "Browser preview was not ready"],
  [/chrome:\/\/|local file, not a web page|cannot access a chrome/i, "Browser tool used on a page it cannot read"],
  [/navigation to .*(?:denied|failed)|\(navigate\) failed|safety category|security check failed|navigated to a different dom/i, "Browser navigation was blocked"],
  [/err_module_not_found|cannot find (?:module|package)/i, "Module not found"],
  [/jsondecodeerror|unexpected token .* in json|is not valid json/i, "Could not parse JSON"],
  [/enotfound|getaddrinfo|could not resolve host/i, "Could not reach the host"],
  [/typeerror|referenceerror|indexerror|keyerror|valueerror|attributeerror|nameerror|patternerror|is not a function|capturestacktrace/i, "A script raised an error"],
  [/isolated in the worktree|already used by worktree/i, "Worked outside its git worktree"],
  [/transform failed|error ts#|error ts\d/i, "Build or type check failed"],
  [/connection string|could not connect to (?:the )?(?:server|database)/i, "Not connected to the database"],
  [/failed to push|cannot pull with rebase|\[rejected\]|auto.merge/i, "Git refused the operation"],
  [/(?:command|learn command|catalog) is not available|not available for th/i, "Asked for a command that is not available"],
  [/has no (?:saved|version)|no saved .* with/i, "Asked for something that does not exist"],
  [/no such file or directory|enoent|(?:file|folder|directory|path)[^\n]{0,60}does not exist/i, "File or folder not found"],
  [/command not found/i, "Command not found"],
  [/timed? ?out|did not respond in time|aborterror/i, "Timed out"],
  [/uncaught|unhandled|exception/i, "Crashed with an exception"],
  [/no text content found/i, "Page had no readable text"],
  [/not in .*tab group/i, "Used a browser tab it does not own"],
  [/screenshot/i, "Could not take a screenshot"],
  [/is not fully merged/i, "Branch is not fully merged"],
  [/syntax ?error|parse error/i, "Syntax error"],
];

export type Described = { tool: string; what: string; raw: string; plain: boolean };

/** Splits a stored title ("Bash git failed: exit code #") into the tool and what went wrong. */
export function describeIssue(issue: { kind: IssueKind; title: string }): Described {
  if (issue.kind === "interrupted") return { tool: "", what: CAUSE.stopped, raw: issue.title, plain: true };
  const m = /^(.*?) (?:failed|was refused|was blocked|was rejected|called with the same input .*)(?:: (.*))?$/.exec(issue.title);
  const tool = m?.[1] ?? "";
  const sig = m?.[2] ?? issue.title;
  if (issue.kind === "step_repetition") return { tool, what: CAUSE.repeated, raw: issue.title, plain: true };
  for (const [re, text] of PLAIN) if (re.test(sig)) return { tool, what: text, raw: sig, plain: true };
  // Not a known error: the error's own first words, cleaned up, and marked as such.
  const cleaned = sig.replace(/<…>/g, "…").replace(/<id>|<path>/g, "…").replace(/#/g, "N").replace(/\s+…$/, "…");
  const sentence = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  return { tool, what: sentence.length > 70 ? `${sentence.slice(0, 68).trimEnd()}…` : sentence, raw: sig, plain: false };
}

/**
 * The cause an issue belongs to. A named cause is one cause whatever kind it was filed under
 * (CAUSE.classifier can come back as a refusal or as a tool's error); an
 * unnamed one keeps its kind. Pass `d` when the issue was already described, to skip doing it twice.
 */
export function causeKey(issue: { kind: IssueKind; title: string }, d = describeIssue(issue)): string {
  return d.plain ? d.what : `${issue.kind}|${d.what}`;
}

/** The tool family for display: "Bash git" → "git", "claude-in-chrome/navigate" → "navigate". */
export function toolLabel(tool: string): string {
  if (tool.startsWith("Bash ")) return tool.slice(5);
  return tool.includes("/") ? tool.split("/").pop()! : tool;
}

/** Up to `max` tools, the most frequent first, then "+N". */
export function topTools(tools: { tool: string; sessions: number }[], max = 3): string {
  const merged = new Map<string, number>();
  for (const t of tools) if (t.tool) merged.set(toolLabel(t.tool), (merged.get(toolLabel(t.tool)) ?? 0) + t.sessions);
  const sorted = [...merged.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  const shown = sorted.slice(0, max).join(", ");
  return sorted.length > max ? `${shown} +${sorted.length - max}` : shown;
}

/**
 * The name people recognise for a project: a routine by its name (which may hold a slash), a
 * folder by its last part, a worktree as repo · worktree.
 */
export function projectName(path: string): string {
  if (path.startsWith("routines/")) return path.slice("routines/".length);
  const parts = path.split("/").filter(Boolean);
  const wt = parts.indexOf("worktrees");
  if (wt >= 2 && parts[wt - 1] === ".claude") return `${parts[wt - 2]} · ${parts[parts.length - 1]}`;
  if (parts.includes("scratch-workspaces")) return "scratch";
  return parts[parts.length - 1] ?? path;
}

/**
 * A session's findings, one per cause, at the first step that hit it: what the session's issues
 * are. `issues` gives each finding's cause (by issue key); a finding without one is its own cause.
 */
export function findingsByCause<F extends { key: string }>(findings: F[], issues: Record<string, { cause?: string } | undefined>): F[] {
  const out = new Map<string, F>();
  for (const f of findings) {
    const k = issues[f.key]?.cause ?? f.key;
    if (!out.has(k)) out.set(k, f);
  }
  return [...out.values()];
}

/** The instruction files a session loaded at its start, each once. */
export function startFiles<M extends { source: string; ref: string }>(memory: M[]): M[] {
  return [...new Map(memory.filter((m) => m.source === "instructions").map((m) => [m.ref, m])).values()];
}

export type Variant = { message: string; tools: string[]; commands: number; sessions: number };

/**
 * A cause's variants grouped by what they said, so the same error from cat and from node is one
 * line naming both tools: grouped by the normalized signature, shown as one of them actually said
 * it (`messages`, by issue key). Most commands first; sessions are not added up across variants,
 * which would count a session twice.
 */
export function variantsByMessage(
  issues: { key: string; kind: IssueKind; title: string; tool: string; windowSessions?: number }[],
  messages: Record<string, string> = {},
): Variant[] {
  const by = new Map<string, { message: string; tools: Set<string>; commands: number; sessions: number }>();
  for (const i of issues) {
    const sig = describeIssue(i).raw;
    const e = by.get(sig) ?? { message: messages[i.key] || sig, tools: new Set<string>(), commands: 0, sessions: 0 };
    e.tools.add(toolLabel(i.tool) || i.tool);
    e.commands++;
    e.sessions = Math.max(e.sessions, i.windowSessions ?? 0);
    by.set(sig, e);
  }
  return [...by.values()]
    .map((e) => ({ ...e, tools: [...e.tools] }))
    .sort((a, b) => b.commands - a.commands || b.sessions - a.sessions);
}
