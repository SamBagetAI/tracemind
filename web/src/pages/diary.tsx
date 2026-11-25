/**
 * The home page, read like a journal: one sentence of numbers for the window, then the sessions
 * day by day, each told in one sentence with what went wrong highlighted. Every highlight opens
 * its issue, every title its session.
 */
import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { Failed, Loading } from "@/components/shell";
import { useApi, type Overview, type Session, type Suggestion } from "@/lib/api";
import { activeLabel, byDay, dayLabel, dollars, sentence, tokens } from "@/lib/diary";
import { projectName } from "@/lib/format";
import { useWindow } from "@/lib/window";

const PAGE = 30;

function Stats({ o, days }: { o: Overview; days: number }) {
  if (o.sessions === 0) return <p className="diary-stats">No sessions in the last {days} days.</p>;
  const clean = o.sessions - o.withIssues;
  const p = o.previous;
  const n = (v: string | number) => <b className="font-semibold">{v}</b>;
  return (
    <p className="diary-stats">
      <Link to="/sessions" className="hover:underline">{n(o.sessions)} {o.sessions === 1 ? "session" : "sessions"}</Link>, {n(activeLabel(o.activeMs))} of active time with Claude.{" "}
      <Link to="/sessions?show=clean" className="hover:underline">{n(clean)} ran clean</Link>
      {p.sessions > 0 && <span className="text-muted-foreground"> ({p.sessions - p.withIssues} of {p.sessions} the {days} days before)</span>}.{" "}
      <Link to="/tools" className="hover:underline">{n(o.toolErrors.toLocaleString("en-US"))} failed calls</Link>, {n(tokens(o.outputTokens))} tokens out
      {o.costUsd > 0 && <span className="text-muted-foreground">, about {dollars(o.costUsd)} at API prices</span>}.
    </p>
  );
}

function Entry({ s }: { s: Session }) {
  const parts = sentence(s);
  const clean = parts.length === 1 && "text" in parts[0] && parts[0].text === "Ran clean.";
  return (
    <div className="py-1.5">
      <Link to={`/sessions/${s.id}`} className="text-[16px] font-semibold text-foreground underline-offset-4 hover:underline">{s.title}</Link>
      <div className="text-[13px] text-faint">
        {projectName(s.project)} · {activeLabel(s.activeMs)} active
      </div>
      <p className={clean ? "mt-0.5 text-[14px] text-ok" : "mt-0.5 text-[14px] text-foreground/80"}>
        {parts.map((p, i) =>
          "text" in p ? (
            <span key={i}>{p.text}</span>
          ) : (
            <Link key={i} to={`/issues/${encodeURIComponent(p.key)}`} className="diary-mark" title={p.step ? `First at step ${p.step}` : undefined}>
              {p.mark}
            </Link>
          ),
        )}
      </p>
    </div>
  );
}

export function DiaryPage() {
  const { days } = useWindow();
  const o = useApi<Overview>(`/overview?days=${days}`);
  const list = useApi<Session[]>(`/sessions?days=${days}&limit=2000&issues=1`);
  const fixes = useApi<Suggestion[]>(`/suggestions?days=${days}`);
  const [shown, setShown] = useState(PAGE);
  // A fix is a change Tracemind can make; an investigation is a prompt for Claude, and is said so.
  const openList = (fixes.data ?? []).filter((s) => s.status === "open");
  const open = openList.filter((s) => s.action.type === "rule" || s.action.type === "routine").length;
  const investigate = openList.length - open;

  const error = o.error ?? list.error;
  const groups = byDay((list.data ?? []).slice(0, shown));
  const from = new Date(Date.now() - days * 86400000);
  const range = `${from.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – today`;

  return (
    <main className="mx-auto w-full max-w-[1120px] px-4 pt-8 pb-20 sm:px-6">
      <div className="max-w-[760px]">
      <div className="text-[13px] text-faint">Last {days} days · {range}</div>
      {error && <Failed error={error} />}
      {!error && (!o.data || !list.data) && <div className="pt-6"><Loading rows={8} /></div>}
      {o.data && list.data && (
        <>
          <Stats o={o.data} days={days} />
          {open + investigate > 0 && (
            <Link to="/fixes" className="mb-8 inline-flex items-center gap-1.5 text-[14px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              {[open && (open === 1 ? "1 fix to review" : `${open} fixes to review`), investigate && (investigate === 1 ? "1 issue to investigate" : `${investigate} issues to investigate`)].filter(Boolean).join(" · ")}
              <ArrowRight className="size-3.5" />
            </Link>
          )}
          <div>
            {groups.map((g) => (
              <section key={g.day} className="grid grid-cols-1 gap-1 border-t border-border py-4 sm:grid-cols-[100px_1fr] sm:gap-5">
                <h2 className="pt-1.5 text-[13px] font-normal text-faint">{dayLabel(g.day)}</h2>
                <div>{g.sessions.map((s) => <Entry key={s.id} s={s} />)}</div>
              </section>
            ))}
          </div>
          {list.data.length > shown && (
            <button type="button" onClick={() => setShown(shown + PAGE)} className="mt-2 text-[14px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              Show older sessions ({list.data.length - shown} more)
            </button>
          )}
        </>
      )}
      </div>
    </main>
  );
}
