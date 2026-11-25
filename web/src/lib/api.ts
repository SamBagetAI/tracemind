/** Types the API returns and a small hook to load them. */
import { useCallback, useEffect, useState } from "react";

export type Outcome = "ok" | "error" | "interrupted" | "running";
export type IssueKind = "tool_error" | "permission_denied" | "step_repetition" | "interrupted";

export type Session = {
  id: string;
  agent: string;
  person: string;
  project: string;
  title: string;
  gitBranch: string | null;
  model: string | null;
  agentVersion: string | null;
  startedAt: string;
  endedAt: string;
  outcome: Outcome;
  stepCount: number;
  toolCalls: number;
  toolErrors: number;
  inputTokens: number;
  outputTokens: number;
  issueCount: number;
  /** Time spent working (gaps between steps, each up to 15 minutes). */
  activeMs: number;
  /** What it would cost at Claude API list prices, in US dollars. */
  costUsd: number;
  /** Where the session failed, 0–1 along it (only when asked for with marks=1). */
  marks?: { at: number; kind: "error" | "interrupt" }[];
  /** The issues it hit, one per cause, in the order it first hit them (only with issues=1). */
  issues?: SessionIssue[];
};

export type SessionIssue = { what: string; seq: number; key: string; named?: boolean };

export type Step = {
  seq: number;
  kind: "prompt" | "reply" | "tool" | "subagent" | "compact" | "interrupt";
  name: string;
  input: string;
  output: string;
  isError: boolean;
  at: string;
  durationMs: number | null;
  sidechain: boolean;
};

export type MemoryEvent = { seq: number; source: "instructions" | "file" | "skill" | "mcp"; op: "read" | "write"; ref: string; preview: string; at: string };
export type Finding = { key: string; kind: IssueKind; title: string; seq: number };
/** An issue a session hit, with its cause's session count (all variants) over the window. */
export type IssueRef = { status: "open" | "resolved"; num: number; sessions: number; cause?: string; what?: string; fix?: "ready" | "applied" | null; fixAt?: string | null };

export type Trace = {
  session: Session;
  steps: Step[];
  memory: MemoryEvent[];
  findings: Finding[];
  issues: Record<string, IssueRef>;
  /** The window the issue counts cover, or null for all time (the session is older than the window). */
  issueWindow?: number | null;
};

export type Issue = {
  key: string;
  kind: IssueKind;
  title: string;
  status: "open" | "resolved";
  firstSeen: string;
  lastSeen: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  note: string | null;
  reopened: boolean;
  sessions: number;
  num: number;
};

export type IssueGroup = {
  id: string;
  kind: IssueKind;
  kindLabel: string;
  what: string;
  plain: boolean;
  raw: string;
  tools: string;
  sessions: number;
  daily: number[];
  firstSeen: string;
  lastSeen: string;
  status: "open" | "resolved";
  reopened: boolean;
  issues: (Issue & { windowSessions: number; tool: string })[];
  /** Whether a suggested change exists for this cause, and whether it was applied. */
  fix?: "ready" | "applied" | null;
  /** When the fix was applied, if it was. */
  fixAt?: string | null;
  /** Sessions in the period of the same length just before the window. */
  previous?: number;
};

export type CauseDetail = {
  cause: IssueGroup;
  allTimeSessions: number;
  history: { day: string; sessions: number }[];
  example: string | null;
  exampleStep: { name: string; input: string } | null;
  messages: Record<string, string>;
  sessions: { id: string; title: string; project: string; person: string; startedAt: string; endedAt: string; seq: number }[];
  suggestion: Suggestion | null;
};

export type Overview = {
  since: string;
  sessions: number;
  withIssues: number;
  toolCalls: number;
  toolErrors: number;
  inputTokens: number;
  outputTokens: number;
  activeMs: number;
  costUsd: number;
  openIssues: number;
  /** The period of the same length just before the window. */
  previous: { sessions: number; withIssues: number; activeMs: number; toolErrors: number; outputTokens: number; costUsd: number };
  strip: { id: string; title: string; startedAt: string; issues: number }[];
};

export type IssueDetail = {
  issue: Issue;
  /** Sessions that hit it in the chosen window. */
  windowSessions: number;
  sessions: (Session & { findingSeq: number })[];
  history: { day: string; sessions: number }[];
  /** The full error from the latest session that hit it. */
  example: string | null;
};

export type Suggestion = {
  id: string;
  kind: "rule" | "routine" | "connect" | "trim" | "investigate" | "tip";
  title: string;
  why: string;
  sessions: number;
  examples: { id: string; title: string; seq: number | null }[];
  causes: string[];
  issue: { key: string; num: number; what: string; sessions: number } | null;
  action:
    | { type: "rule"; file: string; scope: "global" | "project"; text: string }
    | { type: "routine"; event: string; command: string }
    | { type: "prompt"; text: string }
    | { type: "tip" };
  status: "open" | "applied" | "dismissed";
  at: string | null;
  effect: { before: { sessions: number; hit: number }; since: { sessions: number; hit: number } } | null;
  /** "issue" when the numbers are for one issue only (on that issue's page). */
  effectScope?: "issue";
};

export type Preview =
  | { file: string; exists: boolean; adds: string; tail: string }
  | { hook: string; event: string; sample?: string }
  | { prompt: string };

export type Tool = { name: string; calls: number; errors: number; typicalMs: number | null; slowMs: number | null; timed: number; sessions: number };
export type MemoryRow = { ref: string; source: string; reads: number; writes: number; sessions: number; lastAt: string; lastWrite: string | null };
export type Viewer = { workspace: string; person: string; role: "admin" | "member"; mode: "local" | "server" };

export class Unauthorized extends Error {}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, { credentials: "same-origin", ...init, headers: { "content-type": "application/json", ...init?.headers } });
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `${res.status}`);
  return res.json();
}

export type Loaded<T> = { data: T | null; error: string | null; loading: boolean; reload: () => void };

/** Loads `path` and reloads when it changes. A 401 sends the person to the sign-in page. */
export function useApi<T>(path: string | null): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    api<T>(path)
      .then((data) => live && setState({ data, error: null, loading: false }))
      .catch((e) => {
        if (e instanceof Unauthorized) {
          window.location.assign("/login");
          return;
        }
        if (live) setState({ data: null, error: (e as Error).message, loading: false });
      });
    return () => {
      live = false;
    };
  }, [path, tick]);
  return { ...state, reload };
}
