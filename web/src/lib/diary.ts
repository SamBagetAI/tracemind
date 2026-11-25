/**
 * The Diary home: sessions grouped by day, each told in one sentence. Pure functions, tested in
 * test/diary.test.ts.
 */
import type { Session, SessionIssue } from "./api";
import { DAY, plural } from "./format";

/** A piece of a sentence: plain words, or an issue to highlight (and link to its page). */
export type Part = { text: string } | { mark: string; key: string; step?: number };

/** "26 failed calls: [Page had no readable text], [Exited with an error code] and 1 more." */
export function sentence(s: Pick<Session, "toolErrors"> & { issues?: SessionIssue[] }): Part[] {
  const issues = s.issues ?? [];
  const failed = s.toolErrors;
  if (failed === 0 && issues.length === 0) return [{ text: "Ran clean." }];
  const lead = failed === 0 ? "No call failed, but" : plural(failed, "failed call");
  if (issues.length === 0) return [{ text: `${lead}.` }];
  const shown = issues.slice(0, 2);
  const parts: Part[] = [{ text: failed === 0 ? `${lead} ` : `${lead}: ` }];
  shown.forEach((i, k) => {
    if (k > 0) parts.push({ text: k === shown.length - 1 && issues.length <= 2 ? " and " : ", " });
    // Only a named issue gets the highlighter; an error without a name is said plainly.
    parts.push(i.named === false ? { text: "an error without a name yet" } : { mark: i.what, key: i.key, step: i.seq });
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

/** "Today", "Yesterday", "Mon 23", "Wed 18 Nov" when it is not this month. `day` is a local YYYY-MM-DD. */
export function relativeDay(day: string, now = new Date(), toDay = localDay): string {
  const today = toDay(now.toISOString());
  const yesterday = toDay(new Date(now.getTime() - DAY).toISOString());
  if (day === today) return "Today";
  if (day === yesterday) return "Yesterday";
  const d = new Date(`${day}T12:00:00Z`);
  const wd = d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
  const dd = d.getUTCDate();
  const sameMonth = d.getUTCMonth() === now.getUTCMonth() && d.getUTCFullYear() === now.getUTCFullYear();
  return sameMonth ? `${wd} ${dd}` : `${wd} ${dd} ${d.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })}`;
}

/** A date as YYYY-MM-DD in the viewer's own time zone. */
export const localDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA");

/**
 * Sessions by the day they were last active, in the viewer's time zone, newest first: a session
 * that ran from the 15th to the 24th belongs with the 24th, where its work ended.
 */
export function byDay<T extends Pick<Session, "endedAt">>(sessions: T[], day = (s: T) => localDay(s.endedAt)): { day: string; sessions: T[] }[] {
  const days = new Map<string, T[]>();
  for (const s of [...sessions].sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1))) {
    const d = day(s);
    days.set(d, [...(days.get(d) ?? []), s]);
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

/**
 * The sessions worth a look: the ones with the most failed calls (the longer one first on a tie),
 * at most `n`, never a clean one. The rest are counted, not listed.
 */
export function worthALook<T extends Pick<Session, "toolErrors" | "activeMs"> & { issues?: SessionIssue[] }>(sessions: T[], n = 3): { top: T[]; rest: T[] } {
  const bad = (s: T) => s.toolErrors > 0 || (s.issues?.length ?? 0) > 0;
  const top = sessions
    .filter(bad)
    .sort((a, b) => b.toolErrors - a.toolErrors || b.activeMs - a.activeMs)
    .slice(0, n);
  const picked = new Set(top);
  return { top, rest: sessions.filter((s) => !picked.has(s)) };
}
