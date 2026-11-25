/**
 * Suggestions as a review queue, grouped by where each change goes. Every row writes out its
 * change (the rule as it will read, or the hook and what it will say), links to the cause it is
 * meant to stop, and has one main button: Apply or Copy prompt.
 */
import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { toast } from "sonner";
import { AppliedLine, ChangeActions, ChangeBody } from "@/components/change";
import { SectionTitle } from "@/components/marks";
import { Empty, Failed, Loading, Page } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, useApi, type Suggestion, type Viewer } from "@/lib/api";
import { plural, projectName, shortPath } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useWindow } from "@/lib/window";

/** Sessions in the window, the cause it is about, and where it was seen. */
function Evidence({ s, days }: { s: Suggestion; days: number }) {
  return (
    <>
    {/* A change made for one cause says why through that cause's link; the others say it in a sentence. */}
    {!s.issue && s.why && <p className="mt-1 max-w-[80ch] text-[13px] text-muted-foreground">{s.why}</p>}
    <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px] text-faint">
      <span className="text-muted-foreground num">{plural(s.sessions, "session")} · {days}d</span>
      {s.issue && (
        <>
          <span>·</span>
          <Link to={`/issues/${encodeURIComponent(s.issue.key)}`} className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            {s.issue.what}
          </Link>
        </>
      )}
      {s.examples.length > 0 && (
        <>
          <span>· seen in</span>
          {s.examples.map((e, i) => (
            <Link key={e.id} to={`/sessions/${e.id}${e.seq ? `#s-${e.seq}` : ""}`} className="max-w-[26ch] truncate text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
              {e.title}
              {i < s.examples.length - 1 ? "," : ""}
            </Link>
          ))}
        </>
      )}
    </p>
    </>
  );
}

function Row({ s, canApply, onChange, highlight, days }: { s: Suggestion; canApply: boolean; onChange: () => void; highlight: boolean; days: number }) {
  return (
    <li id={s.id} className={cn("scroll-mt-20 px-1 py-4 sm:px-2", highlight && "bg-accent/50")}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-0 flex-1">
          <h3 className="font-medium text-foreground">{s.title}</h3>
          <Evidence s={s} days={days} />
          <ChangeBody s={s} />
        </div>
        <ChangeActions s={s} canApply={canApply} onChange={onChange} />
      </div>
    </li>
  );
}

/** Investigations stay one line until opened: the prompt is long and only needed to copy it. */
function InvestigateRow({ s, canApply, onChange, highlight, days }: { s: Suggestion; canApply: boolean; onChange: () => void; highlight: boolean; days: number }) {
  return (
    <Collapsible asChild defaultOpen={highlight}>
      <li id={s.id} className={cn("scroll-mt-20", highlight && "bg-accent/50")}>
        <CollapsibleTrigger className="group flex w-full items-baseline gap-2 px-1 py-2.5 text-left transition-colors hover:bg-accent sm:px-2">
          <ChevronRight className="size-3.5 shrink-0 self-center text-faint transition-transform group-data-[state=open]:rotate-90" />
          <span className="min-w-0 flex-1 truncate text-foreground">{s.title.replace(/^Investigate: /, "")}</span>
          <span className="shrink-0 text-[12px] text-muted-foreground num">{plural(s.sessions, "session")} · {days}d</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="pr-1 pb-4 pl-6 sm:pr-2 sm:pl-7">
            <Evidence s={s} days={days} />
            <ChangeBody s={s} />
            <ChangeActions s={s} canApply={canApply} onChange={onChange} className="mt-3" />
          </div>
        </CollapsibleContent>
      </li>
    </Collapsible>
  );
}

function Group({ title, note, children }: { title: ReactNode; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-8 first:mt-2">
      <SectionTitle aside={note && <span className="text-[12px] text-faint">{note}</span>}>{title}</SectionTitle>
      <ol className="divide-y border-y">{children}</ol>
    </section>
  );
}

