/**
 * Suggestions: what to change in how Claude is used, made from what keeps going wrong. Each one
 * says why (counts and example sessions) and carries one action:
 *
 * - "rule":    add a line to an instruction file (global CLAUDE.md or a project's CLAUDE.md/AGENTS.md)
 * - "routine": add a Claude Code hook that tells every new session what keeps going wrong in its project
 * - "prompt":  a ready prompt to hand to Claude, for changes that need a person or judgment
 *              (signing a connector in, trimming a file, finding out why something keeps failing)
 * - "tip":     a habit, nothing to apply
 *
 * Applying only happens in local mode, on files this module picks (never a path from the
 * request), after a preview, with a backup and an exact undo. Once applied, the page shows how
 * often the problem happened before and since.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { hasHook, setHook } from "../cli/claude.ts";
import type { Row } from "../store/db.ts";
import { issueGroups, type IssueGroup } from "../store/insights.ts";
import type { Store } from "../store/store.ts";

const DAY = 86400000;
/** Tag on the routine's hook command (a shell comment), so it can be found again whatever the path. */
const CONTEXT_MARKER = "tracemind-context";
const tagged = (command: string) => `${command} # ${CONTEXT_MARKER}`;

export type Action =
  | { type: "rule"; file: string; scope: "global" | "project"; text: string }
  | { type: "routine"; event: "SessionStart"; command: string }
  | { type: "prompt"; text: string }
  | { type: "tip" };

export type Suggestion = {
  id: string;
  kind: "rule" | "routine" | "connect" | "trim" | "investigate" | "tip";
  title: string;
  why: string;
  /** Sessions in the window the problem showed up in. */
  sessions: number;
  examples: { id: string; title: string; seq: number | null }[];
  /** Causes (issue groups) this suggestion is meant to stop, for the before/since numbers. */
  causes: string[];
  /** The issue it is about, to link to: the most frequent issue of its first cause. */
  issue: { key: string; num: number; what: string; sessions: number } | null;
  action: Action;
  status: "open" | "applied" | "dismissed";
  at: string | null;
  /** After it was applied: sessions that hit the causes, before (30 days) and since. */
  effect: { before: { sessions: number; hit: number }; since: { sessions: number; hit: number } } | null;
};

const home = () => process.env.TRACEMIND_CLAUDE_HOME_DIR ?? homedir();
const globalClaudeMd = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(home(), ".claude"), "CLAUDE.md");

