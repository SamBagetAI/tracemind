import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseClaudeSession } from "../src/core/parse-claude.ts";
import type { Trace } from "../src/core/types.ts";
import { type Db, fromPgQueryable, openSqlite, toPg } from "../src/store/db.ts";
import { AUTO_RESOLVER, QUIET_SESSIONS, Store } from "../src/store/store.ts";
import { mainTranscript, subagentTranscript } from "./fixtures/session.ts";

const trace = () => parseClaudeSession("sess-1", mainTranscript(), { person: "Ada", subagents: [subagentTranscript()] });

function later(t: Trace, id: string, iso: string): Trace {
  return { ...t, session: { ...t.session, id, startedAt: iso, endedAt: iso } };
}

/** The same session without anything going wrong, at a time `days` from now, in `project` if given. */
function clean(t: Trace, id: string, days: number, project?: string): Trace {
  const iso = new Date(Date.now() + days * 86400_000).toISOString();
  return { ...t, steps: t.steps.map((x) => ({ ...x, isError: false })), findings: [], session: { ...t.session, id, startedAt: iso, endedAt: iso, ...(project ? { project } : {}) } };
}

const dbs: [string, () => Promise<Db>][] = [
  ["sqlite", () => openSqlite(join(mkdtempSync(join(tmpdir(), "tm-")), "t.db"))],
  ["postgres", async () => fromPgQueryable(new PGlite() as any)],
];

it("turns ? into numbered parameters for Postgres", () => {
  expect(toPg("a = ? AND b = ?")).toBe("a = $1 AND b = $2");
});

