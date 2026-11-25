/** Reading and writing traces, issues and tokens. All queries are scoped to one workspace. */
import { createHash, randomBytes } from "node:crypto";
import { redact } from "../core/redact.ts";
import type { Finding, IssueKind, MemoryEvent, Outcome, Session, Step, Trace, Brief } from "../core/types.ts";
import type { Db, Row } from "./db.ts";
import { SCHEMA } from "./schema.ts";

const CHUNK = 200;

const n = (v: unknown): number => (v == null ? 0 : Number(v));
const now = () => new Date().toISOString();

async function insertMany(db: Db, table: string, cols: string[], rows: unknown[][]) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const one = `(${cols.map(() => "?").join(", ")})`;
    await db.run(
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES ${chunk.map(() => one).join(", ")}`,
      chunk.flat(),
    );
  }
}

function toSession(r: Row): Session & { receivedAt: string; pushedAt: string | null; issueCount: number } {
  return {
    id: String(r.id),
    agent: String(r.agent),
    person: String(r.person),
    project: String(r.project),
    title: String(r.title),
    gitBranch: (r.git_branch as string) ?? null,
    model: (r.model as string) ?? null,
    agentVersion: (r.agent_version as string) ?? null,
    startedAt: String(r.started_at),
    endedAt: String(r.ended_at),
    outcome: r.outcome as Outcome,
    stepCount: n(r.step_count),
    toolCalls: n(r.tool_calls),
    toolErrors: n(r.tool_errors),
    inputTokens: n(r.input_tokens),
    outputTokens: n(r.output_tokens),
    activeMs: n(r.active_ms),
    costUsd: Number(r.cost_usd ?? 0),
    brief: (r.brief as Brief | null) ?? null,
    receivedAt: String(r.received_at),
    pushedAt: (r.pushed_at as string) ?? null,
    issueCount: n(r.issue_count),
  };
}

export type IssueRow = {
  key: string;
  kind: IssueKind;
  title: string;
  status: "open" | "resolved";
  firstSeen: string;
  lastSeen: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  note: string | null;
  reopened: boolean;
  sessions: number;
  /** Short number people use for the issue ("issue #12"), unique within a workspace. */
  num: number;
};

function toIssue(r: Row): IssueRow {
  return {
    key: String(r.key),
    kind: r.kind as IssueKind,
    title: String(r.title),
    status: r.status as IssueRow["status"],
    firstSeen: String(r.first_seen),
    lastSeen: String(r.last_seen),
    resolvedAt: (r.resolved_at as string) ?? null,
    resolvedBy: (r.resolved_by as string) ?? null,
    note: (r.note as string) ?? null,
    reopened: n(r.reopened) === 1,
    sessions: n(r.sessions),
    num: n(r.num),
  };
}

/** What a session page needs to know about each issue it hit. */
export type IssueRef = { status: IssueRow["status"]; num: number; sessions: number };

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type SessionFilter = { outcome?: string; project?: string; person?: string; q?: string; since?: string; kind?: SessionKind; limit?: number; offset?: number };

/** Sessions a person worked in, or runs of a claude.ai routine (src/core/parse-routine.ts). */
export type SessionKind = "sessions" | "routines";
export const ROUTINE_AGENT = "claude-code-routine";

/** An open issue is resolved by Tracemind once this many sessions in its projects ran without it. */
export const QUIET_SESSIONS = 5;
/** …and the last of them ended at least this long after it was last seen. */
export const QUIET_MS = 86_400_000;
/** Who resolved an issue that stopped happening, as the issue page shows it. */
export const AUTO_RESOLVER = "Tracemind";
function kindClause(kind: SessionKind | undefined, prefix = ""): { sql: string; params: unknown[] } {
  if (kind === "routines") return { sql: ` AND ${prefix}agent = ?`, params: [ROUTINE_AGENT] };
  if (kind === "sessions") return { sql: ` AND ${prefix}agent <> ?`, params: [ROUTINE_AGENT] };
  return { sql: "", params: [] };
}

/** A project as a note names it: a routine by its name (which may hold a slash), a folder by its last part. */
function projectLabel(project: string): string {
  return project.startsWith("routines/") ? project.slice("routines/".length) : project.split("/").filter(Boolean).pop() ?? project;
}

export class Store {
  constructor(readonly db: Db) {}

  async migrate() {
    await this.db.exec(SCHEMA);
    // Issue numbers came after the first release: add the column to older databases and number
    // the issues they already have, oldest first.
    try {
      await this.db.exec("ALTER TABLE issues ADD COLUMN num INTEGER");
    } catch {
      // Already there.
    }
    // Active time and estimated cost came later too; `tracemind import` fills them for old sessions.
    for (const col of ["active_ms BIGINT NOT NULL DEFAULT 0", "cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0", "brief TEXT"]) {
      try {
        await this.db.exec(`ALTER TABLE sessions ADD COLUMN ${col}`);
      } catch {
        // Already there.
      }
    }
    // Routine runs were first keyed by when they started; they are keyed by when they ended now
    // (src/core/parse-routine.ts), so the same run imported again replaces itself. One run's end
    // can be the next run's start, so every run moves to a temporary id first, then to its new id;
    // only two rows that end up with the same id (the same run imported twice) are merged.
    const runs = await this.db.all<Row>("SELECT workspace, id, ended_at, step_count FROM sessions WHERE agent = 'claude-code-routine' ORDER BY step_count DESC");
    const moves = runs
      .map((r) => {
        const m = /^(routine-.+)-\d{17}$/.exec(String(r.id));
        return m ? { ws: String(r.workspace), id: String(r.id), next: `${m[1]}-${String(r.ended_at).replace(/[^0-9]/g, "").slice(0, 17)}` } : null;
      })
      .filter((x): x is { ws: string; id: string; next: string } => !!x && x.next !== x.id);
    if (moves.length > 0) {
      await this.db.transaction(async (db) => {
        const rename = async (ws: string, from: string, to: string) => {
          for (const t of ["steps", "memory", "findings"]) await db.run(`UPDATE ${t} SET session_id = ? WHERE workspace = ? AND session_id = ?`, [to, ws, from]);
          await db.run("UPDATE sessions SET id = ? WHERE workspace = ? AND id = ?", [to, ws, from]);
        };
        const drop = async (ws: string, id: string) => {
          for (const t of ["steps", "memory", "findings"]) await db.run(`DELETE FROM ${t} WHERE workspace = ? AND session_id = ?`, [ws, id]);
          await db.run("DELETE FROM sessions WHERE workspace = ? AND id = ?", [ws, id]);
        };
        for (const m of moves) await rename(m.ws, m.id, `moving-${m.id}`);
        const taken = new Set((await db.all<Row>("SELECT workspace, id FROM sessions")).map((r) => `${r.workspace} ${r.id}`));
        // Runs come with the most steps first, so a duplicate keeps its fuller copy.
        for (const m of moves) {
          if (taken.has(`${m.ws} ${m.next}`)) await drop(m.ws, `moving-${m.id}`);
          else {
            await rename(m.ws, `moving-${m.id}`, m.next);
            taken.add(`${m.ws} ${m.next}`);
          }
        }
      });
    }
    // Repair first/last seen from the sessions (older versions kept the first-saved session's date).
    await this.db.run(
      `UPDATE issues SET
         first_seen = COALESCE((SELECT MIN(s.started_at) FROM findings f JOIN sessions s ON s.workspace = f.workspace AND s.id = f.session_id
                                 WHERE f.workspace = issues.workspace AND f.key = issues.key), first_seen),
         last_seen = COALESCE((SELECT MAX(s.ended_at) FROM findings f JOIN sessions s ON s.workspace = f.workspace AND s.id = f.session_id
                                WHERE f.workspace = issues.workspace AND f.key = issues.key), last_seen)`,
    );
    // Issues that stopped happening before Tracemind resolved them on its own.
    const spaces = await this.db.all<Row>("SELECT DISTINCT workspace FROM issues WHERE status = 'open'");
    for (const r of spaces) await this.autoResolve(String(r.workspace));
    const missing = await this.db.all<Row>("SELECT workspace, key FROM issues WHERE num IS NULL ORDER BY workspace, first_seen, key");
    if (missing.length === 0) return;
    await this.db.transaction(async (db) => {
      const next = new Map<string, number>();
      for (const r of missing) {
        const ws = String(r.workspace);
        if (!next.has(ws)) {
          const [m] = await db.all<Row>("SELECT CAST(COALESCE(MAX(num), 0) AS INTEGER) AS m FROM issues WHERE workspace = ?", [ws]);
          next.set(ws, n(m?.m));
        }
        const num = next.get(ws)! + 1;
        next.set(ws, num);
        await db.run("UPDATE issues SET num = ? WHERE workspace = ? AND key = ?", [num, ws, r.key]);
      }
    });
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
      for (const t of ["steps", "memory", "findings"]) {
        await db.run(`DELETE FROM ${t} WHERE workspace = ? AND session_id = ?`, [ws, s.id]);
      }
      await db.run("DELETE FROM sessions WHERE workspace = ? AND id = ?", [ws, s.id]);
      await insertMany(
        db,
        "sessions",
        ["workspace", "id", "agent", "person", "project", "title", "git_branch", "model", "agent_version", "started_at",
          "ended_at", "outcome", "step_count", "tool_calls", "tool_errors", "input_tokens", "output_tokens", "active_ms", "cost_usd", "brief", "received_at", "pushed_at"],
        [[ws, s.id, s.agent, person, redact(s.project), redact(s.title), s.gitBranch, s.model, s.agentVersion, s.startedAt,
          s.endedAt, s.outcome, s.stepCount, s.toolCalls, s.toolErrors, s.inputTokens, s.outputTokens, s.activeMs ?? 0, s.costUsd ?? 0, s.brief ?? null, now(), prior[0]?.pushed_at ?? null]],
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
      for (const f of trace.findings) await this.touchIssue(db, ws, f, s.startedAt, s.endedAt);
    });
    await this.autoResolve(ws, redact(s.project));
  }

  /**
   * Resolves the open issues that stopped happening: QUIET_SESSIONS sessions in the projects where
   * an issue happened started after it was last seen (and after anyone last reopened it), and none
   * of them had it. It counts as resolved when the last of those sessions ended, so a session that
   * has it again after that reopens it (touchIssue). With `project`, only issues seen there.
   */
  async autoResolve(ws: string, project?: string) {
    const open = await this.db.all<Row>(
      `SELECT i.key, i.last_seen, i.resolved_at FROM issues i WHERE i.workspace = ? AND i.status = 'open'
       ${project === undefined ? "" : `AND EXISTS (SELECT 1 FROM findings f JOIN sessions s ON s.workspace = f.workspace AND s.id = f.session_id
                                                  WHERE f.workspace = i.workspace AND f.key = i.key AND s.project = ?)`}`,
      project === undefined ? [ws] : [ws, project],
    );
    for (const r of open) {
      const key = String(r.key);
      const reopenedAt = r.resolved_at ? String(r.resolved_at) : "";
      const after = String(r.last_seen) > reopenedAt ? String(r.last_seen) : reopenedAt;
      const quiet = await this.db.all<Row>(
        `SELECT s.project, s.ended_at FROM sessions s
          WHERE s.workspace = ? AND s.started_at > ?
            AND s.project IN (SELECT s2.project FROM findings f JOIN sessions s2 ON s2.workspace = f.workspace AND s2.id = f.session_id
                               WHERE f.workspace = ? AND f.key = ?)
            AND NOT EXISTS (SELECT 1 FROM findings f WHERE f.workspace = s.workspace AND f.session_id = s.id AND f.key = ?)
          ORDER BY s.ended_at`,
        [ws, after, ws, key, key],
      );
      // Enough quiet sessions, and a day of them: a burst of quick follow-ups is not "stopped".
      const settled = quiet.findIndex((q, i) => i + 1 >= QUIET_SESSIONS && Date.parse(String(q.ended_at)) - Date.parse(after) >= QUIET_MS);
      if (settled < 0) continue;
      const names = [...new Set(quiet.map((q) => projectLabel(String(q.project))))];
      const where = names.length === 1 ? `in ${names[0]}` : `in ${names.length} projects`;
      await this.db.run(
        "UPDATE issues SET status = 'resolved', resolved_at = ?, resolved_by = ?, note = ?, reopened = 0 WHERE workspace = ? AND key = ? AND status = 'open'",
        [String(quiet[settled].ended_at), AUTO_RESOLVER, `Not seen in the ${quiet.length} sessions ${where} since it last happened.`, ws, key],
      );
    }
  }

  /** Opens an issue the first time it is seen, and reopens a resolved one that is seen again after it was resolved. */
  /**
   * First seen is when the earliest session with the issue started, and last seen when the latest
   * ended, whatever order sessions are saved in (an import goes by file date, not session date).
   */
  private async touchIssue(db: Db, ws: string, f: Finding, startedAt: string, at: string) {
    const rows = await db.all<Row>("SELECT status, resolved_at, resolved_by, first_seen, last_seen FROM issues WHERE workspace = ? AND key = ?", [ws, f.key]);
    if (rows.length === 0) {
      await db.run(
        `INSERT INTO issues (workspace, key, kind, title, status, first_seen, last_seen, reopened, num)
         VALUES (?, ?, ?, ?, 'open', ?, ?, 0, (SELECT COALESCE(MAX(num), 0) + 1 FROM issues WHERE workspace = ?))`,
        [ws, f.key, f.kind, redact(f.title), startedAt, at, ws],
      );
      return;
    }
    const r = rows[0];
    const first = String(r.first_seen) < startedAt ? String(r.first_seen) : startedAt;
    const last = String(r.last_seen) > at ? String(r.last_seen) : at;
    // Resolved by Tracemind means none of the quiet sessions after last seen had it: a session that
    // did, saved late (an import), proves that wrong too.
    const back = at > String(r.resolved_at) || (r.resolved_by === AUTO_RESOLVER && at > String(r.last_seen));
    if (r.status === "resolved" && r.resolved_at && back) {
      // Back after it was resolved, or never gone: a late session from inside the quiet stretch.
      const reopened = at > String(r.resolved_at) ? 1 : 0;
      await db.run("UPDATE issues SET status = 'open', reopened = ?, first_seen = ?, last_seen = ? WHERE workspace = ? AND key = ?", [reopened, first, last, ws, f.key]);
    } else {
      await db.run("UPDATE issues SET first_seen = ?, last_seen = ? WHERE workspace = ? AND key = ?", [first, last, ws, f.key]);
    }
  }

  async sessions(ws: string, f: SessionFilter = {}) {
    const where = ["workspace = ?"];
    const params: unknown[] = [ws];
    if (f.outcome) {
      where.push("outcome = ?");
      params.push(f.outcome);
    }
    if (f.project) {
      where.push("project = ?");
      params.push(f.project);
    }
    if (f.person) {
      where.push("person = ?");
      params.push(f.person);
    }
    if (f.kind) {
      where.push(f.kind === "routines" ? "agent = ?" : "agent <> ?");
      params.push(ROUTINE_AGENT);
    }
    if (f.since) {
      where.push("started_at >= ?");
      params.push(f.since);
    }
    if (f.q) {
      where.push("LOWER(title) LIKE ?");
      params.push(`%${f.q.toLowerCase()}%`);
    }
    params.push(f.limit ?? 50, f.offset ?? 0);
    const rows = await this.db.all(
      `SELECT s.*, CAST((SELECT COUNT(*) FROM findings f WHERE f.workspace = s.workspace AND f.session_id = s.id) AS INTEGER) AS issue_count
         FROM sessions s WHERE ${where.join(" AND ")} ORDER BY ended_at DESC LIMIT ? OFFSET ?`,
      params,
    );
    return rows.map(toSession);
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

  /**
   * Totals for the sessions that started in the window. `kind` keeps only the sessions a person
   * worked in ("sessions") or only routine runs ("routines"); without it, both.
   */
  async overview(ws: string, since: string, kind?: SessionKind) {
    const k = kindClause(kind);
    const ks = kindClause(kind, "s.");
    const [totals] = await this.db.all<Row>(
      `SELECT CAST(COUNT(*) AS INTEGER) AS sessions,
              CAST(COALESCE(SUM(CASE WHEN outcome = 'ok' THEN 1 ELSE 0 END), 0) AS INTEGER) AS ok,
              CAST(COALESCE(SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END), 0) AS INTEGER) AS error,
              CAST(COALESCE(SUM(CASE WHEN outcome = 'interrupted' THEN 1 ELSE 0 END), 0) AS INTEGER) AS interrupted,
              CAST(COALESCE(SUM(tool_calls), 0) AS BIGINT) AS tool_calls,
              CAST(COALESCE(SUM(tool_errors), 0) AS BIGINT) AS tool_errors,
              CAST(COALESCE(SUM(input_tokens), 0) AS BIGINT) AS input_tokens,
              CAST(COALESCE(SUM(output_tokens), 0) AS BIGINT) AS output_tokens,
              CAST(COALESCE(SUM(active_ms), 0) AS BIGINT) AS active_ms,
              COALESCE(SUM(cost_usd), 0) AS cost_usd
         FROM sessions WHERE workspace = ? AND started_at >= ?${k.sql}`,
      [ws, since, ...k.params],
    );
    const days = await this.db.all<Row>(
      `SELECT SUBSTR(s.started_at, 1, 10) AS day, CAST(COUNT(*) AS INTEGER) AS sessions,
              CAST(COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM findings f WHERE f.workspace = s.workspace AND f.session_id = s.id) THEN 1 ELSE 0 END), 0) AS INTEGER) AS failed
         FROM sessions s WHERE s.workspace = ? AND s.started_at >= ?${ks.sql} GROUP BY SUBSTR(s.started_at, 1, 10) ORDER BY day`,
      [ws, since, ...ks.params],
    );
    const strip = await this.db.all<Row>(
      `SELECT s.id, s.title, s.started_at,
              CAST((SELECT COUNT(*) FROM findings f WHERE f.workspace = s.workspace AND f.session_id = s.id) AS INTEGER) AS issue_count
         FROM sessions s WHERE s.workspace = ? AND s.started_at >= ?${ks.sql} ORDER BY s.started_at LIMIT 1000`,
      [ws, since, ...ks.params],
    );
    const [troubled] = await this.db.all<Row>(
      `SELECT CAST(COUNT(*) AS INTEGER) AS c FROM sessions s
        WHERE s.workspace = ? AND s.started_at >= ?${ks.sql}
          AND EXISTS (SELECT 1 FROM findings f WHERE f.workspace = s.workspace AND f.session_id = s.id)`,
      [ws, since, ...ks.params],
    );
    const [open] = await this.db.all<Row>(
      "SELECT CAST(COUNT(*) AS INTEGER) AS open FROM issues WHERE workspace = ? AND status = 'open'",
      [ws],
    );
    return {
      sessions: n(totals?.sessions),
      ok: n(totals?.ok),
      error: n(totals?.error),
      interrupted: n(totals?.interrupted),
      toolCalls: n(totals?.tool_calls),
      toolErrors: n(totals?.tool_errors),
      inputTokens: n(totals?.input_tokens),
      outputTokens: n(totals?.output_tokens),
      activeMs: n(totals?.active_ms),
      costUsd: Number(totals?.cost_usd ?? 0),
      openIssues: n(open?.open),
      /** Sessions where at least one failure was found. */
      withIssues: n(troubled?.c),
      days: days.map((d) => ({ day: String(d.day), sessions: n(d.sessions), failed: n(d.failed) })),
      /** One entry per session in the period, oldest first, for a strip of cells. */
      strip: strip.map((r) => ({ id: String(r.id), title: String(r.title), startedAt: String(r.started_at), issues: n(r.issue_count) })),
    };
  }

  async issues(ws: string, status?: "open" | "resolved") {
    const rows = await this.db.all(
      `SELECT i.*, CAST((SELECT COUNT(*) FROM findings f WHERE f.workspace = i.workspace AND f.key = i.key) AS INTEGER) AS sessions
         FROM issues i WHERE i.workspace = ? ${status ? "AND i.status = ?" : ""}
        ORDER BY i.last_seen DESC`,
      status ? [ws, status] : [ws],
    );
    return rows.map(toIssue).sort((a, b) => (a.status === b.status ? 0 : a.status === "open" ? -1 : 1));
  }

  async issue(ws: string, key: string) {
    const rows = await this.db.all(
      `SELECT i.*, CAST((SELECT COUNT(*) FROM findings f WHERE f.workspace = i.workspace AND f.key = i.key) AS INTEGER) AS sessions
         FROM issues i WHERE i.workspace = ? AND i.key = ?`,
      [ws, key],
    );
    if (rows.length === 0) return null;
    const sessions = await this.db.all<Row>(
      `SELECT s.*, f.seq AS finding_seq FROM findings f JOIN sessions s ON s.workspace = f.workspace AND s.id = f.session_id
        WHERE f.workspace = ? AND f.key = ? ORDER BY s.ended_at DESC LIMIT 100`,
      [ws, key],
    );
    return { issue: toIssue(rows[0]), sessions: sessions.map((r) => ({ ...toSession(r), findingSeq: n(r.finding_seq) })) };
  }

  async setIssueStatus(ws: string, key: string, status: "open" | "resolved", by: string, note: string) {
    if (status === "resolved") {
      await this.db.run(
        "UPDATE issues SET status = 'resolved', resolved_at = ?, resolved_by = ?, note = ?, reopened = 0 WHERE workspace = ? AND key = ?",
        [now(), by, redact(note).slice(0, 500), ws, key],
      );
    } else {
      // Reopened by hand: Tracemind counts quiet sessions again from now before it resolves it.
      await this.db.run("UPDATE issues SET status = 'open', resolved_at = ? WHERE workspace = ? AND key = ?", [now(), ws, key]);
    }
  }

  /**
   * Calls, failures and run times per tool, for the sessions that started in the window: the same
   * sessions the Overview and the Sessions list count, so the rows add up to their totals.
   * Typical is the median, slow the 95th percentile, of the calls whose run time is known.
   */
  async tools(ws: string, since: string, kind?: SessionKind) {
    const inWindow = `SELECT id FROM sessions WHERE workspace = ? AND started_at >= ?${kind === "routines" ? ` AND agent = '${ROUTINE_AGENT}'` : kind === "sessions" ? ` AND agent <> '${ROUTINE_AGENT}'` : ""}`;
    const rows = await this.db.all<Row>(
      `SELECT name, CAST(COUNT(*) AS INTEGER) AS calls,
              CAST(SUM(is_error) AS INTEGER) AS errors,
              CAST(COUNT(DISTINCT session_id) AS INTEGER) AS sessions
         FROM steps WHERE workspace = ? AND kind IN ('tool', 'subagent') AND session_id IN (${inWindow})
        GROUP BY name ORDER BY calls DESC`,
      [ws, ws, since],
    );
    const times = await this.db.all<Row>(
      `SELECT name, duration_ms FROM steps WHERE workspace = ? AND kind IN ('tool', 'subagent') AND session_id IN (${inWindow}) AND duration_ms IS NOT NULL`,
      [ws, ws, since],
    );
    const byName = new Map<string, number[]>();
    for (const t of times) {
      const k = String(t.name);
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k)!.push(n(t.duration_ms));
    }
    for (const list of byName.values()) list.sort((a, b) => a - b);
    const pct = (sorted: number[] | undefined, p: number) =>
      sorted && sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;
    return rows.map((r) => {
      const list = byName.get(String(r.name));
      return {
        name: String(r.name),
        calls: n(r.calls),
        errors: n(r.errors),
        typicalMs: pct(list, 0.5),
        slowMs: list && list.length >= 5 ? pct(list, 0.95) : null,
        timed: list?.length ?? 0,
        sessions: n(r.sessions),
      };
    });
  }

  /** Each piece of memory: how often it was read and written, and how often it was read in a session that went wrong. */
  async memory(ws: string, since: string) {
    const rows = await this.db.all<Row>(
      `SELECT m.ref, m.source,
              CAST(SUM(CASE WHEN m.op = 'read' THEN 1 ELSE 0 END) AS INTEGER) AS reads,
              CAST(SUM(CASE WHEN m.op = 'write' THEN 1 ELSE 0 END) AS INTEGER) AS writes,
              CAST(COUNT(DISTINCT m.session_id) AS INTEGER) AS sessions,
              MAX(m.at) AS last_at,
              MAX(CASE WHEN m.op = 'write' THEN m.at END) AS last_write
         FROM memory m JOIN sessions s ON s.workspace = m.workspace AND s.id = m.session_id
        WHERE m.workspace = ? AND s.started_at >= ?
        GROUP BY m.ref, m.source ORDER BY sessions DESC, last_at DESC LIMIT 300`,
      [ws, since],
    );
    return rows.map((r) => ({
      ref: String(r.ref),
      source: String(r.source),
      reads: n(r.reads),
      writes: n(r.writes),
      sessions: n(r.sessions),
      lastAt: String(r.last_at),
      lastWrite: (r.last_write as string) ?? null,
    }));
  }

  async projects(ws: string): Promise<string[]> {
    const rows = await this.db.all<Row>("SELECT DISTINCT project FROM sessions WHERE workspace = ? ORDER BY project", [ws]);
    return rows.map((r) => String(r.project));
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

  async createToken(ws: string, person: string, role: "admin" | "member"): Promise<string> {
    const token = `tm_${randomBytes(24).toString("base64url")}`;
    await this.db.run("INSERT INTO tokens (hash, workspace, person, role, created_at) VALUES (?, ?, ?, ?, ?)", [
      hashToken(token), ws, person, role, now(),
    ]);
    return token;
  }

  async tokenOwner(token: string): Promise<{ workspace: string; person: string; role: "admin" | "member" } | null> {
    if (!token.startsWith("tm_")) return null;
    const hash = hashToken(token);
    const rows = await this.db.all<Row>("SELECT workspace, person, role FROM tokens WHERE hash = ?", [hash]);
    if (rows.length === 0) return null;
    await this.db.run("UPDATE tokens SET last_used_at = ? WHERE hash = ?", [now(), hash]);
    return { workspace: String(rows[0].workspace), person: String(rows[0].person), role: rows[0].role as "admin" | "member" };
  }

  async tokenCount(): Promise<number> {
    const [r] = await this.db.all<Row>("SELECT CAST(COUNT(*) AS INTEGER) AS c FROM tokens");
    return n(r?.c);
  }
}