/** The repository a session ran in: worktrees count as their main checkout; scratch folders do not count. */
export function projectRoot(path: string): string | null {
  if (!path || /\/(?:scratch-workspaces|scratchpad)\//.test(path) || path.startsWith("/private/tmp") || path.startsWith("/tmp")) return null;
  return path.split("/.claude/worktrees/")[0];
}

/** The instruction file a project's agents read: CLAUDE.md if there is one, else AGENTS.md, else a new CLAUDE.md. */
function projectInstructionFile(root: string): string {
  for (const f of ["CLAUDE.md", "AGENTS.md"]) if (existsSync(join(root, f))) return join(root, f);
  return join(root, "CLAUDE.md");
}

const sid = (...parts: string[]) => createHash("sha1").update(parts.join("\n")).digest("hex").slice(0, 12);

function byWhat(groups: IssueGroup[], what: string) {
  return groups.find((g) => g.what === what);
}

/** The latest sessions that hit any of the issues, each session once, at its first such step. */
async function examplesFor(store: Store, ws: string, keys: string[], limit = 3) {
  if (keys.length === 0) return [];
  const rows = await store.db.all<Row>(
    `SELECT s.id, s.title, MIN(f.seq) AS seq, MAX(s.ended_at) AS ended FROM findings f JOIN sessions s ON s.workspace = f.workspace AND s.id = f.session_id
      WHERE f.workspace = ? AND f.key IN (${keys.map(() => "?").join(", ")}) GROUP BY s.id, s.title ORDER BY ended DESC LIMIT ?`,
    [ws, ...keys, limit],
  );
  return rows.map((r) => ({ id: String(r.id), title: String(r.title), seq: Number(r.seq) }));
}

/** Everything the rules below look at, in one place. */
async function facts(store: Store, ws: string, days: number) {
  const since = new Date(Date.now() - days * DAY).toISOString();
  const groups = await issueGroups(store, ws, since);
  const sessions = await store.db.all<Row>("SELECT id, project, title FROM sessions WHERE workspace = ? AND started_at >= ?", [ws, since]);
  const prodReads = await store.db.all<Row>(
    `SELECT s.project, st.session_id, st.seq, st.input, s.title FROM steps st JOIN sessions s ON s.workspace = st.workspace AND s.id = st.session_id
      WHERE st.workspace = ? AND s.started_at >= ? AND st.is_error = 1
        AND (st.output LIKE '%[Production Reads]%' OR st.output LIKE '%[Credential Materialization]%' OR st.output LIKE '%[PII Data Handling]%')`,
    [ws, since],
  );
  const compactions = await store.db.all<Row>(
    `SELECT s.project, COUNT(DISTINCT st.session_id) AS sessions FROM steps st JOIN sessions s ON s.workspace = st.workspace AND s.id = st.session_id
      WHERE st.workspace = ? AND s.started_at >= ? AND st.kind = 'compact' GROUP BY s.project`,
    [ws, since],
  );
  const [interrupts] = await store.db.all<Row>(
    `SELECT CAST(COUNT(*) AS INTEGER) AS n, CAST(COUNT(DISTINCT s.session_id) AS INTEGER) AS sessions FROM steps s JOIN steps p
        ON p.workspace = s.workspace AND p.session_id = s.session_id AND p.seq = s.seq - 1
      WHERE s.workspace = ? AND s.kind = 'interrupt' AND p.kind = 'prompt' AND s.at >= ?`,
    [ws, since],
  );
  return { since, groups, sessions, prodReads, compactions, interrupts: { n: Number(interrupts?.n ?? 0), sessions: Number(interrupts?.sessions ?? 0) } };
}

/** Rules that hold everywhere, keyed by the cause they prevent. */
const GLOBAL_RULES: { what: string; title: string; text: string; min: number }[] = [
  {
    what: "Waited with sleep, which is blocked",
    title: "Stop agents from waiting with sleep",
    text: "To wait for something, run the command in the background or watch for it with Monitor; never use `sleep`, which is blocked.",
    min: 3,
  },
  {
    what: "Edited a file before reading it",
    title: "Read files before editing them",
    text: "Read a file in this conversation before editing or overwriting it.",
    min: 3,
  },
  {
    what: "Text to replace was not in the file",
    title: "Edit from a fresh read",
    text: "Copy the text to replace from a fresh Read of the file; when an Edit fails, read the file again instead of retrying the same edit.",
    min: 3,
  },
  {
    what: "Edited a file that changed since it was read",
    title: "Re-read files that changed",
    text: "When a file changed since you read it, read it again before editing it.",
    min: 3,
  },
];

export async function buildSuggestions(store: Store, ws: string, local: boolean, days = 90): Promise<Suggestion[]> {
  const WINDOW_DAYS = days;
  const f = await facts(store, ws, days);
  const out: Omit<Suggestion, "status" | "at" | "effect" | "issue">[] = [];
  const covered = new Set<string>();

  // 1. Global rules for causes that happen across projects.
  for (const rule of GLOBAL_RULES) {
    const g = byWhat(f.groups, rule.what);
    if (!g || g.sessions < rule.min) continue;
    covered.add(g.id);
    out.push({
      id: sid("rule", rule.what),
      kind: "rule",
      title: rule.title,
      why: `"${g.what}" happened in ${g.sessions} sessions in the last ${WINDOW_DAYS} days${g.tools ? ` (${g.tools})` : ""}.`,
      sessions: g.sessions,
      examples: await examplesFor(store, ws, g.issues.map((i) => i.key)),
      causes: [g.id],
      action: { type: "rule", file: globalClaudeMd(), scope: "global", text: rule.text },
    });
  }

  // 2. Production data, per project: the classifier keeps refusing it.
  const byProject = new Map<string, Row[]>();
  for (const r of f.prodReads) {
    const root = projectRoot(String(r.project));
    if (root) byProject.set(root, [...(byProject.get(root) ?? []), r]);
  }
  for (const [root, rows] of byProject) {
    const sessions = new Set(rows.map((r) => String(r.session_id)));
    if (sessions.size < 2) continue;
    const vars = [...new Set(rows.flatMap((r) => String(r.input).match(/\b[A-Z][A-Z0-9_]*(?:DATABASE_URL|_DSN|_URI)\b/g) ?? []))].slice(0, 3);
    const named = vars.length ? ` (for example ${vars.map((v) => `\`${v}\``).join(", ")} in \`.env\` files)` : "";
    const refused = f.groups.find((g) => g.what === "Refused by the auto-mode classifier");
    out.push({
      id: sid("prod", root),
      kind: "rule",
      title: `Keep agents in ${basename(root)} away from production data`,
      why: `The auto-mode classifier refused ${rows.length} attempts to read production data or credentials in ${sessions.size} sessions in ${basename(root)}; each refusal is a wasted turn and a retry.`,
      sessions: sessions.size,
      examples: [...new Map(rows.map((r) => [String(r.session_id), { id: String(r.session_id), title: String(r.title), seq: Number(r.seq) }])).values()].slice(0, 3),
      causes: refused ? [refused.id] : [],
      action: {
        type: "rule",
        file: projectInstructionFile(root),
        scope: "project",
        text: `Never read production data or production credentials${named}. When a task needs production data, stop and ask the person for it.`,
      },
    });
  }

  // 3. Connectors that are not signed in.
  const signIn = byWhat(f.groups, "Not signed in to the service");
  if (signIn) {
    covered.add(signIn.id);
    const servers = new Map<string, { sessions: number; keys: string[] }>();
    for (const i of signIn.issues) {
      const server = i.tool.includes("/") ? i.tool.split("/")[0] : null;
      if (!server) continue;
      const e = servers.get(server) ?? { sessions: 0, keys: [] };
      e.sessions = Math.max(e.sessions, i.windowSessions);
      e.keys.push(i.key);
      servers.set(server, e);
    }
    for (const [server, e] of servers) {
      if (e.sessions < 2) continue;
      out.push({
        id: sid("connect", server),
        kind: "connect",
        title: `Sign in to the ${server} connector`,
        why: `Calls to ${server} failed because it was not signed in, in at least ${e.sessions} sessions. Every session that needs it starts with a failure.`,
        sessions: e.sessions,
        examples: await examplesFor(store, ws, e.keys),
        causes: [signIn.id],
        action: {
          type: "prompt",
          text: `The ${server} MCP connector keeps failing because it is not signed in. Help me sign it in: tell me exactly what to run (for example /mcp, then pick ${server} and authenticate), wait for me to do it, then call one read-only ${server} tool to check it works. If no project of mine needs ${server}, tell me how to remove it instead.`,
        },
      });
    }
  }

  // 4. Instruction files so large that sessions run out of context.
  if (local) {
    for (const r of f.compactions) {
      const root = projectRoot(String(r.project));
      if (!root || Number(r.sessions) < 3) continue;
      const file = projectInstructionFile(root);
      if (!existsSync(file)) continue;
      const size = statSync(file).size;
      if (size < 8000) continue;
      const kb = Math.round(size / 1024);
      out.push({
        id: sid("trim", file),
        kind: "trim",
        title: `Trim ${basename(root)}/${basename(file)}`,
        why: `It is ${kb} KB and is loaded on every turn, and ${r.sessions} sessions in ${basename(root)} ran out of context and had to be compacted.`,
        sessions: Number(r.sessions),
        examples: [],
        causes: [],
        action: {
          type: "prompt",
          text: `${file} is ${kb} KB and Claude loads it on every turn; ${r.sessions} recent sessions in this project ran out of context. Make it shorter without losing anything an agent needs on every turn: keep rules and commands, move reference material (long explanations, history, examples) into separate files under docs/ that it links to, and remove what is out of date or repeated. Show me the diff before saving.`,
        },
      });
    }
  }

  // 5. A routine: tell every new session what keeps going wrong in its project.
  const recurring = f.groups.filter((g) => g.sessions >= 3 && g.kind !== "interrupted");
  if (recurring.length >= 2) {
    out.push({
      id: sid("routine", "context"),
      kind: "routine",
      title: "Brief new sessions on their project's known problems",
      why: `${recurring.length} issues happened in 3 or more sessions each. A Claude Code hook can give each new session the ones from its own project, with what to do instead, before it starts.`,
      sessions: Math.max(...recurring.map((g) => g.sessions)),
      examples: [],
      causes: recurring.slice(0, 5).map((g) => g.id),
      action: { type: "routine", event: "SessionStart", command: "" },
    });
  }

  // 6. Recurring causes no rule covers: hand them to Claude to find out why.
  // Not worth an investigation: a bare exit code is mostly grep or test finding nothing.
  const notWorth = new Set(["Refused by the auto-mode classifier", "Exited with an error code", "Refused by a built-in safety check"]);
  for (const g of f.groups.filter((g) => g.sessions >= 5 && !covered.has(g.id) && g.kind !== "interrupted" && !notWorth.has(g.what)).slice(0, 3)) {
    const ex = await examplesFor(store, ws, g.issues.map((i) => i.key), 3);
    out.push({
      // Keyed by kind and name, as cause ids were before named causes merged across kinds, so a fix
      // someone dismissed stays dismissed.
      id: sid("investigate", `${g.kind}|${g.what}`),
      kind: "investigate",
      title: `Investigate: ${g.what}`,
      why: `It happened in ${g.sessions} sessions in the last ${WINDOW_DAYS} days${g.tools ? ` (${g.tools})` : ""}, and no rule here covers it yet.`,
      sessions: g.sessions,
      examples: ex,
      causes: [g.id],
      action: {
        type: "prompt",
        text: `In my recent Claude Code sessions, "${g.what}" happened in ${g.sessions} sessions${g.tools ? ` (tools: ${g.tools})` : ""}. The raw error looks like: "${g.raw}". ${ex.length ? `Sessions where it happened: ${ex.map((e) => `"${e.title}"`).join(", ")}. ` : ""}Find out what the agent was trying to do when it hit this and why, then propose one short rule for CLAUDE.md (or a setting) that would prevent it. Do not change anything until I agree.`,
      },
    });
  }

  // 7. A habit.
  if (f.interrupts.n >= 10) {
    out.push({
      id: sid("tip", "interrupt-after-prompt"),
      kind: "tip",
      title: "Queue follow-ups instead of stopping the agent",
      why: `You stopped the agent right after sending a prompt ${f.interrupts.n} times, in ${f.interrupts.sessions} sessions. You can type the follow-up while it works: it is read at the next step, and the turn is not thrown away.`,
      sessions: f.interrupts.sessions,
      examples: [],
      causes: [],
      action: { type: "tip" },
    });
  }

  // State and effect.
  const states = new Map((await store.db.all<Row>("SELECT id, status, at FROM suggestions WHERE workspace = ?", [ws])).map((r) => [String(r.id), r]));
  const result: Suggestion[] = [];
  for (const s of out) {
    const st = states.get(s.id);
    let status = (st?.status as Suggestion["status"]) ?? "open";
    // A routine is applied when its hook is there, whoever added it.
    if (s.kind === "routine" && local) status = hasHook("SessionStart", CONTEXT_MARKER) ? "applied" : status === "applied" ? "open" : status;
    const at = st ? String(st.at) : null;
    const g = f.groups.find((x) => x.id === s.causes[0]);
    const issue = g && s.kind !== "routine" ? { key: g.issues[0].key, num: g.issues[0].num, what: g.what, sessions: g.sessions } : null;
    result.push({ ...s, issue, status, at, effect: status === "applied" && at ? await effect(store, ws, s.causes, at) : null });
  }
  const order = { open: 0, applied: 1, dismissed: 2 };
  return result.sort((a, b) => order[a.status] - order[b.status] || b.sessions - a.sessions);
}

