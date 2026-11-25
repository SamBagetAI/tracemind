/**
 * Small data marks. Each one is readable on its own: a heat strip whose cells say their day and
 * count, a clean tick.
 */
import { Check, Wrench } from "lucide-react";
import { dayLabel, plural } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * One cell per day; the more sessions, the stronger the cell. Hover a cell for its day and count.
 * Days without any are a faint cell, so the time axis is always visible.
 */
export function HeatStrip({ values, days, className, tone = "fail" }: { values: number[]; days?: string[]; className?: string; tone?: "fail" | "muted" }) {
  const max = Math.max(1, ...values);
  return (
    <span className={cn("flex h-3.5 w-[120px] gap-px", className)} role="img" aria-label={`${values.reduce((a, b) => a + b, 0)} over ${values.length} days`}>
      {values.map((v, i) => (
        <span
          key={i}
          title={days ? `${dayLabel(days[i])}: ${plural(v, "session")}` : plural(v, "session")}
          className={cn("min-w-0 flex-1 rounded-[1px]", v === 0 ? "bg-muted" : tone === "fail" ? "bg-fail" : "bg-muted-foreground")}
          style={v ? { opacity: 0.35 + 0.65 * (v / max) } : undefined}
        />
      ))}
    </span>
  );
}

export function Clean({ label = "clean" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-ok">
      <Check className="size-3.5" strokeWidth={2.5} />
      <span className="text-[12px]">{label}</span>
    </span>
  );
}

export function SectionTitle({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <h2 className="text-[13px] font-medium text-muted-foreground">{children}</h2>
      {aside}
    </div>
  );
}

/** Sessions in the period before, with ▲ when it grew since and ▼ when it shrank; "new" when it did not happen before. */
export function Trend({ now, before }: { now: number; before: number }) {
  if (before === 0) return now > 0 ? <span className="text-[12px] text-fail">new</span> : null;
  if (now === before) return <span className="text-[12px] text-muted-foreground num">{before}</span>;
  const up = now > before;
  return <span className={`text-[12px] num ${up ? "text-fail" : "text-muted-foreground"}`}>{before} {up ? "▲" : "▼"}</span>;
}

/**
 * A session as the strip its own page opens on, at row size: one line from start to end with a red
 * tick where each tool call failed. The same picture as the session page, so a row and its page look alike.
 */
export function FailureStrip({ marks, count, className }: { marks: { at: number; kind: "error" | "interrupt" }[]; count: number; className?: string }) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <span className="relative h-3 w-[96px] shrink-0" aria-hidden>
        <span className="absolute inset-x-0 top-1/2 h-px bg-border" />
        {marks.map((m, i) => (
          <span key={i} className={cn("absolute top-0 h-3 w-[2px] rounded-[1px]", m.kind === "error" ? "bg-fail" : "bg-foreground/60")} style={{ left: `${Math.min(98, m.at * 100)}%` }} />
        ))}
      </span>
      <span className={cn("text-[12px] num", count ? "text-fail" : "text-faint")}>{count || ""}</span>
    </span>
  );
}

/** Whether an issue has a fix: "fix ready", "applied", or nothing. */
export function FixMark({ fix, at, lastSeen }: { fix?: "ready" | "applied" | null; at?: string | null; lastSeen?: string }) {
  // An applied fix is not a fixed issue: say whether the issue came back after it.
  if (fix === "applied") {
    const since = at && lastSeen && lastSeen > at;
    return since ? (
      <span className="text-[12px] text-fail" title={`Fix applied ${at.slice(0, 10)}; the issue happened again after it.`}>seen since fix</span>
    ) : (
      <span className="inline-flex items-center gap-1 text-[12px] text-ok" title={at ? `Fix applied ${at.slice(0, 10)}` : undefined}><Check className="size-3" strokeWidth={2.5} />not seen since fix</span>
    );
  }
  if (fix === "ready") return <span className="inline-flex items-center gap-1 text-[12px] text-foreground"><Wrench className="size-3" />fix ready</span>;
  return null;
}
