/** Creates the tables and brings databases made by older versions up to date. */
import { ROUTINE_AGENT, routineRunId, routineSessionOf } from "../core/parse-routine.ts";
import type { Db, Row } from "./db.ts";
import { autoResolve } from "./issues.ts";
import { deleteSession, n, SESSION_TABLES } from "./rows.ts";
import { SCHEMA } from "./schema.ts";

export async function migrate(db: Db) {
  await db.exec(SCHEMA);
  // Issue numbers came after the first release: add the column to older databases and number
  // the issues they already have, oldest first.
  try {
    await db.exec("ALTER TABLE issues ADD COLUMN num INTEGER");
  } catch {
    // Already there.
  }
  // Active time and estimated cost came later too; `tracemind import` fills them for old sessions.
  for (const col of ["active_ms BIGINT NOT NULL DEFAULT 0", "cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0", "brief TEXT"]) {
    try {
      await db.exec(`ALTER TABLE sessions ADD COLUMN ${col}`);
    } catch {
      // Already there.
    }
  }
  // Routine runs were first keyed by when they started; they are keyed by when they ended now
  // (src/core/parse-routine.ts), so the same run imported again replaces itself. One run's end
  // can be the next run's start, so every run moves to a temporary id first, then to its new id;
  // only two rows that end up with the same id (the same run imported twice) are merged.
  const runs = await db.all<Row>("SELECT workspace, id, ended_at, step_count FROM sessions WHERE agent = ? ORDER BY step_count DESC", [ROUTINE_AGENT]);
  const moves = runs
    .map((r) => {
      const session = routineSessionOf(String(r.id));
      return session ? { ws: String(r.workspace), id: String(r.id), next: routineRunId(session, String(r.ended_at)) } : null;
    })
    .filter((x): x is { ws: string; id: string; next: string } => !!x && x.next !== x.id);
  if (moves.length > 0) {
    await db.transaction(async (db) => {
      const rename = async (ws: string, from: string, to: string) => {
        for (const t of SESSION_TABLES) await db.run(`UPDATE ${t} SET session_id = ? WHERE workspace = ? AND session_id = ?`, [to, ws, from]);
        await db.run("UPDATE sessions SET id = ? WHERE workspace = ? AND id = ?", [to, ws, from]);
      };
      for (const m of moves) await rename(m.ws, m.id, `moving-${m.id}`);
      const taken = new Set((await db.all<Row>("SELECT workspace, id FROM sessions")).map((r) => `${r.workspace} ${r.id}`));
      // Runs come with the most steps first, so a duplicate keeps its fuller copy.
      for (const m of moves) {
        if (taken.has(`${m.ws} ${m.next}`)) await deleteSession(db, m.ws, `moving-${m.id}`);
        else {
          await rename(m.ws, `moving-${m.id}`, m.next);
          taken.add(`${m.ws} ${m.next}`);
        }
      }
    });
  }
  // Repair first/last seen from the sessions (older versions kept the first-saved session's date).
  await db.run(
    `UPDATE issues SET
       first_seen = COALESCE((SELECT MIN(s.started_at) FROM findings f JOIN sessions s ON s.workspace = f.workspace AND s.id = f.session_id
                               WHERE f.workspace = issues.workspace AND f.key = issues.key), first_seen),
       last_seen = COALESCE((SELECT MAX(s.ended_at) FROM findings f JOIN sessions s ON s.workspace = f.workspace AND s.id = f.session_id
                              WHERE f.workspace = issues.workspace AND f.key = issues.key), last_seen)`,
  );
  // Issues that stopped happening before Tracemind resolved them on its own.
  const spaces = await db.all<Row>("SELECT DISTINCT workspace FROM issues WHERE status = 'open'");
  for (const r of spaces) await autoResolve(db, String(r.workspace));
  const missing = await db.all<Row>("SELECT workspace, key FROM issues WHERE num IS NULL ORDER BY workspace, first_seen, key");
  if (missing.length === 0) return;
  await db.transaction(async (db) => {
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
