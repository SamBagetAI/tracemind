import { describe, expect, it } from "vitest";
import { fitTrace } from "../src/core/fit.ts";
import { parseClaudeSession } from "../src/core/parse-claude.ts";
import type { Step, Trace } from "../src/core/types.ts";
import { validateTrace } from "../src/core/validate.ts";
import { mainTranscript } from "./fixtures/session.ts";

function big(steps: number, outputSize: number): Trace {
  const t = parseClaudeSession("big", mainTranscript(), { person: "Ada" });
  const list: Step[] = [];
  for (let i = 1; i <= steps; i++) {
    list.push({ seq: i, kind: "tool", name: "Bash", input: `step ${i}`, output: "x".repeat(outputSize), isError: i === steps / 2, at: new Date(1e12 + i * 1000).toISOString(), durationMs: 5, sidechain: false });
  }
  return { ...t, steps: list, findings: [{ key: "tool_error:x", kind: "tool_error", title: "x", seq: steps / 2 }], memory: [] };
}

const bytes = (t: Trace) => Buffer.byteLength(JSON.stringify(t));

describe("fitTrace", () => {
  it("leaves a small trace alone", () => {
    const t = parseClaudeSession("s", mainTranscript(), { person: "Ada" });
    expect(fitTrace(t, 4_000_000)).toBe(t);
  });

  it("cuts long outputs of steps that went fine before dropping any step", () => {
    const t = big(1000, 4000);
    const out = fitTrace(t, 1_000_000);
    expect(bytes(out)).toBeLessThanOrEqual(1_000_000);
    expect(out.steps.length).toBe(1000);
    expect(out.steps[499].output.length).toBe(4000); // the failure is kept whole
  });

  it("drops steps from the middle, keeps the failure and says how many were left out", () => {
    const t = big(10000, 300);
    const out = fitTrace(t, 400_000);
    expect(bytes(out)).toBeLessThanOrEqual(400_000);
    expect(out.steps[0].seq).toBe(1);
    expect(out.steps[out.steps.length - 1].seq).toBe(10000);
    expect(out.steps.some((s) => s.seq === 5000 && s.isError)).toBe(true);
    const markers = out.steps.filter((s) => s.kind === "compact");
    expect(markers.length).toBe(2);
    const sent = out.steps.length - markers.length;
    const dropped = markers.reduce((n, m) => n + Number(m.name.split(" ")[0]), 0);
    expect(sent + dropped).toBe(10000);
    // Step numbers stay unique and in order, so the server takes it.
    const seqs = out.steps.map((s) => s.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(() => validateTrace(JSON.parse(JSON.stringify(out)))).not.toThrow();
  });
});
