/**
 * The Diary home: sessions grouped by day, each told in one sentence. Pure functions, tested in
 * test/diary.test.ts.
 */
import type { Session, SessionIssue } from "./api";

/** A piece of a sentence: plain words, or an issue to highlight (and link to its page). */
export type Part = { text: string } | { mark: string; key: string; step?: number };

/** "26 failed calls: [Page had no readable text], [Exited with an error code] and 1 more." */
export function sentence(s: Pick<Session, "toolErrors"> & { issues?: SessionIssue[] }): Part[] {
  const issues = s.issues ?? [];
  const failed = s.toolErrors;
  if (failed === 0 && issues.length === 0) return [{ text: "Ran clean." }];
  const lead = failed === 0 ? "No call failed, but" : failed === 1 ? "1 failed call" : `${failed.toLocaleString("en-US")} failed calls`;
  if (issues.length === 0) return [{ text: `${lead}.` }];
  const shown = issues.slice(0, 2);
  const parts: Part[] = [{ text: failed === 0 ? `${lead} ` : `${lead}: ` }];
  shown.forEach((i, k) => {
    if (k > 0) parts.push({ text: k === shown.length - 1 && issues.length <= 2 ? " and " : ", " });
    parts.push({ mark: i.what, key: i.key, step: i.seq });
  });
  const more = issues.length - shown.length;
  parts.push({ text: more > 0 ? ` and ${more} more.` : "." });
  return parts;
}

/** "4 h 55", "22 min", "under a minute". */
export function activeLabel(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 1) return "under a minute";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h`;
}

/** "Today", "Yesterday", "Mon 23", "Wed 18 Nov" when it is not this month. */
export function dayLabel(day: string, now = new Date()): string {
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
  if (day === today) return "Today";
  if (day === yesterday) return "Yesterday";
  const d = new Date(`${day}T12:00:00Z`);
  const wd = d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
  const dd = d.getUTCDate();
  const sameMonth = d.getUTCMonth() === now.getUTCMonth() && d.getUTCFullYear() === now.getUTCFullYear();
  return sameMonth ? `${wd} ${dd}` : `${wd} ${dd} ${d.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })}`;
}

/** Sessions by the day they started, newest day first, newest session first within a day. */
export function byDay<T extends Pick<Session, "startedAt">>(sessions: T[]): { day: string; sessions: T[] }[] {
  const days = new Map<string, T[]>();
  for (const s of [...sessions].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))) {
    const day = s.startedAt.slice(0, 10);
    days.set(day, [...(days.get(day) ?? []), s]);
  }
  return [...days.entries()].map(([day, list]) => ({ day, sessions: list }));
}

/** "1.4M", "880k", "950". */
export function tokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

/** "$152", "$0.79". */
export function dollars(n: number): string {
  return n >= 10 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`;
}
