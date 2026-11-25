/**
 * Shrinks a trace until its JSON fits in `maxBytes`, so it can be sent to a server with a request
 * size limit (Vercel's is 4.5 MB). Failures and memory are kept whole for as long as possible:
 * first the output of steps that went fine is cut, then their input, and last, steps from the
 * middle of the session that did not fail are left out, with a marker saying how many.
 */
import type { Step, Trace } from "./types.ts";

const size = (t: Trace) => Buffer.byteLength(JSON.stringify(t));
const fits = (t: Trace, maxBytes: number, maxSteps: number) => t.steps.length <= maxSteps && size(t) <= maxBytes;

function cut(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}… [cut to send]`;
}

export function fitTrace(trace: Trace, maxBytes: number, maxSteps = 20000): Trace {
  let t = trace;
  if (fits(t, maxBytes, maxSteps)) return t;

  const passes: ((s: Step) => Step)[] = [
    (s) => (s.isError ? s : { ...s, output: cut(s.output, 400) }),
    (s) => (s.isError ? s : { ...s, output: cut(s.output, 120), input: cut(s.input, 200) }),
    (s) => ({ ...s, output: cut(s.output, s.isError ? 1000 : 80), input: cut(s.input, 120) }),
  ];
  for (const pass of passes) {
    t = { ...t, steps: t.steps.map(pass) };
    if (fits(t, maxBytes, maxSteps)) return t;
  }

  // Keep the start, the end, every failure, every prompt and every step memory or a finding points at.
  const pinned = new Set<number>([...t.findings.map((f) => f.seq), ...t.memory.map((m) => m.seq)]);
  for (let ends = Math.min(500, Math.floor(maxSteps / 4)); ; ends = Math.floor(ends / 2)) {
    const n = t.steps.length;
    const kept: Step[] = [];
    let gap: { seq: number; at: string; count: number } | null = null;
    const closeGap = () => {
      if (!gap) return;
      // The marker takes the number of the first step it stands for, which is free.
      kept.push({ seq: gap.seq, kind: "compact", name: `${gap.count} steps not sent`, input: "", output: "", isError: false, at: gap.at, durationMs: null, sidechain: false });
      gap = null;
    };
    t.steps.forEach((s, i) => {
      const keep = i < ends || i >= n - ends || s.isError || pinned.has(s.seq) || s.kind === "prompt" || s.kind === "interrupt";
      if (keep) {
        closeGap();
        kept.push(s);
      } else if (gap) {
        gap.count++;
      } else {
        gap = { seq: s.seq, at: s.at, count: 1 };
      }
    });
    closeGap();
    const out = { ...t, steps: kept };
    if (fits(out, maxBytes, maxSteps) || ends <= 5) return out;
  }
}
