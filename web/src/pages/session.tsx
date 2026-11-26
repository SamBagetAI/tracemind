/**
 * One session, as one trace across the page. It opens on the facts and a time strip, then the
 * steps: quiet stretches fold, repeated failures collapse, and a failure shows its error in full
 * (up to three lines) with its issue on the line below. What the agent knew sits in the trace
 * itself: what was loaded at the start, and the memory read or written at the step it happened.
 */
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { SidePanel } from "@/components/session/side-panel";
import { FoldRow, StartContext, StepRow } from "@/components/session/steps";
import { TimeStrip } from "@/components/session/time-strip";
import { Failed, Loading } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useApi, type MemoryEvent, type Trace } from "@/lib/api";
import { compact, duration, fullDate, plural, projectName, when } from "@/lib/format";
import { activeLabel } from "@/lib/diary";
import { buildRows, diagnosis, failureAnchors, nextAnchor, type Row } from "@/lib/trace";
import { useWindow } from "@/lib/window";

// ---------------------------------------------------------------- page

/**
 * The header's arrows browse the sessions before and after this one (the server's `nav`), among the
 * sessions in the window. A session outside the window is browsed among all sessions, and the header says so.
 */
function Header({ t, nav }: { t: Trace; nav: Nav }) {
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

type Nav = NonNullable<Trace["nav"]> & { scoped: boolean; days: number };
/** Not among the newest sessions the server ranks: no position and no arrows. */
const NO_NAV = { newer: null, older: null, index: -1, total: 0 };

export function SessionPage() {
  const { id = "" } = useParams();
  const { days } = useWindow();
  const t = useApi<Trace>(`/sessions/${encodeURIComponent(id)}?days=${days}`);
  const nav = useMemo<Nav>(() => ({ ...(t.data?.nav ?? NO_NAV), scoped: t.data?.issueWindow != null, days }), [t.data, days]);
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
  // Rows are memoized (steps.tsx), and everything they are handed here keeps its identity between
  // renders: opening a row renders that row, not the thousands of a long session.
  const renderRow = (r: Row): ReactNode => {
    if (r.type === "fold") {
      const key = -r.steps[0].seq;
      return <FoldRow key={`f${key}`} steps={r.steps} opened={open.has(key) ? open : null} t0={t0} onToggle={toggle} memory={memoryBySeq} issueWindow={issueWindow} />;
    }
    const seq = r.type === "repeat" ? r.steps[0].seq : r.step.seq;
    return <StepRow key={seq} row={r} t0={t0} open={open.has(seq)} onToggle={toggle} memory={memoryBySeq} issueWindow={issueWindow} current={current === seq} />;
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
