/** The strip under a session's header: every step as a mark, by step or by time; click one to jump to it. */
import { memo, useMemo, useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Step } from "@/lib/api";
import { duration, elapsed, num, plural } from "@/lib/format";
import { timeline } from "@/lib/trace";
import { cn } from "@/lib/utils";

/** Memoized: up to 400 marks with a tooltip each, which opening a row below must not render again. */
export const TimeStrip = memo(function TimeStrip({ steps, toolCalls, onJump }: { steps: Step[]; toolCalls: number; onJump: (seq: number) => void }) {
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
});
