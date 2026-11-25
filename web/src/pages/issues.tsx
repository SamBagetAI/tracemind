/**
 * Issues, one row per cause. Every row opens its cause page, and every number on a row is the
 * same number that page shows: distinct sessions in the window, from one query.
 */
import { ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Link, useSearchParams } from "react-router";
import { FixMark, Trend } from "@/components/marks";
import { Empty, Failed, Loading, Page } from "@/components/shell";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useApi, type IssueGroup } from "@/lib/api";
import { LEVEL_CLASS, dayLabel, plural, sessionsLevel, when } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useWindow } from "@/lib/window";

/** Issue | trend | sessions | fix | first ever | last seen. Phones keep issue and sessions. */
const ISSUE_COLS = "grid items-center gap-x-4 grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_112px_88px_84px] lg:grid-cols-[minmax(0,1fr)_112px_88px_84px_76px_76px]";

const causeHref = (g: IssueGroup) => `/issues/${encodeURIComponent(g.issues[0].key)}`;

function IssueHeader({ days }: { days: number }) {
  return (
    <div className={cn(ISSUE_COLS, "border-b px-1 pb-1.5 text-[12px] text-faint sm:px-2")}>
      <span>Issue</span>
      <span className="hidden sm:block">Sessions · prev {days}d</span>
      <span className="text-right whitespace-nowrap">Sessions · {days}d</span>
      <span className="hidden sm:block">Fix</span>
      <span className="hidden text-right lg:block">First ever</span>
      <span className="hidden text-right lg:block">Last seen</span>
    </div>
  );
}

function IssueRow({ g, days }: { g: IssueGroup; days: number }) {
  const level = LEVEL_CLASS[sessionsLevel(g.sessions)];
  return (
    <li>
      <Link to={causeHref(g)} className={cn(ISSUE_COLS, "px-1 py-2.5 transition-colors hover:bg-accent sm:px-2")}>
        <span className="min-w-0">
          <span className="block truncate text-foreground">{g.what}</span>
          <span className="block truncate text-[12px] text-faint">
            {g.kindLabel}
            {g.tools && <> · <span className="font-mono text-[11px]">{g.tools}</span></>}
            {g.reopened && <span className="text-fail"> · back after resolved</span>}
            {!g.reopened && g.status === "resolved" && " · resolved"}
          </span>
        </span>
        <span className="hidden sm:block"><Trend now={g.sessions} before={g.previous ?? 0} /></span>
        <span className={cn("text-right text-[13px] num", level)}>{g.sessions}</span>
        <span className="hidden sm:block"><FixMark fix={g.fix} at={g.fixAt} lastSeen={g.lastSeen} /></span>
        <span className="hidden text-right text-[12px] text-muted-foreground num lg:block">{dayLabel(g.firstSeen.slice(0, 10))}</span>
        <span className="hidden text-right text-[12px] text-muted-foreground num lg:block">{when(g.lastSeen)}</span>
      </Link>
    </li>
  );
}

export function IssuesPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "open";
  const { days } = useWindow();
  const oneOffs = params.get("all") === "1";
  const list = useApi<IssueGroup[]>(`/issue-groups?days=${days}${status === "all" ? "" : `&status=${status}`}`);

  const groups = list.data ?? [];
  // An issue gets a row once it has a name a person would use. Errors not named yet sit together at
  // the bottom, as the text the tool printed.
  const named = groups.filter((g) => g.plain);
  const unnamed = groups.filter((g) => !g.plain);
  const shown = named.filter((g) => oneOffs || g.sessions > 1);
  const hidden = named.filter((g) => g.sessions <= 1).length;
  const ready = shown.filter((g) => g.fix === "ready").length;

  const set = (k: string, v: string | null) => {
    const p = new URLSearchParams(params);
    if (v === null) p.delete(k);
    else p.set(k, v);
    setParams(p, { replace: true });
  };

  return (
    <Page
      title="Issues"
      lead={
        list.data && (
          <span className="text-[13px] num">
            {shown.length === 0
              ? `Nothing went wrong more than once in the last ${days} days.`
              : `${shown[0].what} is the most common: ${plural(shown[0].sessions, "session")} in the last ${days} days. ${ready} of ${plural(shown.length, "issue")} ${ready === 1 ? "has" : "have"} a fix ready.`}
          </span>
        )
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <ToggleGroup type="single" value={status} onValueChange={(v) => v && set("status", v === "open" ? null : v)} variant="outline" size="sm" aria-label="Status">
          <ToggleGroupItem value="open" className="h-8 px-3">Open</ToggleGroupItem>
          <ToggleGroupItem value="resolved" className="h-8 px-3">Resolved</ToggleGroupItem>
          <ToggleGroupItem value="all" className="h-8 px-3">All</ToggleGroupItem>
        </ToggleGroup>
        <ToggleGroup type="single" value={oneOffs ? "all" : "recurring"} onValueChange={(v) => v && set("all", v === "all" ? "1" : null)} variant="outline" size="sm" aria-label="Which issues">
          <ToggleGroupItem value="recurring" className="h-8 px-3">Recurring</ToggleGroupItem>
          <ToggleGroupItem value="all" className="h-8 px-3">
            With one-offs{hidden > 0 && <span className="ml-1 text-[12px] text-faint num">+{hidden}</span>}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <IssueHeader days={days} />
      {list.error && <Failed error={list.error} />}
      {!list.data && !list.error && <div className="pt-2"><Loading rows={12} /></div>}
      {list.data && (
        <div>
          {shown.length === 0 ? (
            <Empty>{status === "resolved" ? "Nothing marked resolved in this window." : `No ${oneOffs ? "" : "recurring "}issues in the last ${days} days.`}</Empty>
          ) : (
            <ol className="divide-y border-b">{shown.map((g) => <IssueRow key={g.id} g={g} days={days} />)}</ol>
          )}
          {unnamed.length > 0 && (
            <Collapsible className="mt-4">
              <CollapsibleTrigger className="group flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
                <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
                {plural(unnamed.length, "error")} without a name yet, as the tools printed them
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="mt-2 divide-y border-y">
                  {unnamed.map((g) => (
                    <li key={g.id}>
                      <Link to={causeHref(g)} className="flex items-baseline justify-between gap-4 px-1 py-2 transition-colors hover:bg-accent sm:px-2">
                        <span className="min-w-0">
                          <span className="block truncate font-mono text-[12px] text-foreground/80">{g.raw || g.what}</span>
                          <span className="block truncate font-mono text-[11px] text-faint">{g.tools}</span>
                        </span>
                        <span className="shrink-0 text-[12px] text-muted-foreground num">{plural(g.sessions, "session")}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      )}
    </Page>
  );
}
