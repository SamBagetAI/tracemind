/** The Sessions page's filters: applied in the browser, to the list the window gives. */
import { describe, expect, it } from "vitest";
import { ALL, filterSessions, peopleOf, type SessionFilter } from "../web/src/lib/sessions";

const session = (id: string, person: string, project: string, title: string, issueCount: number) => ({ id, person, project, title, issueCount });
const list = [
  session("a", "Ada", "/work/shop", "Fix promo codes", 2),
  session("b", "Grace", "/work/shop", "Add refunds", 0),
  session("c", "Ada", "/work/docs", "Write the guide", 0),
  session("d", "Grace", "/work/docs", "Fix broken links", 1),
];
const kept = (f: Partial<SessionFilter> = {}) => filterSessions(list, { project: ALL, person: ALL, show: "all", q: "", ...f }).map((s) => s.id);

describe("the Sessions page's filters", () => {
  it("keep every session when nothing is chosen", () => {
    expect(kept()).toEqual(["a", "b", "c", "d"]);
  });

  it("keep one person's sessions", () => {
    expect(kept({ person: "Grace" })).toEqual(["b", "d"]);
    expect(kept({ person: "Nobody" })).toEqual([]);
  });

  it("keep a project, the sessions that hit an issue or ran clean, and words in the title", () => {
    expect(kept({ project: "/work/docs" })).toEqual(["c", "d"]);
    expect(kept({ show: "issues" })).toEqual(["a", "d"]);
    expect(kept({ show: "clean" })).toEqual(["b", "c"]);
    expect(kept({ q: "FIX" })).toEqual(["a", "d"]);
  });

  it("apply them together", () => {
    expect(kept({ person: "Grace", project: "/work/docs", show: "issues", q: "links" })).toEqual(["d"]);
    expect(kept({ person: "Ada", show: "issues", project: "/work/docs" })).toEqual([]);
  });

  it("offer the people in the list by name, each once", () => {
    expect(peopleOf(list)).toEqual(["Ada", "Grace"]);
    expect(peopleOf([list[0]])).toEqual(["Ada"]);
    expect(peopleOf([])).toEqual([]);
  });
});
