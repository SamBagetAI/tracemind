/** Issues: opened when first seen, reopened when back, resolved by hand or once they stop happening. */
import { projectName } from "../core/describe.ts";
import { redact } from "../core/redact.ts";
import { DAY } from "../core/time.ts";
import type { Finding } from "../core/types.ts";
import type { Db, Row } from "./db.ts";
import { now, toIssue, type IssueRow } from "./rows.ts";

/** An open issue is resolved by Tracemind once this many sessions in its projects ran without it. */
export const QUIET_SESSIONS = 5;
/** …and the last of them ended at least this long after it was last seen. */
const QUIET_MS = DAY;
/** Who resolved an issue that stopped happening, as the issue page shows it. */
export const AUTO_RESOLVER = "Tracemind";

/**
 * Resolves the open issues that stopped happening: QUIET_SESSIONS sessions in the projects where
 * an issue happened started after it was last seen (and after anyone last reopened it), and none
 * of them had it. It counts as resolved when the last of those sessions ended, so a session that
 * has it again after that reopens it (touchIssue). With `project`, only issues seen there.
 */
export async function autoResolve(db: Db, ws: string, project?: string) {
  // Every open issue with each session it was seen in: its projects, and which sessions had it.
  const seen = await db.all<Row>(
    `SELECT i.key, i.last_seen, i.resolved_at, f.session_id, s.project FROM issues i
       JOIN findings f ON f.workspace = i.workspace AND f.key = i.key
       JOIN sessions s ON s.workspace = f.workspace AND s.id = f.session_id
      WHERE i.workspace = ? AND i.status = 'open'`,
    [ws],
  );
  const issues = new Map<string, { after: string; projects: Set<string>; hit: Set<string> }>();
  for (const r of seen) {
    const key = String(r.key);
    let it = issues.get(key);
    if (!it) {
      // Quiet sessions count from when it was last seen, or from when someone last reopened it.
      const reopenedAt = r.resolved_at ? String(r.resolved_at) : "";
      const after = String(r.last_seen) > reopenedAt ? String(r.last_seen) : reopenedAt;
      issues.set(key, (it = { after, projects: new Set(), hit: new Set() }));
    }
    it.projects.add(String(r.project));
    it.hit.add(String(r.session_id));
  }
  const todo = [...issues].filter(([, it]) => project === undefined || it.projects.has(project));
  if (todo.length === 0) return;
  const from = todo.reduce((min, [, it]) => (it.after < min ? it.after : min), todo[0][1].after);
  const byProject = new Map<string, Row[]>();
  for (const s of await db.all<Row>("SELECT id, project, started_at, ended_at FROM sessions WHERE workspace = ? AND started_at > ? ORDER BY ended_at", [ws, from])) {
    const list = byProject.get(String(s.project)) ?? [];
    list.push(s);
    byProject.set(String(s.project), list);
  }
  const resolve: [string, string, string][] = [];
  for (const [key, it] of todo) {
    const quiet = [...it.projects]
      .flatMap((p) => byProject.get(p) ?? [])
      .filter((s) => String(s.started_at) > it.after && !it.hit.has(String(s.id)))
      .sort((x, y) => (String(x.ended_at) < String(y.ended_at) ? -1 : 1));
    // Enough quiet sessions, and a day of them: a burst of quick follow-ups is not "stopped".
    const settled = quiet.findIndex((q, i) => i + 1 >= QUIET_SESSIONS && Date.parse(String(q.ended_at)) - Date.parse(it.after) >= QUIET_MS);
    if (settled < 0) continue;
    const names = [...new Set(quiet.map((q) => projectName(String(q.project))))];
    const where = names.length === 1 ? `in ${names[0]}` : `in ${names.length} projects`;
    resolve.push([key, String(quiet[settled].ended_at), `Not seen in the ${quiet.length} sessions ${where} since it last happened.`]);
  }
  if (resolve.length === 0) return;
  await db.transaction(async (db) => {
    for (const [key, at, note] of resolve) {
      await db.run(
        "UPDATE issues SET status = 'resolved', resolved_at = ?, resolved_by = ?, note = ?, reopened = 0 WHERE workspace = ? AND key = ? AND status = 'open'",
        [at, AUTO_RESOLVER, note, ws, key],
      );
    }
  });
}

/**
 * Opens an issue the first time it is seen, and reopens a resolved one that is seen again after it
 * was resolved. First seen is when the earliest session with the issue started, and last seen when the latest
 * ended, whatever order sessions are saved in (an import goes by file date, not session date).
 */
export async function touchIssue(db: Db, ws: string, f: Finding, startedAt: string, at: string) {
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

/**
 * Sets issues' first and last seen from the sessions that have them now: when the earliest started
 * and the latest ended. Saving a session only ever widens the two (touchIssue), so this is for when
 * sessions stop having an issue: an import that names an error differently. An issue no session has
 * keeps its dates. With `ws`, that workspace's issues only.
 */
export async function redateIssues(db: Db, ws?: string) {
  const seen = (pick: string) =>
    `(SELECT ${pick} FROM findings f JOIN sessions s ON s.workspace = f.workspace AND s.id = f.session_id
       WHERE f.workspace = issues.workspace AND f.key = issues.key)`;
  await db.run(
    `UPDATE issues SET first_seen = COALESCE(${seen("MIN(s.started_at)")}, first_seen), last_seen = COALESCE(${seen("MAX(s.ended_at)")}, last_seen)${ws === undefined ? "" : " WHERE workspace = ?"}`,
    ws === undefined ? [] : [ws],
  );
}

export async function issues(db: Db, ws: string) {
  const rows = await db.all(
    `SELECT i.*, CAST((SELECT COUNT(*) FROM findings f WHERE f.workspace = i.workspace AND f.key = i.key) AS INTEGER) AS sessions
       FROM issues i WHERE i.workspace = ? ORDER BY i.last_seen DESC`,
    [ws],
  );
  return rows.map(toIssue).sort((a, b) => (a.status === b.status ? 0 : a.status === "open" ? -1 : 1));
}

export async function issue(db: Db, ws: string, key: string): Promise<IssueRow | null> {
  const rows = await db.all(
    `SELECT i.*, CAST((SELECT COUNT(*) FROM findings f WHERE f.workspace = i.workspace AND f.key = i.key) AS INTEGER) AS sessions
       FROM issues i WHERE i.workspace = ? AND i.key = ?`,
    [ws, key],
  );
  return rows[0] ? toIssue(rows[0]) : null;
}

export async function setIssueStatus(db: Db, ws: string, key: string, status: "open" | "resolved", by: string, note: string) {
  if (status === "resolved") {
    await db.run(
      "UPDATE issues SET status = 'resolved', resolved_at = ?, resolved_by = ?, note = ?, reopened = 0 WHERE workspace = ? AND key = ?",
      [now(), by, redact(note).slice(0, 500), ws, key],
    );
  } else {
    // Reopened by hand: Tracemind counts quiet sessions again from now before it resolves it. An
    // issue that was already open keeps its count.
    await db.run("UPDATE issues SET status = 'open', resolved_at = ? WHERE workspace = ? AND key = ? AND status = 'resolved'", [now(), ws, key]);
  }
}
