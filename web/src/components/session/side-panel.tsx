import { Link } from "react-router";
import { FixMark, SectionTitle } from "@/components/marks";
import type { Trace } from "@/lib/api";
import { num, plural, sessionsLevel, LEVEL_CLASS, memoryLabel, splitPath } from "@/lib/format";
import { findingsByCause, startFiles } from "@/lib/trace";
import { cn } from "@/lib/utils";

/** On wide screens: what the session started with, what it read or wrote, and the issues it hit with their fixes. */
export function SidePanel({ t, onJump }: { t: Trace; onJump: (seq: number) => void }) {
  const atStart = startFiles(t.memory);
  const used = [...new Map(t.memory.filter((m) => m.source !== "instructions").map((m) => [`${m.op}:${m.ref}`, m])).values()];
  const issues = findingsByCause(t.findings, t.issues);
  return (
    <aside className="hidden xl:block">
      <div className="sticky top-16 grid gap-6 pt-5 text-[13px]">
        <section>
          <SectionTitle aside={<span className="text-[12px] text-faint num">{issues.length}</span>}>Issues hit</SectionTitle>
          {issues.length === 0 ? (
            <p className="text-muted-foreground">None.</p>
          ) : (
            <ul className="grid gap-2.5">
              {issues.map((f) => {
                const ref = t.issues[f.key];
                return (
                  <li key={f.key} className="min-w-0">
                    <Link to={`/issues/${encodeURIComponent(f.key)}`} className="line-clamp-2 text-foreground underline-offset-2 hover:underline">{ref?.what ?? f.title}</Link>
                    <span className="mt-0.5 flex items-center gap-2 text-[12px] text-faint num">
                      <button type="button" onClick={() => onJump(f.seq)} className="hover:text-foreground hover:underline">step {num(f.seq)}</button>
                      {ref && <span className={ref.sessions > 1 ? LEVEL_CLASS[sessionsLevel(ref.sessions)] : ""}>{plural(ref.sessions, "session")}</span>}
                      <FixMark fix={ref?.fix} at={ref?.fixAt} lastSeen={t.session.endedAt} />
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <section>
          <SectionTitle aside={<span className="text-[12px] text-faint num">{atStart.length}</span>}>Loaded at the start</SectionTitle>
          {atStart.length === 0 ? <p className="text-muted-foreground">No instruction files.</p> : (
            <ul className="grid gap-1">
              {atStart.map((m) => {
                const { name, folder } = splitPath(m.ref);
                return <li key={m.ref} className="min-w-0 truncate font-mono text-[12px]" title={m.ref}>{name} <span className="text-[11px] text-faint">{folder}</span></li>;
              })}
            </ul>
          )}
        </section>
        <section>
          <SectionTitle aside={<span className="text-[12px] text-faint num">{used.length}</span>}>Skills and memory used</SectionTitle>
          {used.length === 0 ? <p className="text-muted-foreground">None after the start.</p> : (
            <ul className="grid gap-1">
              {used.map((m) => (
                <li key={`${m.op}:${m.ref}`} className="flex min-w-0 items-baseline gap-1.5 text-[12px]">
                  <span className={cn("shrink-0", m.op === "write" ? "text-ok" : "text-faint")}>{m.op === "write" ? "wrote" : "read"}</span>
                  <button type="button" onClick={() => onJump(m.seq)} className="min-w-0 truncate text-left font-mono hover:underline" title={m.ref}>
                    {memoryLabel(m).name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </aside>
  );
}
