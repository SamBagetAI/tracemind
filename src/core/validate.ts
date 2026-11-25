/** Checks a trace that arrived over the network and coerces it into the expected shape. */
import { clip } from "./redact.ts";
import type { Finding, IssueKind, MemoryEvent, Outcome, Session, Step, StepKind, Trace } from "./types.ts";

const OUTCOMES: Outcome[] = ["ok", "error", "interrupted", "running"];
const KINDS: StepKind[] = ["prompt", "reply", "tool", "subagent", "compact", "interrupt"];
const SOURCES: MemoryEvent["source"][] = ["instructions", "file", "skill", "mcp"];
const OPS: MemoryEvent["op"][] = ["read", "write"];
const ISSUE_KINDS: IssueKind[] =["tool_error", "permission_denied", "step_repetition", "interrupted"];

export const MAX_STEPS = 20000;

export class InvalidTrace extends Error {}

const str = (v: unknown, max: number, field: string): string => {
  if (typeof v !== "string") throw new InvalidTrace(`${field} must be text`);
  return v.length > max ? clip(v, max) : v;
};
const optStr = (v: unknown, max: number, field: string): string | null => (v == null ? null : str(v, max, field));
const num = (v: unknown, field: string): number => {
  const x = Number(v);
  if (!Number.isFinite(x) || x < 0) throw new InvalidTrace(`${field} must be a number`);
  return Math.floor(x);
};
const iso = (v: unknown, field: string): string => {
  const s = str(v, 40, field);
  if (Number.isNaN(Date.parse(s))) throw new InvalidTrace(`${field} must be a date`);
  return new Date(s).toISOString();
};
function oneOf<T extends string>(v: unknown, list: T[], field: string): T {
  if (!list.includes(v as T)) throw new InvalidTrace(`${field} must be one of ${list.join(", ")}`);
  return v as T;
}

export function validateTrace(body: unknown): Trace {
  if (!body || typeof body !== "object") throw new InvalidTrace("body must be a trace");
  const b = body as Record<string, any>;
  const s = b.session ?? {};
  if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(String(s.id ?? ""))) throw new InvalidTrace("session.id is missing or malformed");
  if (!Array.isArray(b.steps) || !Array.isArray(b.memory) || !Array.isArray(b.findings)) {
    throw new InvalidTrace("steps, memory and findings must be lists");
  }
  if (b.steps.length > MAX_STEPS) throw new InvalidTrace(`a session holds at most ${MAX_STEPS} steps`);

  const session: Session = {
    id: String(s.id),
    agent: str(s.agent, 40, "session.agent"),
    person: str(s.person ?? "", 120, "session.person"),
    project: str(s.project, 500, "session.project"),
    title: str(s.title, 300, "session.title"),
    gitBranch: optStr(s.gitBranch, 200, "session.gitBranch"),
    model: optStr(s.model, 100, "session.model"),
    agentVersion: optStr(s.agentVersion, 40, "session.agentVersion"),
    startedAt: iso(s.startedAt, "session.startedAt"),
    endedAt: iso(s.endedAt, "session.endedAt"),
    outcome: oneOf(s.outcome, OUTCOMES, "session.outcome"),
    stepCount: num(s.stepCount, "session.stepCount"),
    toolCalls: num(s.toolCalls, "session.toolCalls"),
    toolErrors: num(s.toolErrors, "session.toolErrors"),
    inputTokens: num(s.inputTokens, "session.inputTokens"),
    outputTokens: num(s.outputTokens, "session.outputTokens"),
    // Older clients do not send these.
    activeMs: s.activeMs == null ? 0 : num(s.activeMs, "session.activeMs"),
    costUsd: s.costUsd == null ? 0 : Math.max(0, Number(s.costUsd) || 0),
    brief: s.brief === "given" || s.brief === "empty" || s.brief === "failed" ? s.brief : null,
  };
  const steps: Step[] = b.steps.map((x: any, i: number) => ({
    seq: num(x?.seq, `steps[${i}].seq`),
    kind: oneOf(x?.kind, KINDS, `steps[${i}].kind`),
    name: str(x?.name, 200, `steps[${i}].name`),
    input: str(x?.input ?? "", 4000, `steps[${i}].input`),
    output: str(x?.output ?? "", 8000, `steps[${i}].output`),
    isError: x?.isError === true,
    at: iso(x?.at, `steps[${i}].at`),
    durationMs: x?.durationMs == null ? null : num(x.durationMs, `steps[${i}].durationMs`),
    sidechain: x?.sidechain === true,
  }));
  const memory: MemoryEvent[] = b.memory.slice(0, 2000).map((x: any, i: number) => ({
    seq: num(x?.seq, `memory[${i}].seq`),
    source: oneOf(x?.source, SOURCES, `memory[${i}].source`),
    op: oneOf(x?.op, OPS, `memory[${i}].op`),
    ref: str(x?.ref, 500, `memory[${i}].ref`),
    preview: str(x?.preview ?? "", 1000, `memory[${i}].preview`),
    at: iso(x?.at, `memory[${i}].at`),
  }));
  const findings: Finding[] = b.findings.slice(0, 500).map((x: any, i: number) => ({
    key: str(x?.key, 300, `findings[${i}].key`),
    kind: oneOf(x?.kind, ISSUE_KINDS, `findings[${i}].kind`),
    title: str(x?.title, 300, `findings[${i}].title`),
    seq: num(x?.seq, `findings[${i}].seq`),
  }));
  return { session, steps, memory, findings };
}