describe.each(dbs)("Store on %s", (_, open) => {
  async function store() {
    const s = new Store(await open());
    await s.migrate();
    await s.migrate(); // migrating twice is fine
    return s;
  }

  it("saves a trace and reads it back", async () => {
    const s = await store();
    const t = trace();
    await s.saveTrace("w", t);
    const back = await s.trace("w", "sess-1");
    expect(back?.session.title).toBe("Fix promo code check");
    expect(back?.steps.length).toBe(t.steps.length);
    expect(back?.steps.find((x) => x.isError)?.name).toBe("Bash");
    expect(back?.memory.length).toBe(t.memory.length);
    expect(back?.findings.length).toBe(4);
    expect(Object.values(back!.issues).every((v) => v.status === "open" && v.sessions === 1 && v.num > 0)).toBe(true);
  });

  it("replaces a session saved twice and keeps workspaces apart", async () => {
    const s = await store();
    await s.saveTrace("w", trace());
    await s.saveTrace("w", trace());
    expect((await s.sessions("w")).length).toBe(1);
    expect((await s.issues("w")).length).toBe(4);
    expect(await s.trace("other", "sess-1")).toBeNull();
    expect((await s.sessions("other")).length).toBe(0);
  });

  it("reopens a resolved issue when it happens again later", async () => {
    const s = await store();
    await s.saveTrace("w", trace());
    const issue = (await s.issues("w")).find((i) => i.kind === "tool_error")!;
    await s.setIssueStatus("w", issue.key, "resolved", "Ada", "fixed the import");
    expect((await s.issue("w", issue.key))?.issue.status).toBe("resolved");

    // A session from before the fix does not reopen it…
    await s.saveTrace("w", later(trace(), "old", "2000-01-01T00:00:00.000Z"));
    expect((await s.issue("w", issue.key))?.issue.status).toBe("resolved");

    // …one after it does.
    await s.saveTrace("w", later(trace(), "new", "2999-01-01T00:00:00.000Z"));
    const again = await s.issue("w", issue.key);
    expect(again?.issue.status).toBe("open");
    expect(again?.issue.reopened).toBe(true);
    expect(again?.issue.sessions).toBe(3);
  });

  it("resolves an issue on its own once sessions in its project stop having it, and reopens it if it comes back", async () => {
    const s = await store();
    await s.saveTrace("w", later(trace(), "bad", new Date(Date.now() - 20 * 86400_000).toISOString()));
    const key = (await s.issues("w")).find((i) => i.kind === "tool_error")!.key;
    const status = async () => (await s.issue("w", key))!.issue;

    // Quiet sessions in another project say nothing about this one.
    for (let i = 0; i < QUIET_SESSIONS; i++) await s.saveTrace("w", clean(trace(), `elsewhere-${i}`, -19 + i, "/code/other"));
    expect((await status()).status).toBe("open");

    for (let i = 0; i < QUIET_SESSIONS - 1; i++) await s.saveTrace("w", clean(trace(), `quiet-${i}`, -15 + i));
    expect((await status()).status).toBe("open");
    await s.saveTrace("w", clean(trace(), "quiet-last", -10));
    const done = await status();
    expect(done).toMatchObject({ status: "resolved", resolvedBy: AUTO_RESOLVER });
    expect(done.note).toContain(`${QUIET_SESSIONS} sessions`);
    expect(done.resolvedAt?.slice(0, 10)).toBe(new Date(Date.now() - 10 * 86400_000).toISOString().slice(0, 10));

    // A session that had it after the last quiet one brings it back.
    await s.saveTrace("w", later(trace(), "back", new Date(Date.now() - 5 * 86400_000).toISOString()));
    expect(await status()).toMatchObject({ status: "open", reopened: true });
  });

  it("waits for a day of quiet, not a burst of quick follow-ups", async () => {
    const s = await store();
    const at = Date.now() - 20 * 86400_000;
    await s.saveTrace("w", later(trace(), "bad", new Date(at).toISOString()));
    const key = (await s.issues("w")).find((i) => i.kind === "tool_error")!.key;
    const minutes = (m: number) => (m * 60_000) / 86400_000 - 20;
    for (let i = 1; i <= QUIET_SESSIONS + 2; i++) await s.saveTrace("w", clean(trace(), `burst-${i}`, minutes(i * 3)));
    expect((await s.issue("w", key))!.issue.status).toBe("open");
    await s.saveTrace("w", clean(trace(), "next-day", -18));
    expect((await s.issue("w", key))!.issue.status).toBe("resolved");
  });

  it("names a routine by its whole name, slash included", async () => {
    const s = await store();
    const routine = "routines/Envoi vague BFC + LinkedIn 5/5";
    const bad = later(trace(), "bad", new Date(Date.now() - 20 * 86400_000).toISOString());
    await s.saveTrace("w", { ...bad, session: { ...bad.session, project: routine } });
    const key = (await s.issues("w")).find((i) => i.kind === "tool_error")!.key;
    for (let i = 0; i < QUIET_SESSIONS; i++) await s.saveTrace("w", clean(trace(), `quiet-${i}`, -15 + i, routine));
    expect((await s.issue("w", key))!.issue.note).toContain("in Envoi vague BFC + LinkedIn 5/5 since");
  });

  it("reopens an issue it resolved when a session saved late had it in the quiet stretch", async () => {
    const s = await store();
    await s.saveTrace("w", later(trace(), "bad", new Date(Date.now() - 20 * 86400_000).toISOString()));
    const key = (await s.issues("w")).find((i) => i.kind === "tool_error")!.key;
    for (let i = 0; i < QUIET_SESSIONS; i++) await s.saveTrace("w", clean(trace(), `quiet-${i}`, -15 + i));
    expect((await s.issue("w", key))!.issue.status).toBe("resolved");
    await s.saveTrace("w", later(trace(), "late", new Date(Date.now() - 12.5 * 86400_000).toISOString()));
    // Open again, but not "back after it was resolved": it never went away.
    expect((await s.issue("w", key))!.issue).toMatchObject({ status: "open", reopened: false });
  });

  it("leaves an issue someone reopened by hand open until new quiet sessions come in", async () => {
    const s = await store();
    await s.saveTrace("w", later(trace(), "bad", new Date(Date.now() - 20 * 86400_000).toISOString()));
    const key = (await s.issues("w")).find((i) => i.kind === "tool_error")!.key;
    for (let i = 0; i < QUIET_SESSIONS; i++) await s.saveTrace("w", clean(trace(), `quiet-${i}`, -15 + i));
    await s.setIssueStatus("w", key, "open", "Ada", "");
    await s.saveTrace("w", clean(trace(), "one-more", -1));
    expect((await s.issue("w", key))!.issue.status).toBe("open");
    for (let i = 0; i < QUIET_SESSIONS; i++) await s.saveTrace("w", clean(trace(), `after-${i}`, 1 + i));
    expect((await s.issue("w", key))!.issue).toMatchObject({ status: "resolved", resolvedBy: AUTO_RESOLVER });
  });

  it("sums up sessions, tools and memory", async () => {
    const s = await store();
    await s.saveTrace("w", trace());
    const since = "2000-01-01T00:00:00.000Z";
    const o = await s.overview("w", since);
    expect(o.sessions).toBe(1);
    expect(o.interrupted).toBe(1);
    expect(o.openIssues).toBe(4);
    expect(o.toolErrors).toBe(2);
    const bash = (await s.tools("w", since)).find((t) => t.name === "Bash")!;
    expect(bash.calls).toBe(6); // 5 in the main session, 1 in the subagent
    expect(bash.errors).toBe(2);
    const mem = await s.memory("w", since);
    const claude = mem.find((m) => m.ref === "/work/shop/CLAUDE.md" && m.source === "instructions")!;
    expect(claude.sessions).toBe(1);
    expect(await s.projects("w")).toEqual(["/work/shop"]);
  });

  it("numbers issues per workspace and numbers old databases' issues when it migrates", async () => {
    const s = await store();
    await s.saveTrace("w", trace());
    await s.saveTrace("other", trace());
    expect((await s.issues("w")).map((i) => i.num).sort()).toEqual([1, 2, 3, 4]);
    expect((await s.issues("other")).map((i) => i.num).sort()).toEqual([1, 2, 3, 4]);
    // An older database had no numbers.
    await s.db.run("UPDATE issues SET num = NULL WHERE workspace = ?", ["w"]);
    await s.migrate();
    expect((await s.issues("w")).map((i) => i.num).sort()).toEqual([1, 2, 3, 4]);
  });

  it("tracks what still needs pushing", async () => {
    const s = await store();
    await s.saveTrace("w", trace());
    expect(await s.unpushed("w")).toEqual(["sess-1"]);
    await s.markPushed("w", "sess-1");
    expect(await s.unpushed("w")).toEqual([]);
  });

  it("creates tokens and stores only their hash", async () => {
    const s = await store();
    const token = await s.createToken("w", "Ada", "admin");
    expect(token).toMatch(/^tm_/);
    expect(await s.tokenOwner(token)).toEqual({ workspace: "w", person: "Ada", role: "admin" });
    expect(await s.tokenOwner("tm_nope")).toBeNull();
    const rows = await s.db.all<{ hash: string }>("SELECT hash FROM tokens");
    expect(rows[0].hash).not.toContain(token);
  });
});

describe.each(dbs)("Issue dates on %s", (_, open) => {
  it("keeps the earliest session as first seen, whatever order sessions are saved in", async () => {
    const s = new Store(await open());
    await s.migrate();
    await s.saveTrace("w", later(trace(), "late", "2026-09-01T00:00:00.000Z"));
    await s.saveTrace("w", later(trace(), "early", "2026-07-01T00:00:00.000Z"));
    const [i] = await s.issues("w");
    expect(i.firstSeen).toBe("2026-07-01T00:00:00.000Z");
    expect(i.lastSeen).toBe("2026-09-01T00:00:00.000Z");
    // And a database saved by an older version is repaired when it opens.
    await s.db.run("UPDATE issues SET first_seen = ?", ["2026-10-01T00:00:00.000Z"]);
    await s.migrate();
    expect((await s.issues("w"))[0].firstSeen).toBe("2026-07-01T00:00:00.000Z");
  });
});