export function SuggestionsPage() {
  const { days } = useWindow();
  const list = useApi<Suggestion[]>(`/suggestions?days=${days}`);
  const me = useApi<Viewer>("/me");
  const { hash } = useLocation();
  const target = hash.slice(1);
  const canApply = me.data?.mode === "local";
  const [tab, setTab] = useState("review");

  // A link to one fix (/fixes#id) opens the tab it is in, then scrolls to it.
  useEffect(() => {
    if (!list.data || !target) return;
    const s = list.data.find((x) => x.id === target);
    if (s) setTab(s.status === "open" ? "review" : s.status);
    requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView({ block: "start" })));
  }, [list.data, target]);

  const all = list.data ?? [];
  const open = all.filter((s) => s.status === "open");
  const applied = all.filter((s) => s.status === "applied");
  const dismissed = all.filter((s) => s.status === "dismissed");

  const groups = useMemo(() => {
    const rules = new Map<string, Suggestion[]>();
    for (const s of open) if (s.action.type === "rule") rules.set(s.action.file, [...(rules.get(s.action.file) ?? []), s]);
    const isGlobal = (l: Suggestion[]) => l[0].action.type === "rule" && l[0].action.scope === "global";
    return {
      rules: [...rules.entries()].sort(([, a], [, b]) => Number(isGlobal(b)) - Number(isGlobal(a))),
      routine: open.filter((s) => s.kind === "routine"),
      connect: open.filter((s) => s.kind === "connect"),
      trim: open.filter((s) => s.kind === "trim"),
      investigate: open.filter((s) => s.kind === "investigate"),
      tips: open.filter((s) => s.kind === "tip"),
    };
  }, [open]);

  const rowProps = { canApply, onChange: list.reload, days };

  return (
    <Page title="Fixes" lead={<span className="text-[13px]">Fixes to how Claude is set up, for the issues that kept coming back in the last {days} days</span>}>
      {list.error && <Failed error={list.error} />}
      {!list.data && !list.error && <Loading rows={10} />}
      {list.data && (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="review">To review <span className="ml-1 text-faint num">{open.length}</span></TabsTrigger>
            <TabsTrigger value="applied">Applied <span className="ml-1 text-faint num">{applied.length}</span></TabsTrigger>
            <TabsTrigger value="dismissed">Dismissed <span className="ml-1 text-faint num">{dismissed.length}</span></TabsTrigger>
          </TabsList>

          <TabsContent value="review">
            <div>
              {open.length === 0 && <Empty>Nothing to review in the last {days} days. A longer window may show more.</Empty>}
              {groups.rules.map(([file, items]) => (
                <Group
                  key={file}
                  title={items[0].action.type === "rule" && items[0].action.scope === "global" ? "Your global CLAUDE.md" : `${projectName(file.split("/").slice(0, -1).join("/"))} · ${file.split("/").pop()}`}
                  note={plural(items.length, "rule")}
                >
                  {items.map((s) => <Row key={s.id} s={s} {...rowProps} highlight={s.id === target} />)}
                </Group>
              ))}
              {groups.routine.length > 0 && <Group title="Claude Code settings">{groups.routine.map((s) => <Row key={s.id} s={s} {...rowProps} highlight={s.id === target} />)}</Group>}
              {groups.connect.length > 0 && <Group title="Connectors">{groups.connect.map((s) => <Row key={s.id} s={s} {...rowProps} highlight={s.id === target} />)}</Group>}
              {groups.trim.length > 0 && <Group title="Instruction file size">{groups.trim.map((s) => <Row key={s.id} s={s} {...rowProps} highlight={s.id === target} />)}</Group>}
              {groups.investigate.length > 0 && (
                <Group title="Needs investigation" note="no rule covers these yet">
                  {groups.investigate.map((s) => <InvestigateRow key={s.id} s={s} {...rowProps} highlight={s.id === target} />)}
                </Group>
              )}
              {groups.tips.length > 0 && <Group title="Habits">{groups.tips.map((s) => <Row key={s.id} s={s} {...rowProps} highlight={s.id === target} />)}</Group>}
            </div>
          </TabsContent>

          <TabsContent value="applied">
            {applied.length === 0 ? (
              <Empty>Nothing applied yet. Applied changes show here with how often the problem happened before and since.</Empty>
            ) : (
              <ol className="mt-2 divide-y border-y">
                {applied.map((s) => (
                  <li key={s.id} className="flex flex-col gap-2 px-1 py-3.5 sm:flex-row sm:items-start sm:justify-between sm:px-2">
                    <div className="min-w-0">
                      <p className="font-medium text-foreground">{s.title}</p>
                      <AppliedLine s={s} />
                    </div>
                    <ChangeActions s={s} canApply={canApply} onChange={list.reload} />
                  </li>
                ))}
              </ol>
            )}
          </TabsContent>

          <TabsContent value="dismissed">
            {dismissed.length === 0 ? (
              <Empty>Nothing dismissed.</Empty>
            ) : (
              <ul className="mt-2 divide-y border-y">
                {dismissed.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 px-1 py-2 sm:px-2">
                    <span className="min-w-0 truncate text-muted-foreground">{s.title}</span>
                    <Button variant="ghost" size="sm" className="h-7 shrink-0" onClick={() => api(`/suggestions/${s.id}/restore`, { method: "POST", body: "{}" }).then(list.reload).catch((e) => toast.error((e as Error).message))}>
                      Bring back
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>
        </Tabs>
      )}
    </Page>
  );
}
