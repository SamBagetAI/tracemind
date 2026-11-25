/** Row helpers and the shapes rows are read into, shared by the store's modules. */
import { ROUTINE_AGENT } from "../core/parse-routine.ts";
import type { Brief, IssueKind, Outcome, Session } from "../core/types.ts";
import type { Db, Row } from "./db.ts";

const CHUNK = 200;

/** A number from a row's column, 0 for NULL (Postgres returns BIGINT as a string). */
export const n = (v: unknown): number => (v == null ? 0 : Number(v));
export const now = () => new Date().toISOString();

/** The tables that hold a session's rows, besides `sessions` itself. */
export const SESSION_TABLES = ["steps", "memory", "findings"] as const;

/** Deletes a session and everything saved with it. */
export async function deleteSession(db: Db, ws: string, id: string) {
  for (const t of SESSION_TABLES) await db.run(`DELETE FROM ${t} WHERE workspace = ? AND session_id = ?`, [ws, id]);
  await db.run("DELETE FROM sessions WHERE workspace = ? AND id = ?", [ws, id]);
}

export async function insertMany(db: Db, table: string, cols: string[], rows: unknown[][]) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const one = `(${cols.map(() => "?").join(", ")})`;
    await db.run(
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES ${chunk.map(() => one).join(", ")}`,
      chunk.flat(),
    );
  }
}

export function toSession(r: Row): Session & { receivedAt: string; pushedAt: string | null; issueCount: number } {
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

export function toIssue(r: Row): IssueRow {
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

/** Sessions a person worked in, or runs of a claude.ai routine (src/core/parse-routine.ts). */
export type SessionKind = "sessions" | "routines";
export { ROUTINE_AGENT };
/** The SQL that keeps only a person's sessions or only routine runs (nothing for both), and its parameter. */
export function kindClause(kind: SessionKind | undefined, prefix = ""): { sql: string; params: unknown[] } {
  if (kind === "routines") return { sql: ` AND ${prefix}agent = ?`, params: [ROUTINE_AGENT] };
  if (kind === "sessions") return { sql: ` AND ${prefix}agent <> ?`, params: [ROUTINE_AGENT] };
  return { sql: "", params: [] };
}