/** Sessions that hit any of the causes, in the 30 days before `at` and since. */
async function effect(store: Store, ws: string, causes: string[], at: string) {
  const window = async (from: string, to: string) => {
    const [total] = await store.db.all<Row>("SELECT CAST(COUNT(*) AS INTEGER) AS c FROM sessions WHERE workspace = ? AND started_at >= ? AND started_at < ?", [ws, from, to]);
    if (causes.length === 0) return { sessions: Number(total?.c ?? 0), hit: 0 };
    const groups = await issueGroups(store, ws, from);
    const keys = groups.filter((g) => causes.includes(g.id)).flatMap((g) => g.issues.map((i) => i.key));
    if (keys.length === 0) return { sessions: Number(total?.c ?? 0), hit: 0 };
    const [hit] = await store.db.all<Row>(
      `SELECT CAST(COUNT(DISTINCT f.session_id) AS INTEGER) AS c FROM findings f JOIN sessions s ON s.workspace = f.workspace AND s.id = f.session_id
        WHERE f.workspace = ? AND s.started_at >= ? AND s.started_at < ? AND f.key IN (${keys.map(() => "?").join(", ")})`,
      [ws, from, to, ...keys],
    );
    return { sessions: Number(total?.c ?? 0), hit: Number(hit?.c ?? 0) };
  };
  const before = new Date(Date.parse(at) - 30 * DAY).toISOString();
  return { before: await window(before, at), since: await window(at, "9999") };
}

