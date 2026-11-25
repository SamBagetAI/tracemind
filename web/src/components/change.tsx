/**
 * How a suggested change is shown and applied, wherever it appears (the Suggestions page, a
 * cause's page): the lines it adds or the hook it installs, written out before anything is
 * applied; Apply with a preview; Undo; and once applied, how often the problem happened before and since.
 */
import { ArrowRight, Check, Copy, Undo2 } from "lucide-react";
import { Link } from "react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loading } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, usePost, type Preview, type Suggestion } from "@/lib/api";
import { plural, shortPath, when } from "@/lib/format";
import { cn } from "@/lib/utils";

export async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied. Paste it into Claude Code.`);
  } catch {
    toast.error("Could not copy. Select the text and copy it instead.");
  }
}

type FullPreview = Preview & { sampleProject?: string };

function usePreview(id: string, enabled: boolean) {
  const [p, setP] = useState<FullPreview | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setP(null);
    api<FullPreview>(`/suggestions/${id}/preview`, { method: "POST", body: "{}" })
      .then((x) => live && setP(x))
      .catch(() => live && setP(null));
    return () => {
      live = false;
    };
  }, [id, enabled]);
  return p;
}

/** The change written out: the rule as it will read in the file, or the hook and what it will say. */
export function ChangeBody({ s }: { s: Suggestion }) {
  const a = s.action;
  const hook = usePreview(s.id, a.type === "routine");
  if (a.type === "rule") {
    return (
      <div className="mt-2.5 min-w-0">
        <div className="mb-1 text-[12px] text-faint">
          Adds a line to <span className="font-mono text-[11px]">{shortPath(a.file)}</span>
        </div>
        <p className="border-l-2 border-ok/60 py-0.5 pl-3 text-[13px] text-foreground/90">{a.text}</p>
      </div>
    );
  }
  if (a.type === "routine") {
    return (
      <div className="mt-2.5 grid min-w-0 gap-2">
        <div>
          <div className="mb-1 text-[12px] text-faint">
            Adds a <span className="font-mono text-[11px]">SessionStart</span> hook to <span className="font-mono text-[11px]">~/.claude/settings.json</span> that runs
          </div>
          <p className="border-l-2 border-ok/60 py-0.5 pl-3 font-mono text-[12px] break-all text-foreground/90">{hook && "hook" in hook ? hook.hook.replace(/\/(?:Users|home)\/[^/"]+/g, "~") : "…"}</p>
        </div>
        {hook && "sample" in hook && hook.sample && (
          <div>
            <div className="mb-1 text-[12px] text-faint">
              A new session in <span className="font-mono text-[11px]">{shortPath(hook.sampleProject ?? "")}</span> would be told
            </div>
            <p className="border-l-2 border-border py-0.5 pl-3 text-[12px] leading-relaxed whitespace-pre-wrap text-muted-foreground">{hook.sample}</p>
          </div>
        )}
      </div>
    );
  }
  if (a.type === "prompt") {
    return (
      <div className="mt-2.5 min-w-0">
        <div className="mb-1 text-[12px] text-faint">A prompt to paste into Claude Code</div>
        <p className="line-clamp-4 border-l-2 border-border py-0.5 pl-3 text-[12px] leading-relaxed whitespace-pre-wrap text-muted-foreground">{a.text}</p>
      </div>
    );
  }
  return <p className="mt-2 text-muted-foreground">{s.why}</p>;
}

function ApplyDialog({ s, open, onOpenChange, onApplied }: { s: Suggestion; open: boolean; onOpenChange: (o: boolean) => void; onApplied: () => void }) {
  const p = usePreview(s.id, open);
  const { busy, post } = usePost();
  const go = async () => {
    if (await post<{ file: string }>(`/suggestions/${s.id}/apply`, {}, (r) => `Applied to ${shortPath(r.file)}.`)) {
      onOpenChange(false);
      onApplied();
    }
  };
  const isRule = s.action.type === "rule";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{s.title}</DialogTitle>
          <DialogDescription>
            {isRule ? "These lines go at the end of the file. A copy of the file is kept, and Undo takes out exactly these lines." : "This hook goes into your Claude Code settings and runs when a session starts. Undo takes it out."}
          </DialogDescription>
        </DialogHeader>
        {!p && <Loading rows={3} />}
        {p && "file" in p && (
          <div className="min-w-0">
            <div className="mb-1.5 text-[12px] text-faint">
              <span className="font-mono text-[11px]">{shortPath(p.file)}</span>
              {p.exists ? " · end of the file, with the new lines" : " · a new file"}
            </div>
            <pre className="max-h-72 overflow-auto rounded-md border bg-pane py-2 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap">
              {p.tail.trimEnd().split("\n").filter(Boolean).map((l, i) => (
                <span key={`t${i}`} className="grid grid-cols-[20px_1fr] text-faint"><span className="text-center select-none"> </span>{l}</span>
              ))}
              {p.adds.trimEnd().split("\n").map((l, i) => (
                <span key={`a${i}`} className="grid grid-cols-[20px_1fr] bg-ok/10 text-ok"><span className="text-center select-none">+</span>{l}</span>
              ))}
            </pre>
          </div>
        )}
        {p && "hook" in p && (
          <div className="min-w-0">
            <div className="mb-1.5 text-[12px] text-faint"><span className="font-mono text-[11px]">~/.claude/settings.json</span> · hooks · {p.event}</div>
            <pre className="overflow-auto rounded-md border bg-pane py-2 font-mono text-[12px] break-all whitespace-pre-wrap">
              <span className="grid grid-cols-[20px_1fr] bg-ok/10 text-ok"><span className="text-center select-none">+</span>{p.hook}</span>
            </pre>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" onClick={go} disabled={!p || busy}>Apply</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Before (30 days before it was applied) and since, for the causes the change was meant to stop. */
function Effect({ s }: { s: Suggestion }) {
  const e = s.effect;
  if (!e || s.causes.length === 0) return null;
  const before = e.before.sessions ? e.before.hit / e.before.sessions : 0;
  const since = e.since.sessions ? e.since.hit / e.since.sessions : 0;
  // Whose numbers these are: this issue alone (on its page), or any of the issues the fix covers.
  const whose = s.effectScope === "issue" ? "this issue" : s.causes.length > 1 ? `any of its ${s.causes.length} issues` : "it";
  return (
    <p className="mt-1 text-[12px] text-muted-foreground num">
      Before (30 days): {e.before.hit} of {plural(e.before.sessions, "session")} hit {whose} · since:{" "}
      <span className={e.since.sessions === 0 ? "text-faint" : since < before ? "text-ok" : since > 0 ? "text-warn" : "text-ok"}>
        {e.since.sessions === 0 ? "no session yet" : `${e.since.hit} of ${plural(e.since.sessions, "session")}`}
      </span>
    </p>
  );
}

/**
 * Whether the session-start brief is doing its job, from the sessions that started since it was
 * installed: each transcript records whether the hook ran and what it said.
 */
function BriefCheck({ s }: { s: Suggestion }) {
  const c = s.checks;
  if (!c) return null;
  if (c.sessions === 0) return <p className="mt-1 text-[12px] text-muted-foreground">Not checked yet: no session has started since it was installed.</p>;
  if (c.failed > 0) return <p className="mt-1 text-[12px] text-fail num">The brief failed in {c.failed} of {plural(c.sessions, "session")} since it was installed.</p>;
  if (c.unrecorded === c.sessions)
    return <p className="mt-1 text-[12px] text-warn num">No record of it running in the {plural(c.sessions, "session")} since: Claude Code may not have loaded the hook. Restart Claude Code, or check ~/.claude/settings.json.</p>;
  const parts = [
    `Given to ${c.given} of ${plural(c.sessions, "session")} since it was installed`,
    c.empty && `${c.empty} had nothing to report for their project`,
    c.unrecorded && `${c.unrecorded} with no record of it running`,
  ].filter(Boolean);
  return <p className="mt-1 text-[12px] text-muted-foreground num">{parts.join(" · ")}.</p>;
}

export function AppliedLine({ s }: { s: Suggestion }) {
  const a = s.action;
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-1.5 text-ok">
        <Check className="size-3.5" strokeWidth={2.5} />
        {a.type === "rule" ? <>Added to <span className="font-mono text-[12px]">{shortPath(a.file)}</span></> : "Hook installed"}
        <span className="text-[12px] text-faint">{when(s.at)}</span>
      </p>
      <BriefCheck s={s} />
      <Effect s={s} />
    </div>
  );
}

/** The buttons for a change: one main button (Apply or Copy prompt), Dismiss, or Undo once applied. */
export function ChangeActions({ s, canApply, onChange, className }: { s: Suggestion; canApply: boolean; onChange: () => void; className?: string }) {
  const [dialog, setDialog] = useState(false);
  const { busy, post: send } = usePost();
  const a = s.action;
  const post = async (verb: string, done: string) => {
    if (await send(`/suggestions/${s.id}/${verb}`, {}, done)) onChange();
  };
  const applicable = s.fixable;
  if (s.status === "applied") {
    return applicable && canApply ? (
      <Button variant="outline" size="sm" className={cn("h-8", className)} disabled={busy} onClick={() => post("undo", "Undone.")}>
        <Undo2 /> Undo
      </Button>
    ) : null;
  }
  const apply = <Button size="sm" className="h-8" onClick={() => setDialog(true)} disabled={!canApply}>Apply</Button>;
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5", className)}>
      {applicable &&
        (canApply ? apply : (
          <Tooltip>
            <TooltipTrigger asChild><span tabIndex={0}>{apply}</span></TooltipTrigger>
            <TooltipContent>Files are changed from the local app (tracemind ui).</TooltipContent>
          </Tooltip>
        ))}
      {a.type === "prompt" && (
        <Button size="sm" className="h-8" onClick={() => copyText(a.text, "Prompt")}>
          <Copy /> Copy prompt
        </Button>
      )}
      {a.type === "tip" ? (
        <Button variant="outline" size="sm" className="h-8" disabled={busy} onClick={() => post("dismiss", "Noted.")}>Got it</Button>
      ) : (
        <Button variant="ghost" size="sm" className="h-8 text-muted-foreground" disabled={busy} onClick={() => post("dismiss", "Dismissed.")}>Dismiss</Button>
      )}
      {applicable && <ApplyDialog s={s} open={dialog} onOpenChange={setDialog} onApplied={onChange} />}
    </span>
  );
}

/** Where a fix's change goes, in a few words. */
function FixKind({ s }: { s: Suggestion }) {
  const a = s.action;
  if (a.type === "rule") return <>One line in <span className="font-mono text-[11px]">{shortPath(a.file)}</span></>;
  if (a.type === "routine") return <>A hook that briefs new sessions</>;
  if (s.kind === "connect") return <>Connect a tool</>;
  if (s.kind === "trim") return <>Shorten an instruction file</>;
  if (s.kind === "investigate") return <>A prompt to investigate it</>;
  if (a.type === "prompt") return <>A prompt to paste</>;
  return <>A habit</>;
}

/**
 * A fix in one line, for pages other than Fixes: what it is, how many sessions it would help, and a
 * link to its full card on Fixes, where it is written out and applied. Only the Fixes page shows the card.
 */
export function FixLine({ s, issues }: { s: Suggestion; issues?: boolean }) {
  const applied = s.status === "applied";
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <p className="text-foreground">
          {s.title}
        </p>
        {applied ? (
          <>
            <BriefCheck s={s} />
            <Effect s={s} />
          </>
        ) : (
          <p className="mt-0.5 text-[12px] text-faint num">
            <FixKind s={s} />
            {issues && s.causes.length > 1 && ` · covers ${s.causes.length} issues`}
            {` · ${plural(s.sessions, "session")} affected`}
          </p>
        )}
      </div>
      <Link to={`/fixes#${s.id}`} className="inline-flex shrink-0 items-center gap-1 text-[13px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
        {applied ? "See it" : "Review"} <ArrowRight className="size-3" />
      </Link>
    </div>
  );
}
