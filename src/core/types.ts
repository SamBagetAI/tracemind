/** What Tracemind keeps of one agent session. Every text field is redacted before it is stored. */

export type Outcome = "ok" | "error" | "interrupted" | "running";

export type Session = {
  id: string;
  /** Which agent ran it. Only "claude-code" for now. */
  agent: string;
  /** The person who ran it: git user.name locally, the token's owner on a server. */
  person: string;
  /** The folder the agent worked in. */
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
};

export type StepKind = "prompt" | "reply" | "tool" | "subagent" | "compact" | "interrupt";

export type Step = {
  seq: number;
  kind: StepKind;
  /** Tool name for tools, otherwise a short label. */
  name: string;
  input: string;
  output: string;
  isError: boolean;
  at: string;
  durationMs: number | null;
  /** True for steps a subagent took inside the session. */
  sidechain: boolean;
};

/** Where a piece of memory came from. */
export type MemorySource =
  | "instructions" // CLAUDE.md, AGENTS.md and auto-memory, loaded at the start of a turn
  | "file" // a memory-like file the agent read or wrote with a tool
  | "skill" // a skill the agent loaded
  | "mcp"; // an MCP tool that reads or writes memory

export type MemoryEvent = {
  seq: number;
  source: MemorySource;
  op: "read" | "write";
  /** Path for files, skill or tool name otherwise. */
  ref: string;
  preview: string;
  at: string;
};

export type IssueKind =
  | "tool_error"
  | "permission_denied"
  | "step_repetition"
  | "interrupted";

/** One failure seen in one session. Sessions with the same key are grouped into one issue. */
export type Finding = {
  key: string;
  kind: IssueKind;
  title: string;
  seq: number;
};

export type Trace = {
  session: Session;
  steps: Step[];
  memory: MemoryEvent[];
  findings: Finding[];
};
