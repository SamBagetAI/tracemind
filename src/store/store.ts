/** Reading and writing traces, issues and tokens. All queries are scoped to one workspace. */
import { redact } from "../core/redact.ts";
import type { Brief, Finding, IssueKind, MemoryEvent, Step, Trace } from "../core/types.ts";
import type { Db, Row } from "./db.ts";
import { autoResolve, issue, issues, setIssueStatus, touchIssue } from "./issues.ts";
import { migrate } from "./migrate.ts";
import { deleteSession, insertMany, kindClause, n, now, toSession, type IssueRef, type IssueRow, type SessionKind } from "./rows.ts";
import { memory, overview, tools, totals } from "./stats.ts";
import { createToken, tokenCount, tokenOwner } from "./tokens.ts";

export { ROUTINE_AGENT, kindClause, n, type IssueRef, type IssueRow, type SessionKind } from "./rows.ts";
export { AUTO_RESOLVER, QUIET_SESSIONS } from "./issues.ts";

type SessionFilter = { outcome?: string; project?: string; person?: string; q?: string; since?: string; kind?: SessionKind; limit?: number; offset?: number };

/**
 * The brief in a session, from what its transcript shows and what the hook noted itself
 * (recordBrief): given wins, then a failure, then nothing to say. Null when there is neither.
 */
function briefOf(seen: Brief | null | undefined, noted: string | undefined): Brief | null {
  if (seen === "given" || noted === "given") return "given";
  if (seen === "failed") return "failed";
  return seen === "empty" || noted === "empty" ? "empty" : null;
}

export class Store {
  constructor(readonly db: Db) {}

  migrate() {
    return migrate(this.db);
  }

  /** Saves a whole trace, replacing what was there for that session. Text is redacted again here. */
  async saveTrace(ws: string, trace: Trace, opts: { person?: string } = {}) {
    const s = trace.session;
    const person = opts.person ?? s.person;
    await this.db.transaction(async (db) => {
      const prior = await db.all<{ pushed_at: string | null }>(
        "SELECT pushed_at FROM sessions WHERE workspace = ? AND id = ?",
        [ws, s.id],
      );
      const [noted] = await db.all<{ brief: string }>("SELECT brief FROM briefs WHERE workspace = ? AND session_id = ?", [ws, s.id]);
      await deleteSession(db, ws, s.id);
      await insertMany(
        db,
        "sessions",
        ["workspace", "id", "agent", "person", "project", "title", "git_branch", "model", "agent_version", "started_at",
          "ended_at", "outcome", "step_count", "tool_calls", "tool_errors", "input_tokens", "output_tokens", "active_ms", "cost_usd", "brief", "received_at", "pushed_at"],
        [[ws, s.id, s.agent, person, redact(s.project), redact(s.title), s.gitBranch, s.model, s.agentVersion, s.startedAt,
          s.endedAt, s.outcome, s.stepCount, s.toolCalls, s.toolErrors, s.inputTokens, s.outputTokens, s.activeMs ?? 0, s.costUsd ?? 0, briefOf(s.brief, noted?.brief), now(), prior[0]?.pushed_at ?? null]],
      );
      await insertMany(
        db,
        "steps",
        ["workspace", "session_id", "seq", "kind", "name", "input", "output", "is_error", "at", "duration_ms", "sidechain"],
        trace.steps.map((st) => [ws, s.id, st.seq, st.kind, st.name, redact(st.input), redact(st.output), st.isError ? 1 : 0, st.at, st.durationMs, st.sidechain ? 1 : 0]),
      );
      await insertMany(
        db,
        "memory",
        ["workspace", "session_id", "idx", "seq", "source", "op", "ref", "preview", "at"],
        trace.memory.map((m, i) => [ws, s.id, i, m.seq, m.source, m.op, redact(m.ref), redact(m.preview), m.at]),
      );
      await insertMany(
        db,
        "findings",
        ["workspace", "session_id", "key", "kind", "title", "seq"],
        trace.findings.map((f) => [ws, s.id, f.key, f.kind, redact(f.title), f.seq]),
      );
      for (const f of trace.findings) await touchIssue(db, ws, f, s.startedAt, s.endedAt);
    });
    await autoResolve(this.db, ws, redact(s.project));
  }

  /**
   * Notes what the session-start brief did in a session, when the hook runs. Claude Code records a
   * hook in the transcript only when it prints something, so a brief with nothing to say would
   * leave no trace, and look like a hook that never ran. Given once stays given: a session starts
   * again after a compaction. saveTrace puts the note on the session.
   */
  async recordBrief(ws: string, sessionId: string, brief: "given" | "empty") {
    await this.db.run(
      `INSERT INTO briefs (workspace, session_id, brief, at) VALUES (?, ?, ?, ?)
       ON CONFLICT (workspace, session_id) DO UPDATE SET brief = CASE WHEN briefs.brief = 'given' THEN 'given' ELSE excluded.brief END, at = excluded.at`,
      [ws, sessionId, brief, now()],
    );
  }

