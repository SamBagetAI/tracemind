/** The rows of a session's trace: a step (or a run of identical failures), a fold of quiet steps, and what was loaded at the start. */
import { ChevronRight, Copy, X } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { copyText } from "@/components/change";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Finding, IssueRef, MemoryEvent, Step } from "@/lib/api";
import { describeIssue, duration, elapsed, num, plainText, plural, sessionsLevel, LEVEL_CLASS, shortPath, memoryLabel } from "@/lib/format";
import { commandLine, errorDetail, foldSummary, startFiles, type Row } from "@/lib/trace";
import { cn } from "@/lib/utils";

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

export function StartContext({ memory }: { memory: MemoryEvent[] }) {
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

export function StepRow({ row, t0, open, onToggle, memory, issueWindow, current }: { row: Extract<Row, { type: "step" | "repeat" }>; t0: number; open: boolean; onToggle: () => void; memory: Map<number, MemoryEvent[]>; issueWindow: number | null; current?: boolean }) {
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

export function FoldRow({ steps, open, onToggle, children }: { steps: Step[]; open: boolean; onToggle: () => void; children: ReactNode }) {
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
