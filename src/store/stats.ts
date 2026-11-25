/** Totals for a window: the Overview, the Diary's comparison, Tools and Memory. */
import type { Db, Row } from "./db.ts";
import { kindClause, n, type SessionKind } from "./rows.ts";

/**
 * Totals for the sessions that started in the window. `kind` keeps only the sessions a person
 * worked in ("sessions") or only routine runs ("routines"); without it, both.
 */
export async function overview(db: Db, ws: string, since: string, kind?: SessionKind) {
  const k = kindClause(kind);
  const ks = kindClause(kind, "s.");
  const [[totals], days, [open]] = await Promise.all([
    db.all<Row>(
      `SELECT CAST(COUNT(*) AS INTEGER) AS sessions,
              CAST(COALESCE(SUM(CASE WHEN outcome = 'ok' THEN 1 ELSE 0 END), 0) AS INTEGER) AS ok,
              CAST(COALESCE(SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END), 0) AS INTEGER) AS error,
              CAST(COALESCE(SUM(CASE WHEN outcome = 'interrupted' THEN 1 ELSE 0 END), 0) AS INTEGER) AS interrupted,
              CAST(COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM steps st WHERE st.workspace = sessions.workspace AND st.session_id = sessions.id AND st.seq = 1 AND st.kind = 'prompt') THEN 1 ELSE 0 END), 0) AS INTEGER) AS replies,
              CAST(COALESCE(SUM(tool_calls), 0) AS BIGINT) AS tool_calls,
              CAST(COALESCE(SUM(tool_errors), 0) AS BIGINT) AS tool_errors,
              CAST(COALESCE(SUM(input_tokens), 0) AS BIGINT) AS input_tokens,
              CAST(COALESCE(SUM(output_tokens), 0) AS BIGINT) AS output_tokens,
              CAST(COALESCE(SUM(active_ms), 0) AS BIGINT) AS active_ms,
              COALESCE(SUM(cost_usd), 0) AS cost_usd
         FROM sessions WHERE workspace = ? AND started_at >= ?${k.sql}`,
      [ws, since, ...k.params],
    ),
    db.all<Row>(
      `SELECT SUBSTR(s.started_at, 1, 10) AS day, CAST(COUNT(*) AS INTEGER) AS sessions,
              CAST(COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM findings f WHERE f.workspace = s.workspace AND f.session_id = s.id) THEN 1 ELSE 0 END), 0) AS INTEGER) AS failed
         FROM sessions s WHERE s.workspace = ? AND s.started_at >= ?${ks.sql} GROUP BY SUBSTR(s.started_at, 1, 10) ORDER BY day`,
      [ws, since, ...ks.params],
    ),
    db.all<Row>("SELECT CAST(COUNT(*) AS INTEGER) AS open FROM issues WHERE workspace = ? AND status = 'open'", [ws]),
  ]);
  return {
    sessions: n(totals?.sessions),
    ok: n(totals?.ok),
    error: n(totals?.error),
    interrupted: n(totals?.interrupted),
    /** Sessions whose first step is a person's prompt: for routine runs, the turns a person started (a reply), not the schedule. */
    replies: n(totals?.replies),
    toolCalls: n(totals?.tool_calls),
    toolErrors: n(totals?.tool_errors),
    inputTokens: n(totals?.input_tokens),
    outputTokens: n(totals?.output_tokens),
    activeMs: n(totals?.active_ms),
    costUsd: Number(totals?.cost_usd ?? 0),
    openIssues: n(open?.open),
    /** Sessions where at least one failure was found. */
    withIssues: days.reduce((sum, d) => sum + n(d.failed), 0),
    days: days.map((d) => ({ day: String(d.day), sessions: n(d.sessions), failed: n(d.failed) })),
  };
}

/** The sums the Diary compares with the period before: sessions that started in [since, until). */
export async function totals(db: Db, ws: string, since: string, until: string, kind?: SessionKind) {
  const k = kindClause(kind, "s.");
  const [r] = await db.all<Row>(
    `SELECT CAST(COUNT(*) AS INTEGER) AS sessions,
            CAST(COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM findings f WHERE f.workspace = s.workspace AND f.session_id = s.id) THEN 1 ELSE 0 END), 0) AS INTEGER) AS with_issues,
            CAST(COALESCE(SUM(s.active_ms), 0) AS BIGINT) AS active_ms,
            CAST(COALESCE(SUM(s.tool_errors), 0) AS BIGINT) AS tool_errors,
            CAST(COALESCE(SUM(s.output_tokens), 0) AS BIGINT) AS output_tokens,
            COALESCE(SUM(s.cost_usd), 0) AS cost_usd
       FROM sessions s WHERE s.workspace = ? AND s.started_at >= ? AND s.started_at < ?${k.sql}`,
    [ws, since, until, ...k.params],
  );
  return {
    sessions: n(r?.sessions),
    withIssues: n(r?.with_issues),
    activeMs: n(r?.active_ms),
    toolErrors: n(r?.tool_errors),
    outputTokens: n(r?.output_tokens),
    costUsd: Number(r?.cost_usd ?? 0),
  };
}

/**
 * Calls, failures and run times per tool, for the sessions that started in the window: the same
 * sessions the Overview and the Sessions list count, so the rows add up to their totals.
 * Typical is the median, slow the 95th percentile, of the calls whose run time is known.
 */
export async function tools(db: Db, ws: string, since: string, kind?: SessionKind) {
  const k = kindClause(kind);
  const inWindow = `SELECT id FROM sessions WHERE workspace = ? AND started_at >= ?${k.sql}`;
  const rows = await db.all<Row>(
    `SELECT name, CAST(COUNT(*) AS INTEGER) AS calls,
            CAST(SUM(is_error) AS INTEGER) AS errors,
            CAST(COUNT(DISTINCT session_id) AS INTEGER) AS sessions
       FROM steps WHERE workspace = ? AND kind IN ('tool', 'subagent') AND session_id IN (${inWindow})
      GROUP BY name ORDER BY calls DESC`,
    [ws, ws, since, ...k.params],
  );
  const times = await db.all<Row>(
    `SELECT name, duration_ms FROM steps WHERE workspace = ? AND kind IN ('tool', 'subagent') AND session_id IN (${inWindow}) AND duration_ms IS NOT NULL`,
    [ws, ws, since, ...k.params],
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
export async function memory(db: Db, ws: string, since: string) {
  const rows = await db.all<Row>(
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