// ---------------------------------------------------------------- applying

const marker = (id: string) => `<!-- tracemind:${id} -->`;
const block = (id: string, text: string) => `\n${marker(id)}\n- ${text}\n`;

export type Preview = { file: string; exists: boolean; adds: string; tail: string } | { hook: string; event: string } | { prompt: string };

export function preview(s: Suggestion, command: string): Preview {
  if (s.action.type === "rule") {
    const exists = existsSync(s.action.file);
    const text = exists ? readFileSync(s.action.file, "utf8") : "";
    return { file: s.action.file, exists, adds: block(s.id, s.action.text).trimStart(), tail: text.split("\n").slice(-6).join("\n") };
  }
  if (s.action.type === "routine") return { event: s.action.event, hook: tagged(command) };
  if (s.action.type === "prompt") return { prompt: s.action.text };
  return { prompt: "" };
}

function backupDir(): string {
  const dir = join(process.env.TRACEMIND_HOME ?? join(homedir(), ".tracemind"), "backups");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function apply(store: Store, ws: string, s: Suggestion, command: string): Promise<string> {
  if (s.action.type === "rule") {
    const file = s.action.file;
    const before = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (before?.includes(marker(s.id))) return file; // already there
    if (before != null) copyFileSync(file, join(backupDir(), `${basename(file)}.${s.id}.${Date.now()}.bak`));
    const add = block(s.id, s.action.text);
    writeFileSync(file, (before ?? "").replace(/\n*$/, "\n") + add);
    await setState(store, ws, s.id, "applied", { file, added: add });
    return file;
  }
  if (s.action.type === "routine") {
    const file = setHook("SessionStart", tagged(command), CONTEXT_MARKER, true);
    await setState(store, ws, s.id, "applied", { file });
    return file;
  }
  throw new Error("This suggestion is not something Tracemind can apply; copy it to Claude instead.");
}

export async function undo(store: Store, ws: string, s: Suggestion): Promise<void> {
  if (s.action.type === "rule") {
    const file = s.action.file;
    if (existsSync(file)) {
      const text = readFileSync(file, "utf8");
      const add = block(s.id, s.action.text);
      // Takes out exactly what was added, and only that.
      const next = text.includes(add) ? text.replace(add, "\n") : text.replace(new RegExp(`\\n?${marker(s.id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n- [^\\n]*\\n?`), "\n");
      writeFileSync(file, next.replace(/\n{3,}$/, "\n"));
    }
  }
  if (s.action.type === "routine") setHook("SessionStart", "", CONTEXT_MARKER, false);
  await setState(store, ws, s.id, "open", {});
}

export async function setState(store: Store, ws: string, id: string, status: Suggestion["status"], detail: object) {
  await store.db.run("DELETE FROM suggestions WHERE workspace = ? AND id = ?", [ws, id]);
  await store.db.run("INSERT INTO suggestions (workspace, id, status, at, detail) VALUES (?, ?, ?, ?, ?)", [ws, id, status, new Date().toISOString(), JSON.stringify(detail)]);
}

// ---------------------------------------------------------------- the routine itself

/** What to tell an agent about each known cause, for the SessionStart hook. */
const ADVICE: Record<string, string> = Object.fromEntries(GLOBAL_RULES.map((r) => [r.what, r.text]));
ADVICE["Refused by the auto-mode classifier"] = "Expect refusals for production data, shared resources and deploys: ask the person instead of retrying another way.";
ADVICE["Not signed in to the service"] = "Some connectors here are not signed in: if a call says unauthorized, tell the person instead of retrying.";

/** The text a new session gets: up to five problems from its own project's recent sessions. */
export async function sessionContext(store: Store, ws: string, cwd: string): Promise<string> {
  const root = projectRoot(cwd);
  if (!root) return "";
  const since = new Date(Date.now() - 30 * DAY).toISOString();
  const ids = (await store.db.all<Row>("SELECT id, project FROM sessions WHERE workspace = ? AND started_at >= ?", [ws, since]))
    .filter((r) => projectRoot(String(r.project)) === root)
    .map((r) => String(r.id));
  if (ids.length < 3) return "";
  const idSet = new Set(ids);
  const rows = await store.db.all<Row>(
    `SELECT f.key, f.session_id, i.kind, i.title FROM findings f JOIN issues i ON i.workspace = f.workspace AND i.key = f.key
      WHERE f.workspace = ? AND i.kind <> 'interrupted' AND i.status = 'open'`,
    [ws],
  );
  const { causeKey, describeIssue } = await import("../core/describe.ts");
  const byCause = new Map<string, { what: string; sessions: Set<string> }>();
  for (const r of rows) {
    if (!idSet.has(String(r.session_id))) continue;
    const issue = { kind: r.kind as never, title: String(r.title) };
    const k = causeKey(issue);
    const e = byCause.get(k) ?? { what: describeIssue(issue).what, sessions: new Set<string>() };
    e.sessions.add(String(r.session_id));
    byCause.set(k, e);
  }
  // A bare exit code is mostly grep or a test finding nothing: not worth a new session's attention.
  const top = [...byCause.values()]
    .filter((e) => e.sessions.size >= 3 && e.what !== "Exited with an error code")
    .sort((a, b) => b.sessions.size - a.sessions.size)
    .slice(0, 5);
  if (top.length === 0) return "";
  const lines = top.map((e) => `- ${e.what} (${e.sessions.size} of the last ${ids.length} sessions here)${ADVICE[e.what] ? `: ${ADVICE[e.what]}` : "."}`);
  return `Tracemind, from this project's recent Claude Code sessions. ${lines.length === 1 ? "This keeps going wrong here:" : "These keep going wrong here:"}\n${lines.join("\n")}`;
}
