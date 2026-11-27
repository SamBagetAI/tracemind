/**
 * The Sessions page's filters. They are applied in the browser to the list the window gives, so a
 * choice shows at once, without asking the server again. Pure, tested in test/sessions.test.ts.
 */

/** Every project, or everyone: the choice that keeps all of them. */
export const ALL = "__all";

/** `show` is "all", "issues" (hit an issue) or "clean". An empty `q` keeps every title. */
export type SessionFilter = { project: string; person: string; show: string; q: string };

export function filterSessions<T extends { project: string; person: string; title: string; issueCount: number }>(list: T[], f: SessionFilter): T[] {
  const q = f.q.toLowerCase();
  return list.filter(
    (s) =>
      (f.project === ALL || s.project === f.project) &&
      (f.person === ALL || s.person === f.person) &&
      (f.show === "all" || (f.show === "issues" ? s.issueCount > 0 : s.issueCount === 0)) &&
      (!q || s.title.toLowerCase().includes(q)),
  );
}

/** The people in a list, by name: what the person filter offers. With one person there is nothing to choose. */
export function peopleOf(list: { person: string }[]): string[] {
  return [...new Set(list.map((s) => s.person))].sort((a, b) => a.localeCompare(b));
}
