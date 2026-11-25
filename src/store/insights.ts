/**
 * Queries that look across sessions: issues grouped by cause with exact session counts and a
 * daily history, what failing sessions knew compared with the others, where failures sit in each
 * session, and the raw facts suggestions are made from.
 */
import { causeKey, describeIssue, KIND, topTools, type IssueKind } from "../core/describe.ts";
import type { Row } from "./db.ts";
import type { IssueRow, Store } from "./store.ts";

const n = (v: unknown): number => (v == null ? 0 : Number(v));
const DAY = 86400000;

export type IssueGroup = {
  id: string;
  kind: IssueKind;
  kindLabel: string;
  what: string;
  /** False when the name is the error's own words rather than a known cause. */
  plain: boolean;
  raw: string;
  tools: string;
  /** Distinct sessions in the window that hit any issue of this cause. */
  sessions: number;
  /** Distinct sessions per day over the window, oldest first. */
  daily: number[];
  firstSeen: string;
  lastSeen: string;
  status: "open" | "resolved";
  reopened: boolean;
  issues: (IssueRow & { windowSessions: number; tool: string })[];
};

export function days(since: string, until = Date.now()): string[] {
  const out: string[] = [];
  const start = Date.parse(since.slice(0, 10) + "T00:00:00Z");
  for (let t = start; t <= until; t += DAY) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** Findings in the window: which session hit which issue, and on which day. */
async function findingRows(store: Store, ws: string, since: string, keys?: string[], until?: string) {
  const params: unknown[] = [ws, since];
  let only = until ? (params.push(until), " AND s.started_at < ?") : "";
  if (keys) {
    if (keys.length === 0) return [];
    only += ` AND f.key IN (${keys.map(() => "?").join(", ")})`;
    params.push(...keys);
  }
  return store.db.all<Row>(
    `SELECT f.key, f.session_id, SUBSTR(s.started_at, 1, 10) AS day
       FROM findings f JOIN sessions s ON s.workspace = f.workspace AND s.id = f.session_id
      WHERE f.workspace = ? AND s.started_at >= ?${only}`,
    params,
  );
}

/** Issues grouped by cause, with counts over the window. Groups with no session in the window are left out. */
export async function issueGroups(store: Store, ws: string, since: string, status?: "open" | "resolved", until?: string): Promise<IssueGroup[]> {
  const issues = await store.issues(ws);
  const rows = await findingRows(store, ws, since, undefined, until);
  // Per-day counts cover at most the last year, whatever the window (an all-time query starts in year 0).
  const yearAgo = new Date(Date.now() - 365 * DAY).toISOString();
  const dayList = days(since < yearAgo ? yearAgo : since);
  const dayIndex = new Map(dayList.map((d, i) => [d, i]));
  const byKey = new Map<string, Row[]>();
  for (const r of rows) {
    const k = String(r.key);
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }

  const groups = new Map<string, IssueGroup & { sessionSet: Set<string>; daySets: Set<string>[] }>();
  for (const issue of issues) {
    const hits = byKey.get(issue.key) ?? [];
    if (hits.length === 0) continue;
    const d = describeIssue(issue);
    const id = causeKey(issue, d);
    let g = groups.get(id);
    if (!g) {
      g = {
        id, kind: issue.kind, kindLabel: KIND[issue.kind], what: d.what, plain: d.plain, raw: d.raw, tools: "",
        sessions: 0, daily: [], firstSeen: issue.firstSeen, lastSeen: issue.lastSeen, status: "resolved", reopened: false, issues: [],
        sessionSet: new Set(), daySets: dayList.map(() => new Set<string>()),
      };
      groups.set(id, g);
    }
    const windowSessions = new Set(hits.map((h) => String(h.session_id)));
    g.issues.push({ ...issue, windowSessions: windowSessions.size, tool: d.tool });
    for (const h of hits) {
      g.sessionSet.add(String(h.session_id));
      const i = dayIndex.get(String(h.day));
      if (i != null) g.daySets[i].add(String(h.session_id));
    }
    if (issue.firstSeen < g.firstSeen) g.firstSeen = issue.firstSeen;
    if (issue.lastSeen > g.lastSeen) g.lastSeen = issue.lastSeen;
    if (issue.status === "open") g.status = "open";
    if (issue.reopened) g.reopened = true;
  }

  return [...groups.values()]
    .map(({ sessionSet, daySets, ...g }) => ({
      ...g,
      sessions: sessionSet.size,
      daily: daySets.map((s) => s.size),
      tools: topTools(g.issues.map((i) => ({ tool: i.tool, sessions: i.windowSessions }))),
      issues: g.issues.sort((a, b) => b.windowSessions - a.windowSessions),
    }))
    .filter((g) => !status || g.status === status)
    .sort((a, b) => b.sessions - a.sessions || (a.lastSeen < b.lastSeen ? 1 : -1));
}

/** Distinct sessions per day over the window that hit any of the issues. */
export async function issueHistory(store: Store, ws: string, keys: string | string[], since: string) {
  const rows = await findingRows(store, ws, since, Array.isArray(keys) ? keys : [keys]);
  const list = days(since);
  const sets = new Map<string, Set<string>>();
  for (const r of rows) {
    const d = String(r.day);
    if (!sets.has(d)) sets.set(d, new Set());
    sets.get(d)!.add(String(r.session_id));
  }
  return list.map((day) => ({ day, sessions: sets.get(day)?.size ?? 0 }));
}

export async function issueContext(store: Store, ws: string, keys: string | string[]) {
  const ks = Array.isArray(keys) ? keys : [keys];
  if (ks.length === 0) return { hit: 0, others: 0, rows: [] };
  const hit = (
    await store.db.all<Row>(`SELECT DISTINCT session_id FROM findings WHERE workspace = ? AND key IN (${ks.map(() => "?").join(", ")})`, [ws, ...ks])
  ).map((r) => String(r.session_id));
  if (hit.length === 0) return { hit: 0, others: 0, rows: [] };
  const ph = hit.map(() => "?").join(", ");
  const projects = (await store.db.all<Row>(`SELECT DISTINCT project FROM sessions WHERE workspace = ? AND id IN (${ph})`, [ws, ...hit])).map((r) => String(r.project));
  const others = (
    await store.db.all<Row>(
      `SELECT id FROM sessions WHERE workspace = ? AND project IN (${projects.map(() => "?").join(", ")}) AND id NOT IN (${ph})`,
      [ws, ...projects, ...hit],
    )
  ).map((r) => String(r.id));
  const all = [...hit, ...others];
  const reads = await store.db.all<Row>(
    `SELECT DISTINCT session_id, source, ref FROM memory WHERE workspace = ? AND op = 'read' AND session_id IN (${all.map(() => "?").join(", ")})`,
    [ws, ...all],
  );
  const hitSet = new Set(hit);
  const byRef = new Map<string, { ref: string; source: string; hit: number; others: number }>();
  for (const r of reads) {
    const k = `${r.source}\n${r.ref}`;
    const e = byRef.get(k) ?? { ref: String(r.ref), source: String(r.source), hit: 0, others: 0 };
    if (hitSet.has(String(r.session_id))) e.hit++;
    else e.others++;
    byRef.set(k, e);
  }
  const rows = [...byRef.values()]
    .map((e) => ({ ...e, hitShare: e.hit / hit.length, otherShare: others.length ? e.others / others.length : null }))
    .sort((a, b) => Math.abs(b.hitShare - (b.otherShare ?? 0)) - Math.abs(a.hitShare - (a.otherShare ?? 0)))
    .slice(0, 12);
  return { hit: hit.length, others: others.length, rows };
}

/** Where each session failed, as positions along the session (0 to 1), for a small strip per row. */
export async function failureMarks(store: Store, ws: string, sessions: { id: string; stepCount: number }[]) {
  const out: Record<string, { at: number; kind: "error" | "interrupt" }[]> = {};
  if (sessions.length === 0) return out;
  const steps = new Map(sessions.map((s) => [s.id, Math.max(1, s.stepCount)]));
  const rows = await store.db.all<Row>(
    `SELECT session_id, seq, kind FROM steps WHERE workspace = ? AND (is_error = 1 OR kind = 'interrupt')
        AND session_id IN (${sessions.map(() => "?").join(", ")})`,
    [ws, ...sessions.map((s) => s.id)],
  );
  for (const r of rows) {
    const id = String(r.session_id);
    (out[id] ??= []).push({ at: (n(r.seq) - 1) / steps.get(id)!, kind: r.kind === "interrupt" ? "interrupt" : "error" });
  }
  return out;
}

/** Drops issues no session points at any more (after a re-import changed how an error is named). */
export async function pruneIssues(store: Store, ws: string) {
  await store.db.run(
    "DELETE FROM issues WHERE workspace = ? AND NOT EXISTS (SELECT 1 FROM findings f WHERE f.workspace = issues.workspace AND f.key = issues.key)",
    [ws],
  );
}

/**
 * One cause, everything a page needs about it, from the same query the Issues list uses: the
 * window's count, the all-time count, the history (whose bars add up to the window's count), the
 * sessions, what they had loaded, and its variants.
 */
export async function causeDetail(store: Store, ws: string, key: string, since: string) {
  const allTime = await issueGroups(store, ws, "0000");
  const g = allTime.find((x) => x.issues.some((i) => i.key === key));
  if (!g) return null;
  const inWindow = (await issueGroups(store, ws, since)).find((x) => x.id === g.id);
  const keys = g.issues.map((i) => i.key);
  const ph = keys.map(() => "?").join(", ");
  const sessions = await store.db.all<Row>(
    `SELECT s.id, s.title, s.project, s.person, s.started_at, s.ended_at, MIN(f.seq) AS seq
       FROM findings f JOIN sessions s ON s.workspace = f.workspace AND s.id = f.session_id
      WHERE f.workspace = ? AND f.key IN (${ph})
      GROUP BY s.id, s.title, s.project, s.person, s.started_at, s.ended_at ORDER BY s.ended_at DESC LIMIT 200`,
    [ws, ...keys],
  );
  const history = await issueHistory(store, ws, keys, since);
  const latest = sessions[0];
  const [step] = latest
    ? await store.db.all<Row>("SELECT output FROM steps WHERE workspace = ? AND session_id = ? AND seq = ?", [ws, latest.id, latest.seq])
    : [];
  return {
    cause: { ...g, sessions: inWindow?.sessions ?? 0, daily: inWindow?.daily ?? [] },
    allTimeSessions: g.sessions,
    history,
    example: step ? String(step.output).slice(0, 2000) : null,
    sessions: sessions.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      project: String(r.project),
      person: String(r.person),
      startedAt: String(r.started_at),
      endedAt: String(r.ended_at),
      seq: n(r.seq),
    })),
  };
}

