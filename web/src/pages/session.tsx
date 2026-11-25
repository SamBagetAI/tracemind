/**
 * One session, as one trace across the page. It opens on the facts and a time strip, then the
 * steps: quiet stretches fold, repeated failures collapse, and a failure shows its error in full
 * (up to three lines) with its issue on the line below. What the agent knew sits in the trace
 * itself: what was loaded at the start, and the memory read or written at the step it happened.
 */
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { copyText } from "@/components/change";
import { FixMark, SectionTitle } from "@/components/marks";
import { Failed, Loading } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useApi, type Finding, type IssueRef, type MemoryEvent, type Session, type Step, type Trace } from "@/lib/api";
import { compact, describeIssue, duration, elapsed, fullDate, num, plainText, plural, projectName, sessionsLevel, LEVEL_CLASS, shortPath, memoryLabel, splitPath, when } from "@/lib/format";
import { activeLabel } from "@/lib/diary";
import { buildRows, commandLine, diagnosis, errorDetail, failureAnchors, findingsByCause, foldSummary, nextAnchor, startFiles, timeline, type Row } from "@/lib/trace";
import { cn } from "@/lib/utils";
import { useWindow } from "@/lib/window";

// ---------------------------------------------------------------- time strip

function TimeStrip({ steps, toolCalls, onJump }: { steps: Step[]; toolCalls: number; onJump: (seq: number) => void }) {
  const [scale, setScale] = useState<"step" | "time">("step");
  const tl = useMemo(() => timeline(steps, scale), [steps, scale]);
  const marks = useMemo(() => {
    if (tl.marks.length <= 400) return tl.marks;
    const buckets = new Map<number, (typeof tl.marks)[number]>();
    for (const m of tl.marks) {
      const b = Math.round(m.at * 400);
      const prev = buckets.get(b);
      if (!prev || (m.isError && !prev.isError)) buckets.set(b, m);
    }
    return [...buckets.values()];
  }, [tl]);
  const failed = steps.filter((s) => s.isError).length;
  return (
    <div>
      <div className="flex items-baseline justify-between pb-1.5 text-[12px] text-faint">
        <span className="num">
          {plural(steps.length, "step")} · {plural(toolCalls, "tool call")}
          {failed > 0 && <span className="text-fail"> · {failed} failed</span>}
        </span>
        <span className="flex items-center gap-3">
          <span className="hidden items-center gap-1 md:flex"><i className="inline-block h-2.5 w-[2px] bg-foreground" /> prompt</span>
          <span className="hidden items-center gap-1 md:flex"><i className="inline-block h-2 w-2 bg-muted-foreground/70" /> {scale === "step" ? "step" : "step, as long as it ran"}</span>
          <span className="hidden items-center gap-1 md:flex"><i className="inline-block h-2 w-2 bg-fail" /> failed</span>
          <ToggleGroup type="single" value={scale} onValueChange={(v) => v && setScale(v as "step" | "time")} variant="outline" size="sm" aria-label="Timeline scale">
            <ToggleGroupItem value="step" className="h-6 px-2 text-[11px]">By step</ToggleGroupItem>
            <ToggleGroupItem value="time" className="h-6 px-2 text-[11px]">By time</ToggleGroupItem>
          </ToggleGroup>
        </span>
      </div>
      <div className="relative h-8 border-b" role="img" aria-label={`Timeline of ${steps.length} steps, ${failed} failed`}>
        {marks.map((m) => {
          const cls = m.isError
            ? "bottom-0 h-5 bg-fail"
            : m.kind === "prompt"
              ? "bottom-0 h-7 w-[2px] bg-foreground"
              : m.kind === "reply" || m.kind === "compact"
                ? "bottom-0 h-2 bg-muted-foreground/50"
                : "bottom-0 h-3 bg-muted-foreground/70";
          return (
            <Tooltip key={m.seq}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onJump(m.seq)}
                  aria-label={`Step ${m.seq}: ${m.name}`}
                  className={cn("absolute min-w-[2px] rounded-[1px] transition-opacity hover:opacity-60 focus-visible:outline-2", cls)}
                  style={{ left: `${(m.at * 100).toFixed(2)}%`, width: m.kind === "prompt" ? undefined : `max(2px, ${(m.width * 100).toFixed(2)}%)` }}
                />
              </TooltipTrigger>
              <TooltipContent side="top" className="font-mono text-[11px]">
                step {m.seq} · {m.name}
                {m.durationMs != null && ` · ${duration(m.durationMs)}`}
                {m.isError && " · failed"}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      <div className="flex justify-between pt-1 text-[12px] text-faint num">
        <span>{scale === "step" ? "step 1" : "+0:00"}</span>
        <span>{scale === "step" ? `step ${num(steps[steps.length - 1]?.seq ?? 0)} · ${elapsed(tl.total)} after the first` : `${elapsed(tl.total)} after the first step`}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- what it knew, inline

function MemoryChip({ m }: { m: MemoryEvent }) {
  const { name, folder } = memoryLabel(m);
  const label = m.source === "skill" ? `skill ${name}` : m.source === "mcp" ? name : name;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={cn(
            "inline-flex max-w-full items-center gap-1 rounded-sm border px-1.5 py-px font-mono text-[11px] transition-colors hover:border-ring",
            m.op === "write" ? "border-ok/40 text-ok" : "text-muted-foreground",
          )}
        >
          <span className="shrink-0 font-sans text-faint">{m.op === "write" ? "wrote" : m.source === "instructions" ? "loaded" : "read"}</span>
          <span className="truncate text-foreground/90">{label}</span>
          {folder && <span className="hidden truncate text-faint sm:inline">{folder.replace(/^~\/…\//, "")}</span>}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">
        <span className="block font-mono text-[11px] break-all">{m.ref}</span>
        {m.preview && <span className="mt-1 block text-[12px] opacity-80">{plainText(m.preview).slice(0, 220)}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

function StartContext({ memory }: { memory: MemoryEvent[] }) {
  const atStart = startFiles(memory);
  const used = memory.filter((m) => m.source !== "instructions");
  return (
    <li className={cn(GRID, "min-h-9 py-2")}>
      <span className="text-right text-[12px] text-faint num">0</span>
      <span className="hidden sm:block" />
      <span />
      <span className="col-span-1 min-w-0 sm:col-span-4">
        <span className="mr-2 text-muted-foreground">Loaded at the start</span>
        <span className="inline-flex flex-wrap gap-1 align-middle">
          {atStart.length ? atStart.map((m) => <MemoryChip key={m.ref} m={m} />) : <span className="text-faint">no instruction files</span>}
        </span>
        {used.length === 0 && <span className="ml-2 text-[12px] text-faint">· no skill or memory file read or written after that</span>}
      </span>
    </li>
  );
}

// ---------------------------------------------------------------- rows

/** Shared column layout: step, time, mark, tool, input, result, duration. Phones drop time and fold the rest. */
const GRID =
  "grid items-baseline gap-x-3 px-2 grid-cols-[44px_14px_minmax(0,1fr)_auto] sm:grid-cols-[46px_44px_14px_140px_minmax(0,1.15fr)_minmax(0,1fr)_60px]";

function Raw({ label, text }: { label: string; text: string }) {
  if (!text) return null;
  return (
    <div className="mt-2 first:mt-0">
      <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-faint">
        {label}
        <Button variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground" onClick={() => copyText(text, label)}>
          <Copy className="size-3" /> Copy
        </Button>
      </div>
      <pre className="max-h-80 overflow-auto rounded-md border bg-pane p-2.5 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap text-foreground/90">{text}</pre>
    </div>
  );
}

function IssueLine({ finding, issue, window }: { finding?: Finding; issue?: IssueRef; window: number | null }) {
  if (!finding || !issue) return null;
  return (
    <span className="text-[12px] text-faint num">
      <Link to={`/issues/${encodeURIComponent(finding.key)}`} className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={(e) => e.stopPropagation()}>
        {issue.what ?? "issue"}
      </Link>
      {" · "}
      <span className={issue.sessions > 1 ? LEVEL_CLASS[sessionsLevel(issue.sessions)] : ""}>{plural(issue.sessions, "session")} · {window ? `${window}d` : "all time"}</span>
      {issue.status === "resolved" && " · resolved"}
    </span>
  );
}

function StepRow({ row, t0, open, onToggle, memory, issueWindow, current }: { row: Extract<Row, { type: "step" | "repeat" }>; t0: number; open: boolean; onToggle: () => void; memory: Map<number, MemoryEvent[]>; issueWindow: number | null; current?: boolean }) {
  const steps = row.type === "repeat" ? row.steps : [row.step];
  const first = steps[0];
  const last = steps[steps.length - 1];
  const failed = first.isError;
  const totalMs = steps.reduce((n, s) => n + (s.durationMs ?? 0), 0);
  const tool = row.type === "repeat" ? `${first.name} ×${steps.length}` : first.name;
  const seq = row.type === "repeat" ? `${num(first.seq)}–${num(last.seq)}` : num(first.seq);
  const text = first.kind === "prompt" || first.kind === "reply" || first.kind === "interrupt" || first.kind === "compact";
  const inputs = [...new Set(steps.map((s) => (s.name === "Bash" ? commandLine(s.input) : shortPath(s.input.split("\n")[0]))))].join(", ");
  const resultLine = first.output.split("\n").find((l) => l.trim()) ?? "";
  const described = row.finding ? describeIssue(row.finding) : null;
  const detail = failed ? errorDetail(first.output) : "";
  // The cause's name is on the line below (with its count); the red line carries what this step said.
  const errorText = failed ? (row.issue?.what || !described?.plain ? detail : `${described.what} — ${detail}`) : "";
  const icon = failed ? (
    <X className="size-3.5 text-fail" strokeWidth={2.5} />
  ) : first.kind === "prompt" ? (
    <ChevronRight className="size-3.5" />
  ) : (
    <span className="block size-1 rounded-full bg-faint" />
  );
  const expandable = !!(first.input || first.output) && first.kind !== "compact";
  const stepMemory = steps.flatMap((s) => memory.get(s.seq) ?? []);

  return (
    <Collapsible open={open} onOpenChange={onToggle} asChild>
      <li id={`s-${first.seq}`} className={cn("relative scroll-mt-20", failed && "before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-fail", current && "ring-1 ring-fail/50 ring-inset")}>
        <CollapsibleTrigger asChild disabled={!expandable}>
          <div
            role="button"
            tabIndex={expandable ? 0 : -1}
            aria-expanded={expandable ? open : undefined}
            className={cn(GRID, "group/row py-1.5 transition-colors", expandable && "cursor-pointer hover:bg-accent focus-visible:bg-accent focus-visible:outline-none", open && "bg-accent/60")}
          >
            <span className="text-right text-[12px] whitespace-nowrap text-faint num">{seq}</span>
            <span className="hidden text-right text-[12px] text-faint num sm:block">{elapsed(Date.parse(first.at) - t0)}</span>
            <span className="flex h-5 items-center justify-center self-start">{icon}</span>
            {text ? (
              <>
                <span className={cn("hidden truncate sm:block", first.kind === "prompt" ? "font-medium text-foreground" : "text-muted-foreground")}>{first.name}</span>
                <span className={cn("min-w-0 truncate sm:col-span-2", first.kind === "prompt" ? "text-foreground" : "text-foreground/75")}>
                  <span className="mr-1.5 font-medium sm:hidden">{first.name}</span>
                  {first.kind === "prompt" ? first.input : first.output}
                </span>
              </>
            ) : (
              <>
                <span className="hidden truncate font-mono text-[12px] text-foreground sm:block">{tool}</span>
                <span className="hidden min-w-0 truncate font-mono text-[12px] text-foreground/80 sm:block">{inputs}</span>
                <span className="hidden min-w-0 truncate text-[12px] text-muted-foreground sm:block">{failed ? "" : resultLine}</span>
                <span className="min-w-0 sm:hidden">
                  <span className="block truncate font-mono text-[12px] text-foreground">{tool}</span>
                  <span className="line-clamp-2 font-mono text-[12px] break-all text-foreground/70">{inputs}</span>
                  {!failed && <span className="block truncate text-[12px] text-muted-foreground">{resultLine}</span>}
                </span>
              </>
            )}
            <span className="flex items-baseline justify-end gap-1 text-right text-[12px] text-faint num">
              {totalMs ? duration(totalMs) : ""}
              {expandable && <ChevronRight className={cn("size-3 self-center opacity-0 transition-[opacity,transform] group-hover/row:opacity-100", (open || failed) && "opacity-100", open && "rotate-90")} />}
            </span>
            {failed && (
              <span className="col-start-3 col-end-5 pt-0.5 pb-1 sm:col-start-4 sm:col-end-8">
                <span className="line-clamp-3 font-mono text-[12px] leading-snug break-words text-fail">{errorText}</span>
                <IssueLine finding={row.finding} issue={row.issue} window={issueWindow} />
                {!open && <span className="mt-0.5 block text-[11px] text-faint group-hover/row:text-muted-foreground">Open for the full {first.name === "Bash" ? "command" : "input"} and error</span>}
              </span>
            )}
            {stepMemory.length > 0 && (
              <span className="col-start-3 col-end-5 flex flex-wrap gap-1 pb-1 sm:col-start-4 sm:col-end-8">
                {stepMemory.map((m, i) => <MemoryChip key={i} m={m} />)}
              </span>
            )}
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="pr-2 pb-3 pl-[72px] sm:pl-[150px]">
            {steps.length > 1 && <p className="mb-2 text-[12px] text-muted-foreground">Steps {seq} failed the same way. The first one:</p>}
            {first.kind !== "reply" && <Raw label={first.kind === "prompt" ? "Prompt" : "Input"} text={first.input} />}
            <Raw label={failed ? "Error" : first.kind === "reply" ? "Reply" : "Output"} text={first.output} />
          </div>
        </CollapsibleContent>
      </li>
    </Collapsible>
  );
}

function FoldRow({ steps, open, onToggle, children }: { steps: Step[]; open: boolean; onToggle: () => void; children: ReactNode }) {
  const a = steps[0].seq;
  const b = steps[steps.length - 1].seq;
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(GRID, "w-full border-y border-dashed py-1.5 text-left text-muted-foreground transition-colors hover:bg-accent hover:text-foreground")}
      >
        <span className="text-right text-[12px] whitespace-nowrap text-faint num">{num(a)}–{num(b)}</span>
        <span className="hidden sm:block" />
        <ChevronRight className={cn("size-3.5 self-center transition-transform", open && "rotate-90")} />
        <span className="col-span-1 truncate sm:col-span-3">
          {plural(steps.length, "step")} went fine
          <span className="text-[12px] text-faint"> · <span className="font-mono text-[11px]">{foldSummary(steps)}</span></span>
        </span>
        <span className="text-right text-[12px] text-faint num">{duration(steps.reduce((n, s) => n + (s.durationMs ?? 0), 0))}</span>
      </button>
      {open && <ul>{children}</ul>}
    </li>
  );
}

// ---------------------------------------------------------------- side panel

/** On wide screens: what the session started with, what it read or wrote, and the issues it hit with their fixes. */
function SidePanel({ t, onJump }: { t: Trace; onJump: (seq: number) => void }) {
  const atStart = startFiles(t.memory);
  const used = [...new Map(t.memory.filter((m) => m.source !== "instructions").map((m) => [`${m.op}:${m.ref}`, m])).values()];
  const issues = findingsByCause(t);
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

// ---------------------------------------------------------------- page

/**
 * The sessions before and after this one, among the sessions in the window. A session outside the
 * window is browsed among all sessions, and the header says so.
 */
function useNeighbours(id: string, days: number) {
  const list = useApi<Session[]>("/sessions?limit=1000");
  return useMemo(() => {
    const all = list.data ?? [];
    const from = new Date(Date.now() - days * 86400000).toISOString();
    const inWindow = all.filter((s) => s.startedAt >= from);
    const scoped = inWindow.some((s) => s.id === id);
    const ids = (scoped ? inWindow : all).map((s) => s.id);
    const i = ids.indexOf(id);
    return { newer: i > 0 ? ids[i - 1] : null, older: i >= 0 && i < ids.length - 1 ? ids[i + 1] : null, index: i, total: ids.length, scoped, days };
  }, [list.data, id, days]);
}

function Header({ t, nav }: { t: Trace; nav: ReturnType<typeof useNeighbours> }) {
  const s = t.session;
  const d = diagnosis(t);
  const navigate = useNavigate();
  // Two kinds of time, each said: active (gaps up to 15 minutes, as on the Diary) and first to last step.
  const meta = [s.person, s.gitBranch, s.model, `${activeLabel(s.activeMs)} active`, `${duration(Date.parse(s.endedAt) - Date.parse(s.startedAt))} first to last step`, `${compact(s.inputTokens)} in · ${compact(s.outputTokens)} out`].filter(Boolean);
  return (
    <div className="pt-5 pb-4">
      <div className="mb-2 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2">
        <span className="min-w-0 truncate text-[12px] text-faint">
          <Link to="/sessions" className="hover:text-foreground hover:underline">Sessions</Link> / <span title={s.project}>{projectName(s.project)}</span> ·{" "}
          <span title={`started ${fullDate(s.startedAt)}`}>{when(s.endedAt)}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1 sm:ml-auto">
          {nav.index >= 0 && (
            <span className="mr-1 text-[12px] text-faint num">
              {nav.index + 1} of {nav.total} {nav.scoped ? `in the last ${nav.days} days` : `· outside the last ${nav.days} days, browsing all`}
            </span>
          )}
          <Button variant="outline" size="icon-sm" className="size-7" disabled={!nav.newer} onClick={() => nav.newer && navigate(`/sessions/${nav.newer}`)} aria-label="Newer session">
            <ChevronLeft />
          </Button>
          <Button variant="outline" size="icon-sm" className="size-7" disabled={!nav.older} onClick={() => nav.older && navigate(`/sessions/${nav.older}`)} aria-label="Older session">
            <ChevronRight />
          </Button>
        </span>
      </div>
      <h1 className="text-[22px] leading-tight font-semibold tracking-tight text-balance">{s.title}</h1>
      <p className="mt-2 max-w-[80ch] text-[14px] leading-relaxed">
        <span className="font-medium">{d.lead}</span> <span className="text-muted-foreground">{d.rest}</span>
      </p>
      <p className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-faint num">
        {meta.map((m, i) => <span key={i}>{m}</span>)}
      </p>
    </div>
  );
}

export function SessionPage() {
  const { id = "" } = useParams();
  const { days } = useWindow();
  const t = useApi<Trace>(`/sessions/${encodeURIComponent(id)}?days=${days}`);
  const nav = useNeighbours(id, days);
  const navigate = useNavigate();
  const [focus, setFocus] = useState(true);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [current, setCurrent] = useState<number | null>(null);

  useEffect(() => {
    setOpen(new Set());
    setCurrent(null);
    setFocus(true);
    window.scrollTo(0, 0);
  }, [id]);

  const rows = useMemo(() => (t.data ? buildRows(t.data, focus) : []), [t.data, focus]);
  const t0 = t.data?.steps[0] ? Date.parse(t.data.steps[0].at) : 0;
  const toggle = useCallback(
    (key: number) =>
      setOpen((o) => {
        const n = new Set(o);
        if (n.has(key)) n.delete(key);
        else n.add(key);
        return n;
      }),
    [],
  );

  /** Scrolls to a step, opening the fold that hides it. */
  const jump = useCallback(
    (seq: number) => {
      const fold = rows.find((r) => r.type === "fold" && r.steps.some((s) => s.seq === seq));
      if (fold?.type === "fold") setOpen((o) => new Set(o).add(-fold.steps[0].seq));
      const owner = rows.find((r) => r.type === "repeat" && r.steps.some((s) => s.seq === seq));
      const anchor = owner?.type === "repeat" ? owner.steps[0].seq : seq;
      requestAnimationFrame(() => document.getElementById(`s-${anchor}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
    },
    [rows],
  );

  const anchors = useMemo(() => failureAnchors(rows), [rows]);
  /** Moves to the next (1) or previous (-1) failure, opened, with its error in view. */
  const step = useCallback(
    (dir: 1 | -1) => {
      const a = nextAnchor(anchors, current, dir);
      if (a == null) return;
      setCurrent(a);
      setOpen((o) => new Set(o).add(a));
      jump(a);
    },
    [anchors, current, jump],
  );

  // [ and ] move between sessions; j and k between this session's failures.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof HTMLElement && (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName) || e.target.isContentEditable)) return;
      if (e.key === "[" && nav.newer) navigate(`/sessions/${nav.newer}`);
      if (e.key === "]" && nav.older) navigate(`/sessions/${nav.older}`);
      if (e.key === "j") step(1);
      if (e.key === "k") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav, navigate, step]);

  // A link to a step (#s-23) opens the session at that step.
  const { hash } = useLocation();
  useEffect(() => {
    const m = /^#s-(\d+)$/.exec(hash);
    if (t.data && m) setTimeout(() => jump(Number(m[1])), 50);
  }, [t.data, hash, jump]);

  const memory = useMemo(() => t.data?.memory ?? [], [t.data]);
  // Skills and memory read or written at each step, found once rather than by every row.
  const memoryBySeq = useMemo(() => {
    const by = new Map<number, MemoryEvent[]>();
    for (const m of memory) if (m.source !== "instructions") by.set(m.seq, [...(by.get(m.seq) ?? []), m]);
    return by;
  }, [memory]);
  const issueWindow = t.data?.issueWindow ?? null;
  const renderRow = (r: Row): ReactNode => {
    if (r.type === "fold") {
      const key = -r.steps[0].seq;
      return (
        <FoldRow key={`f${key}`} steps={r.steps} open={open.has(key)} onToggle={() => toggle(key)}>
          {r.steps.map((s) => <StepRow key={s.seq} row={{ type: "step", step: s }} t0={t0} open={open.has(s.seq)} onToggle={() => toggle(s.seq)} memory={memoryBySeq} issueWindow={issueWindow} />)}
        </FoldRow>
      );
    }
    const seq = r.type === "repeat" ? r.steps[0].seq : r.step.seq;
    return <StepRow key={seq} row={r} t0={t0} open={open.has(seq)} onToggle={() => toggle(seq)} memory={memoryBySeq} issueWindow={issueWindow} current={current === seq} />;
  };

  return (
    <main className="mx-auto w-full max-w-[1120px] px-4 pb-16 sm:px-6 xl:max-w-[1440px]">
      {t.error && <Failed error={t.error} />}
      {!t.data && !t.error && <div className="pt-6"><Loading rows={14} /></div>}
      {t.data && (
        <div key={id} className="xl:grid xl:grid-cols-[minmax(0,1fr)_280px] xl:gap-10">
          <div className="min-w-0">
          <Header t={t.data} nav={nav} />
          <TimeStrip steps={t.data.steps} toolCalls={t.data.session.toolCalls} onJump={jump} />
          <div className="mt-5 mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
            <ToggleGroup type="single" value={focus ? "focus" : "all"} onValueChange={(v) => v && setFocus(v === "focus")} variant="outline" size="sm" aria-label="Which steps">
              <ToggleGroupItem value="focus" className="h-7 px-2.5 text-[12px]">Focus</ToggleGroupItem>
              <ToggleGroupItem value="all" className="h-7 px-2.5 text-[12px]">Every step</ToggleGroupItem>
            </ToggleGroup>
            {anchors.length > 0 && (
              <span className="flex items-center gap-1">
                <Button variant="outline" size="icon-sm" className="size-7" onClick={() => step(-1)} aria-label="Previous failure"><ChevronUp /></Button>
                <Button variant="outline" size="icon-sm" className="size-7" onClick={() => step(1)} aria-label="Next failure"><ChevronDown /></Button>
                <span className="ml-1 text-[12px] text-muted-foreground num">
                  {current != null && anchors.includes(current) ? `Failure ${anchors.indexOf(current) + 1} of ${anchors.length}` : plural(anchors.length, "failure")}
                </span>
              </span>
            )}
            <span className="ml-auto hidden items-center gap-1 text-[12px] text-faint sm:inline-flex">
              {anchors.length > 0 && (
                <>
                  <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">j</kbd>
                  <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">k</kbd>
                  failures ·{" "}
                </>
              )}
              <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">[</kbd>
              <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">]</kbd>
              sessions
            </span>
          </div>
          <ul className="border-y">
            <StartContext memory={memory} />
            {rows.map(renderRow)}
          </ul>
          </div>
          <SidePanel t={t.data} onJump={jump} />
        </div>
      )}
    </main>
  );
}
