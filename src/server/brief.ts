/** The session-start brief: what a Claude Code hook tells each new session about its project. */
import { CAUSE, causeKey, describeIssue } from "../core/describe.ts";
import { daysAgo } from "../core/time.ts";
import type { Row } from "../store/db.ts";
import type { Store } from "../store/store.ts";
import { GLOBAL_RULES, projectRoot } from "./suggestions.ts";

/** What to tell an agent about each known cause, for the SessionStart hook. */
const ADVICE: Record<string, string> = Object.fromEntries(GLOBAL_RULES.map((r) => [r.what, r.text]));
ADVICE[CAUSE.classifier] = "Expect refusals for production data, shared resources and deploys: ask the person instead of retrying another way.";
ADVICE[CAUSE.notSignedIn] = "Some connectors here are not signed in: if a call says unauthorized, tell the person instead of retrying.";

/** The text a new session gets: up to five problems from its own project's recent sessions. */
export async function sessionContext(store: Store, ws: string, cwd: string): Promise<string> {
  const root = projectRoot(cwd);
  if (!root) return "";
  const since = daysAgo(30);
  const ids = (await store.db.all<Row>("SELECT id, project FROM sessions WHERE workspace = ? AND started_at >= ?", [ws, since]))
    .filter((r) => projectRoot(String(r.project)) === root)
    .map((r) => String(r.id));
  if (ids.length < 3) return "";
  const idSet = new Set(ids);
  const rows = await store.db.all<Row>(
    `SELECT f.key, f.session_id, i.kind, i.title FROM findings f JOIN issues i ON i.workspace = f.workspace AND i.key = f.key
       JOIN sessions s ON s.workspace = f.workspace AND s.id = f.session_id
      WHERE f.workspace = ? AND s.started_at >= ? AND i.kind <> 'interrupted' AND i.status = 'open'`,
    [ws, since],
  );
  const byCause = new Map<string, { what: string; sessions: Set<string> }>();
  for (const r of rows) {
    if (!idSet.has(String(r.session_id))) continue;
    const issue = { kind: r.kind as never, title: String(r.title) };
    const d = describeIssue(issue);
    // Only causes Tracemind has a name for. An unnamed one is the error's own words, which can come
    // from anywhere (a page the agent fetched, a tool's output): never said to a session as advice.
    if (!d.plain) continue;
    const k = causeKey(issue, d);
    const e = byCause.get(k) ?? { what: d.what, sessions: new Set<string>() };
    e.sessions.add(String(r.session_id));
    byCause.set(k, e);
  }
  // A bare exit code is mostly grep or a test finding nothing: not worth a new session's attention.
  const top = [...byCause.values()]
    .filter((e) => e.sessions.size >= 3 && e.what !== CAUSE.exitCode)
    .sort((a, b) => b.sessions.size - a.sessions.size)
    .slice(0, 5);
  if (top.length === 0) return "";
  const lines = top.map((e) => `- ${e.what} (${e.sessions.size} of the last ${ids.length} sessions here)${ADVICE[e.what] ? `: ${ADVICE[e.what]}` : "."}`);
  return `Tracemind, from this project's recent Claude Code sessions. ${lines.length === 1 ? "This keeps going wrong here:" : "These keep going wrong here:"}\n${lines.join("\n")}`;
}