/** For each issue key: its cause and how many sessions the cause hit in the window. */
export async function causeCounts(store: Store, ws: string, since: string) {
  const out = new Map<string, { cause: string; what: string; sessions: number }>();
  for (const g of await issueGroups(store, ws, since)) for (const i of g.issues) out.set(i.key, { cause: g.id, what: g.what, sessions: g.sessions });
  return out;
}

/**
 * For each session, the issues it hit, one per cause, in the order it first hit them, with the
 * step. What a sentence about the session says went wrong.
 */
export async function sessionIssues(store: Store, ws: string, ids: string[]) {
  const out: Record<string, { what: string; seq: number; key: string }[]> = {};
  if (ids.length === 0) return out;
  const rows = await store.db.all<Row>(
    `SELECT f.session_id, f.seq, f.key, i.kind, i.title FROM findings f JOIN issues i ON i.workspace = f.workspace AND i.key = f.key
      WHERE f.workspace = ? AND f.session_id IN (${ids.map(() => "?").join(", ")}) ORDER BY f.session_id, f.seq`,
    [ws, ...ids],
  );
  for (const r of rows) {
    const d = describeIssue({ kind: r.kind as never, title: String(r.title) });
    const list = (out[String(r.session_id)] ??= []);
    const what = d.plain ? d.what : "an error without a name yet";
    if (!list.some((x) => x.what === what)) list.push({ what, seq: n(r.seq), key: String(r.key) });
  }
  return out;
}