  async sessions(ws: string, f: SessionFilter = {}) {
    const where = ["workspace = ?"];
    const params: unknown[] = [ws];
    for (const [col, v] of [["outcome", f.outcome], ["project", f.project], ["person", f.person]] as const) {
      if (v) {
        where.push(`${col} = ?`);
        params.push(v);
      }
    }
    if (f.since) {
      where.push("started_at >= ?");
      params.push(f.since);
    }
    if (f.q) {
      where.push("LOWER(title) LIKE ?");
      params.push(`%${f.q.toLowerCase()}%`);
    }
    const k = kindClause(f.kind);
    params.push(...k.params, f.limit ?? 50, f.offset ?? 0);
    const rows = await this.db.all(
      `SELECT s.*, CAST((SELECT COUNT(*) FROM findings f WHERE f.workspace = s.workspace AND f.session_id = s.id) AS INTEGER) AS issue_count
         FROM sessions s WHERE ${where.join(" AND ")}${k.sql} ORDER BY ended_at DESC LIMIT ? OFFSET ?`,
      params,
    );
    return rows.map(toSession);
  }

  /**
   * Where a session sits among the newest 1000 of any kind, newest first, for the session page's
   * arrows: among those that started in the window when it did (`scoped`), else among all of them.
   * Null when it is not among the newest 1000.
   */
  async neighbours(ws: string, id: string, since: string) {
    const all = await this.db.all<Row>("SELECT id, started_at FROM sessions WHERE workspace = ? ORDER BY ended_at DESC, id DESC LIMIT 1000", [ws]);
    const inWindow = all.filter((r) => String(r.started_at) >= since);
    const scoped = inWindow.some((r) => String(r.id) === id);
    const ids = (scoped ? inWindow : all).map((r) => String(r.id));
    const i = ids.indexOf(id);
    if (i < 0) return null;
    return { newer: i > 0 ? ids[i - 1] : null, older: i < ids.length - 1 ? ids[i + 1] : null, index: i, total: ids.length, scoped };
  }

  async trace(ws: string, id: string): Promise<(Trace & { issues: Record<string, IssueRef> }) | null> {
    const rows = await this.db.all("SELECT * FROM sessions WHERE workspace = ? AND id = ?", [ws, id]);
    if (rows.length === 0) return null;
    const steps = await this.db.all("SELECT * FROM steps WHERE workspace = ? AND session_id = ? ORDER BY seq", [ws, id]);
    const memory = await this.db.all("SELECT * FROM memory WHERE workspace = ? AND session_id = ? ORDER BY idx", [ws, id]);
    const findings = await this.db.all("SELECT * FROM findings WHERE workspace = ? AND session_id = ? ORDER BY seq", [ws, id]);
    const status = await this.db.all<Row>(
      `SELECT i.key, i.status, i.num,
              CAST((SELECT COUNT(*) FROM findings g WHERE g.workspace = i.workspace AND g.key = i.key) AS INTEGER) AS sessions
         FROM issues i JOIN findings f ON f.workspace = i.workspace AND f.key = i.key WHERE f.workspace = ? AND f.session_id = ?`,
      [ws, id],
    );
    return {
      session: toSession(rows[0]),
      steps: steps.map(
        (r): Step => ({
          seq: n(r.seq),
          kind: r.kind as Step["kind"],
          name: String(r.name),
          input: String(r.input),
          output: String(r.output),
          isError: n(r.is_error) === 1,
          at: String(r.at),
          durationMs: r.duration_ms == null ? null : n(r.duration_ms),
          sidechain: n(r.sidechain) === 1,
        }),
      ),
      memory: memory.map(
        (r): MemoryEvent => ({
          seq: n(r.seq),
          source: r.source as MemoryEvent["source"],
          op: r.op as MemoryEvent["op"],
          ref: String(r.ref),
          preview: String(r.preview),
          at: String(r.at),
        }),
      ),
      findings: findings.map((r): Finding => ({ key: String(r.key), kind: r.kind as IssueKind, title: String(r.title), seq: n(r.seq) })),
      issues: Object.fromEntries(
        status.map((r) => [String(r.key), { status: r.status as IssueRow["status"], num: n(r.num), sessions: n(r.sessions) }]),
      ),
    };
  }

  overview(ws: string, since: string, kind?: SessionKind) {
    return overview(this.db, ws, since, kind);
  }

  totals(ws: string, since: string, until: string, kind?: SessionKind) {
    return totals(this.db, ws, since, until, kind);
  }

  issues(ws: string) {
    return issues(this.db, ws);
  }

  issue(ws: string, key: string) {
    return issue(this.db, ws, key);
  }

  setIssueStatus(ws: string, key: string, status: "open" | "resolved", by: string, note: string) {
    return setIssueStatus(this.db, ws, key, status, by, note);
  }

  tools(ws: string, since: string, kind?: SessionKind) {
    return tools(this.db, ws, since, kind);
  }

  memory(ws: string, since: string) {
    return memory(this.db, ws, since);
  }

  /** Sessions saved or changed since they were last pushed to a server. */
  async unpushed(ws: string, limit = 500): Promise<string[]> {
    const rows = await this.db.all<Row>(
      "SELECT id FROM sessions WHERE workspace = ? AND (pushed_at IS NULL OR pushed_at < received_at) AND outcome <> 'running' ORDER BY ended_at LIMIT ?",
      [ws, limit],
    );
    return rows.map((r) => String(r.id));
  }

  async markPushed(ws: string, id: string) {
    await this.db.run("UPDATE sessions SET pushed_at = ? WHERE workspace = ? AND id = ?", [now(), ws, id]);
  }

  createToken(ws: string, person: string, role: "admin" | "member") {
    return createToken(this.db, ws, person, role);
  }

  tokenOwner(token: string) {
    return tokenOwner(this.db, token);
  }

  tokenCount() {
    return tokenCount(this.db);
  }
}
