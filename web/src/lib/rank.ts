import type { Tool } from "./api";

/** Below this many calls a rate is too unsure to rank against tools with many calls. */
export const FEW = 20;

/**
 * The lower end of a failure rate's 90% confidence range (Wilson): how bad it surely is.
 * 50 failures in 500 calls is surely worse than 0 in 300, and 10 in 20 surely worse than 1 in 2.
 */
export function wilsonLow(errors: number, calls: number, z = 1.645): number {
  if (calls === 0) return 0;
  const p = errors / calls;
  const d = 1 + (z * z) / calls;
  const centre = p + (z * z) / (2 * calls);
  const margin = z * Math.sqrt((p * (1 - p)) / calls + (z * z) / (4 * calls * calls));
  return Math.max(0, (centre - margin) / d);
}

/**
 * Three tiers, so a tiny sample never tops the list and a real failure never sinks below clean tools:
 * tools with enough calls that fail (highest failure rate first, the surer one first on a tie), then
 * tools with few calls that failed (most failures first), then tools that never failed (most used first).
 * The page says exactly this, so the order a person sees is the order they were told.
 */
export function rankTools(tools: Tool[]): Tool[] {
  const tier = (t: Tool) => (t.errors === 0 ? 2 : t.calls >= FEW ? 0 : 1);
  return [...tools].sort(
    (a, b) =>
      tier(a) - tier(b) ||
      (tier(a) === 0 ? b.errors / b.calls - a.errors / a.calls || wilsonLow(b.errors, b.calls) - wilsonLow(a.errors, a.calls) : 0) ||
      b.errors - a.errors ||
      b.calls - a.calls,
  );
}
