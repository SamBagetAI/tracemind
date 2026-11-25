/**
 * The overview: what happened in the window (each count opens its list), the fixes worth
 * reviewing next, sessions per day, the latest sessions, and the fixes already applied with
 * whether they worked.
 */
import { ArrowRight } from "lucide-react";
import { Link } from "react-router";
import { AppliedLine, FixLine } from "@/components/change";
import { SectionTitle } from "@/components/marks";
import { Failed, Loading, Page } from "@/components/shell";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useApi, type Overview, type Session, type Suggestion } from "@/lib/api";
import { SessionsTable } from "@/components/sessions-table";
import { dayLabel, plural } from "@/lib/format";
import { useWindow } from "@/lib/window";

function Count({ value }: { value: number }) {
  return <span className="font-medium text-foreground num">{value.toLocaleString("en-US")}</span>;
}

/** Sessions per day with a count axis and a date every week; each day's numbers on hover. */
function Daily({ strip, days }: { strip: Overview["strip"]; days: number }) {
  const list: { day: string; clean: number; issues: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const s = strip.filter((x) => x.startedAt.slice(0, 10) === day);
    list.push({ day, clean: s.filter((x) => x.issues === 0).length, issues: s.filter((x) => x.issues > 0).length });
  }
  const max = Math.max(1, ...list.map((d) => d.clean + d.issues));
  const ticks = [max, Math.round(max / 2)].filter((v, i, a) => v > 0 && a.indexOf(v) === i);
  const step = days <= 7 ? 1 : 7;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between text-[12px] text-faint">
        <span>Sessions per day</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1"><i className="inline-block size-2 bg-muted-foreground/45" /> clean</span>
          <span className="flex items-center gap-1"><i className="inline-block size-2 bg-fail" /> hit an issue</span>
        </span>
      </div>
      <div className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-2">
        <div className="relative h-20 text-right text-[11px] text-faint num">
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 -translate-y-1/2" style={{ top: `${100 - (t / max) * 100}%` }}>{t}</span>
          ))}
        </div>
        <div className="relative h-20">
          {ticks.map((t) => (
            <span key={t} className="absolute inset-x-0 border-t border-dashed border-border" style={{ top: `${100 - (t / max) * 100}%` }} />
          ))}
          <div className="relative flex h-full items-end gap-px sm:gap-[3px]" role="img" aria-label={`Sessions per day over ${days} days`}>
            {list.map((d) => (
              <Tooltip key={d.day}>
                <TooltipTrigger asChild>
                  <span className="flex h-full min-w-0 flex-1 flex-col justify-end rounded-[2px] transition-colors hover:bg-accent">
                    {d.issues > 0 && <span className="block rounded-t-[2px] bg-fail" style={{ height: `${(d.issues / max) * 100}%` }} />}
                    {d.clean > 0 && <span className={`block bg-muted-foreground/45 ${d.issues ? "" : "rounded-t-[2px]"}`} style={{ height: `${(d.clean / max) * 100}%` }} />}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="text-[12px]">
                  {dayLabel(d.day)} · {plural(d.clean + d.issues, "session")}
                  {d.issues > 0 && `, ${d.issues} hit an issue`}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        </div>
        <span />
        <div className="relative mt-1 h-4 text-[11px] text-faint num">
          {list.map((d, i) =>
            (list.length - 1 - i) % step === 0 ? (
              <span key={d.day} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${((i + 0.5) / list.length) * 100}%` }}>
                {i === list.length - 1 ? "today" : dayLabel(d.day)}
              </span>
            ) : null,
          )}
        </div>
      </div>
    </div>
  );
}

/** The fixes that would help the most sessions, one line each; each opens its full card on Fixes. */
function NextFixes({ suggestions, days }: { suggestions: Suggestion[]; days: number }) {
  const open = suggestions.filter((s) => s.status === "open").sort((a, b) => b.sessions - a.sessions);
  const shown = open.slice(0, 3);
  return (
    <section className="mb-10">
      <SectionTitle aside={open.length > shown.length && <Link to="/fixes" className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground">All {open.length} fixes <ArrowRight className="size-3" /></Link>}>
        Fixes to review
      </SectionTitle>
      {open.length === 0 ? (
        <p className="border-y py-4 text-muted-foreground">None for the last {days} days.</p>
      ) : (
        <ol className="divide-y border-y">
          {shown.map((s) => <li key={s.id} className="px-1 py-3 sm:px-2"><FixLine s={s} issues /></li>)}
        </ol>
      )}
    </section>
  );
}

export function OverviewPage() {
  const { days } = useWindow();
  const o = useApi<Overview>(`/overview?days=${days}`);
  const suggestions = useApi<Suggestion[]>(`/suggestions?days=${days}`);
  const latest = useApi<Session[]>(`/sessions?days=${days}&limit=5&marks=1`);
  const title = `Last ${days} days`;

  if (o.error) return <Page title={title}><Failed error={o.error} /></Page>;
  if (!o.data) return <Page title={title}><Loading rows={10} /></Page>;
  const d = o.data;
  const clean = d.sessions - d.withIssues;
  const applied = (suggestions.data ?? []).filter((s) => s.status === "applied");

  const lead =
    d.sessions === 0 ? (
      `No sessions in the last ${days} days.`
    ) : (
      <>
        <Link to="/sessions" className="underline-offset-4 hover:underline"><Count value={d.sessions} /> sessions</Link>:{" "}
        <Link to="/sessions?show=clean" className="underline-offset-4 hover:underline"><Count value={clean} /> ran clean</Link>,{" "}
        <Link to="/sessions?show=issues" className="underline-offset-4 hover:underline"><Count value={d.withIssues} /> hit an issue</Link>.{" "}
        <Link to="/tools" className="underline-offset-4 hover:underline"><Count value={d.toolCalls} /> tool calls, <Count value={d.toolErrors} /> failed</Link>.
      </>
    );

  return (
    <Page title={title} lead={lead}>
      <div>
        {suggestions.data && <NextFixes suggestions={suggestions.data} days={days} />}
        <section>
          <Daily strip={d.strip} days={days} />
        </section>
      </div>

      <div>
        {latest.data && latest.data.length > 0 && (
          <section className="mt-10">
            <SectionTitle aside={<Link to="/sessions" className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground">All {d.sessions} sessions <ArrowRight className="size-3" /></Link>}>Latest sessions</SectionTitle>
            <SessionsTable sessions={latest.data} />
          </section>
        )}
        <section className="mt-10">
          <SectionTitle>Fixes you applied</SectionTitle>
          {applied.length === 0 ? (
            <p className="border-y py-4 text-muted-foreground">
              None yet. An applied fix shows here with how often its issue happened before and since.
            </p>
          ) : (
            <ol className="divide-y border-y">
              {applied.map((s) => (
                <li key={s.id} className="px-1 py-3 sm:px-2">
                  <p className="font-medium text-foreground">{s.title}</p>
                  <AppliedLine s={s} />
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </Page>
  );
}
