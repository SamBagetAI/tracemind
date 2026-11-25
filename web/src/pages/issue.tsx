/**
 * One cause, and the loop on one screen: what went wrong and how often (the same count as the
 * Issues list, with a history that adds up to it), the change that would stop it with Apply, and
 * once applied, whether it worked. Then the error, what those sessions had loaded, the variants
 * and the sessions.
 */
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { toast } from "sonner";
import { FixLine } from "@/components/change";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { errorDetail } from "@/lib/trace";
import { HeatStrip, SectionTitle } from "@/components/marks";
import { Empty, Failed, Loading, Page } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, useApi, type CauseDetail } from "@/lib/api";
import { LEVEL_CLASS, dayLabel, describeIssue, fullDate, num, plural, projectName, sessionsLevel, toolLabel, when } from "@/lib/format";
import { useWindow } from "@/lib/window";

function Resolve({ k, status, variants, onDone }: { k: string; status: "open" | "resolved"; variants: number; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const send = async (next: "open" | "resolved") => {
    setBusy(true);
    try {
      await api(`/cause/${encodeURIComponent(k)}/status`, { method: "POST", body: JSON.stringify({ status: next, note }) });
      toast.success(next === "resolved" ? "Marked resolved. It comes back if it happens again." : "Reopened.");
      setOpen(false);
      setNote("");
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (status === "resolved") return <Button variant="outline" size="sm" disabled={busy} onClick={() => send("open")}>Reopen</Button>;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">Mark resolved</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mark resolved</DialogTitle>
          <DialogDescription>
            {variants > 1 ? `All ${variants} variants are marked. ` : ""}If it happens again in a later session, it opens again by itself.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); send("resolved"); }} className="grid gap-3">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was done (optional)" maxLength={500} aria-label="What was done" autoFocus />
          <DialogFooter>
            <Button type="submit" size="sm" disabled={busy}>Mark resolved</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The variants grouped by what they said, so the same error from cat and from node is one line
 * naming both tools. The five most common first; the rest behind one line.
 */
function Variants({ issues, messages }: { issues: CauseDetail["cause"]["issues"]; messages: Record<string, string> }) {
  const [all, setAll] = useState(false);
  const byMessage = new Map<string, { message: string; tools: Set<string>; variants: number; sessions: number }>();
  for (const i of issues) {
    // Grouped by the normalized signature, shown as one of them actually said it.
    const msg = describeIssue(i).raw;
    const e = byMessage.get(msg) ?? { message: messages[i.key] || msg, tools: new Set<string>(), variants: 0, sessions: 0 };
    e.tools.add(toolLabel(i.tool) || i.tool);
    e.variants++;
    e.sessions = Math.max(e.sessions, i.windowSessions);
    byMessage.set(msg, e);
  }
  // Ordered by how many commands said it; adding sessions across variants would count a session twice.
  const list = [...byMessage.values()].sort((a, b) => b.variants - a.variants || b.sessions - a.sessions);
  const shown = all ? list : list.slice(0, 5);
  return (
    <section className="mb-10">
      <SectionTitle aside={<span className="text-[12px] text-faint num">{plural(list.length, "message")} from {plural(issues.length, "command")} · all time</span>}>What it said</SectionTitle>
      <ul className="divide-y border-y">
        {shown.map((v) => (
          <li key={v.message} className="px-1 py-2 sm:px-2">
            <span className="block font-mono text-[12px] break-words text-foreground/90" title={v.message}>{errorDetail(v.message)}</span>
            <span className="mt-0.5 block truncate text-[12px] text-faint">
              <span className="font-mono text-[11px]">{[...v.tools].slice(0, 6).join(", ")}{v.tools.size > 6 ? ` +${v.tools.size - 6}` : ""}</span>
            </span>
          </li>
        ))}
      </ul>
      {list.length > 5 && (
        <button type="button" onClick={() => setAll(!all)} className="mt-2 text-[12px] text-muted-foreground hover:text-foreground">
          {all ? "Show the five most common" : `${list.length - 5} more`}
        </button>
      )}
    </section>
  );
}

export function IssuePage() {
  const { key = "" } = useParams();
  const { days } = useWindow();
  const r = useApi<CauseDetail>(`/cause/${encodeURIComponent(key)}?days=${days}`);

  if (r.error) return <Page title="Issue"><Failed error={r.error} /></Page>;
  if (!r.data) return <Page title="Issue"><Loading rows={8} /></Page>;
  const { cause: g, allTimeSessions, history, example, exampleStep, suggestion } = r.data;
  const { sessions } = r.data;
  const people = new Set(sessions.map((s) => s.person));
  const total = history.reduce((n, d) => n + d.sessions, 0);
  const status = g.issues.some((i) => i.status === "open") ? "open" : "resolved";
  const resolved = g.issues.find((i) => i.resolvedBy);

  return (
    <Page
      title={g.plain ? g.what : "Error without a name yet"}
      lead={
        <span className="block text-[12px] text-faint">
          <Link to="/issues" className="hover:text-foreground hover:underline">Issues</Link> · {g.kindLabel}
          <span className="mt-2 block text-[13px] text-muted-foreground num">
            <span className={LEVEL_CLASS[sessionsLevel(g.sessions)]}>{plural(g.sessions, "session")}</span> in the last {days} days, {num(allTimeSessions)} in all.
            First seen <span title={fullDate(g.firstSeen)}>{dayLabel(g.firstSeen.slice(0, 10))}</span>, last seen <span title={fullDate(g.lastSeen)}>{when(g.lastSeen)}</span>.
          </span>
          {status === "resolved" && resolved && (
            <span className="mt-2 block text-[13px] text-muted-foreground">
              Resolved by {resolved.resolvedBy} {when(resolved.resolvedAt)}{resolved.note ? `: “${resolved.note}”` : ""}
            </span>
          )}
          {g.reopened && <span className="mt-2 block text-[13px] text-fail">Back after it was resolved</span>}
        </span>
      }
      actions={<Resolve k={key} status={status} variants={g.issues.length} onDone={r.reload} />}
    >
      <div>
        <section className="mb-10">
          <SectionTitle>{!suggestion ? "Fix" : suggestion.status === "applied" ? "Fix applied" : suggestion.action.type === "rule" || suggestion.action.type === "routine" ? "Fix ready" : "To investigate"}</SectionTitle>
          {suggestion ? (
            <>
              <FixLine s={suggestion} issues />
              {suggestion.action.type === "rule" && suggestion.status !== "applied" && (
                <p className="mt-2 border-l-2 border-ok/60 py-0.5 pl-3 text-[13px] text-foreground/90">{suggestion.action.text}</p>
              )}
            </>
          ) : (
            <p className="text-muted-foreground">None yet. Fixes are written for the issues that come back most often.</p>
          )}
        </section>

        <section className="mb-10">
          <SectionTitle aside={<span className="text-[12px] text-faint num">{plural(total, "session")} · {days}d · one cell per day</span>}>History</SectionTitle>
          <HeatStrip values={history.map((d) => d.sessions)} days={history.map((d) => d.day)} className="h-6 w-full gap-[2px]" />
          <div className="mt-1 flex justify-between text-[12px] text-faint num">
            <span>{dayLabel(history[0].day)}</span>
            <span>today</span>
          </div>
        </section>

        {example && (
          <section className="mb-10">
            <SectionTitle aside={sessions[0] && <Link to={`/sessions/${sessions[0].id}#s-${sessions[0].seq}`} className="text-[12px] text-faint hover:text-foreground hover:underline">open the session at step {num(sessions[0].seq)}</Link>}>Latest time it happened</SectionTitle>
            {exampleStep && (
              <div className="mb-3">
                <div className="mb-1 text-[12px] text-faint">{sessions[0]?.title} · {exampleStep.name} was asked to run</div>
                <pre className="max-h-48 overflow-auto rounded-md border bg-pane px-3 py-2.5 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap text-foreground">{exampleStep.input}</pre>
              </div>
            )}
            <div className="mb-1 text-[12px] text-faint">and got</div>
            <p className="font-mono text-[13px] break-words text-fail">{errorDetail(example)}</p>
            <Collapsible>
              <CollapsibleTrigger className="group mt-1.5 flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground">
                <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
                The full error
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="mt-1.5 max-h-64 overflow-auto rounded-md border bg-pane px-3 py-2.5 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap text-foreground/90">
                  {example.replace(/<\/?tool_use_error>/g, "").trim()}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          </section>
        )}

        {g.issues.length > 1 && <Variants issues={g.issues} messages={r.data.messages ?? {}} />}

        <SectionTitle aside={<span className="text-[12px] text-faint num">{plural(sessions.length, "session")} · all time, last active first</span>}>Sessions</SectionTitle>
        {sessions.length === 0 ? (
          <Empty>No sessions.</Empty>
        ) : (
          <Table className="table-fixed">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Session</TableHead>
                {people.size > 1 && <TableHead className="hidden w-32 sm:table-cell">Person</TableHead>}
                <TableHead className="w-16 text-right">Step</TableHead>
                <TableHead className="w-24 text-right">Last active</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((s) => (
                <TableRow key={s.id} className="group">
                  <TableCell className="py-2 whitespace-normal">
                    <Link to={`/sessions/${s.id}`} className="line-clamp-1 text-foreground underline-offset-2 group-hover:underline">{s.title}</Link>
                    <span className="mt-0.5 block truncate text-[12px] text-faint">{projectName(s.project)}</span>
                  </TableCell>
                  {people.size > 1 && <TableCell className="hidden truncate sm:table-cell">{s.person}</TableCell>}
                  <TableCell className="text-right text-[12px]">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Link to={`/sessions/${s.id}#s-${s.seq}`} className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline num">{num(s.seq)}</Link>
                      </TooltipTrigger>
                      <TooltipContent>Open the session at this step</TooltipContent>
                    </Tooltip>
                  </TableCell>
                  <TableCell className="text-right text-[12px] text-muted-foreground num" title={fullDate(s.endedAt)}>{when(s.endedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </Page>
  );
}
