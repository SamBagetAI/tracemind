/**
 * Turns a Claude Code session transcript (the JSONL file in ~/.claude/projects) into a Trace.
 * The format is not a public contract: unknown lines are skipped, never fatal.
 */
import { createHash } from "node:crypto";
import { clip, redact } from "./redact.ts";
import { findIssues } from "./issues.ts";
import type { MemoryEvent, Outcome, Session, Step, Trace } from "./types.ts";

const INPUT_MAX = 2000;
const OUTPUT_MAX = 4000;
const PREVIEW_MAX = 400;
/** Longer than this between a tool call and its result means the session was paused, not that the tool ran. */
const MAX_TOOL_MS = 2 * 60 * 60 * 1000;
/** Tools whose time is a person answering, not the tool running. */
const WAITS_FOR_PERSON = /(?:^|\/)(?:AskUserQuestion|ExitPlanMode|request_permission|ask_user)/i;

/** Files whose content is memory or instructions for the agent. */
const MEMORY_FILE =
  /(?:^|\/)(?:CLAUDE|AGENTS|GEMINI|MEMORY)\.md$|\/memory\/[^/]+$|\/\.claude\/(?:skills|agents|commands)\/|\/\.cursor\/rules\/|\.mdc$/i;

/** MCP tools that read or write some kind of memory. */
const MEMORY_TOOL = /memory|recall|remember|knowledge|get_piece|notes?_/i;
const WRITE_VERB = /append|save|write|set|update|create|remember|store|add/i;

const FILE_READ_TOOLS = new Set(["Read"]);
const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

type Line = Record<string, any>;

export type ParseOptions = {
  person: string;
  /** Lines of each subagent transcript of this session, if any. */
  subagents?: (string | string[])[];
  /** True while the session is still open (the hook ran at the end of a turn, not of the session). */
  running?: boolean;
};

function parseLines(text: string | string[]): Line[] {
  const raw = Array.isArray(text) ? text : text.split("\n");
  const out: Line[] = [];
  for (const l of raw) {
    if (!l.trim()) continue;
    try {
      const v = JSON.parse(l);
      if (v && typeof v === "object") out.push(v);
    } catch {
      // A half-written last line while the session is still running.
    }
  }
  return out;
}

function stripReminders(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "")
    .replace(/<local-command-std(?:out|err)>[\s\S]*?<\/local-command-std(?:out|err)>/g, "")
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, "")
    .replace(/<command-name>([\s\S]*?)<\/command-name>/g, "$1 ")
    .replace(/<command-args>([\s\S]*?)<\/command-args>/g, "$1")
    .trim();
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: any) => {
      if (b?.type === "text") return b.text ?? "";
      if (b?.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** One line that says what a tool was asked to do. */
export function describeInput(name: string, input: any): string {
  if (!input || typeof input !== "object") return String(input ?? "");
  if (typeof input.command === "string") return input.command;
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.pattern === "string") return input.pattern + (input.path ? `  in ${input.path}` : "");
  if (typeof input.url === "string") return input.url;
  if (typeof input.query === "string") return input.query;
  if (SUBAGENT_TOOLS.has(name) && typeof input.description === "string") {
    return `${input.description}${input.subagent_type ? ` (${input.subagent_type})` : ""}`;
  }
  if (name === "Skill" && typeof input.skill === "string") return input.skill;
  // Anything else: its first readable text (e.g. a plan's first item), not raw JSON.
  const text = firstText(input);
  if (text) return text;
  try {
    return JSON.stringify(input);
  } catch {
    return "";
  }
}

/** The first string of three or more characters in a value, depth first. */
function firstText(v: unknown, depth = 0): string | null {
  if (depth > 4 || v == null) return null;
  if (typeof v === "string") return v.trim().length >= 3 ? v.trim() : null;
  if (Array.isArray(v)) {
    for (const x of v) {
      const t = firstText(x, depth + 1);
      if (t) return t;
    }
    return null;
  }
  if (typeof v === "object") {
    for (const x of Object.values(v as Record<string, unknown>)) {
      const t = firstText(x, depth + 1);
      if (t) return t;
    }
  }
  return null;
}

/** `mcp__server__tool` becomes `server/tool`; servers named by a UUID keep only the tool. */
export function shortToolName(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m) return name;
  const server = m[1];
  if (/^[0-9a-f-]{20,}$/i.test(server)) return m[2];
  return `${server}/${m[2]}`;
}

function ms(a: string, b: string): number | null {
  const d = Date.parse(b) - Date.parse(a);
  return Number.isFinite(d) && d >= 0 ? d : null;
}

type Draft = Step & { toolId?: string; fingerprint?: string };

function fingerprintOf(input: unknown): string {
  try {
    return createHash("sha1").update(JSON.stringify(input) ?? "").digest("hex");
  } catch {
    return "";
  }
}

function collect(lines: Line[], sidechainFile: boolean, memory: MemoryEvent[], steps: Draft[], meta: Meta) {
  const pending = new Map<string, Draft>();
  for (const line of lines) {
    const at: string = line.timestamp ?? meta.lastAt ?? new Date(0).toISOString();
    if (line.timestamp) {
      if (!meta.firstAt || line.timestamp < meta.firstAt) meta.firstAt = line.timestamp;
      if (!meta.lastAt || line.timestamp > meta.lastAt) meta.lastAt = line.timestamp;
    }
    const sidechain = sidechainFile || line.isSidechain === true;
    if (!sidechainFile) {
      if (line.cwd && !meta.project) meta.project = line.cwd;
      if (line.gitBranch) meta.gitBranch = line.gitBranch;
      if (line.version) meta.version = line.version;
    }

    switch (line.type) {
      case "custom-title":
        if (!sidechainFile && line.customTitle) meta.title = line.customTitle;
        break;

      case "summary":
        if (!sidechainFile && line.summary && !meta.title) meta.summary = line.summary;
        break;

      case "system":
        if (line.subtype === "compact_boundary") {
          steps.push(draft("compact", "Context compacted", "", "", at, sidechain));
        }
        break;

      case "attachment": {
        const a = line.attachment ?? {};
        if (a.type === "instructions" && Array.isArray(a.files)) {
          for (const f of a.files) {
            if (!f?.path) continue;
            const content = String(f.content ?? "");
            const sig = `${f.path}:${content.length}:${content.slice(0, 200)}`;
            if (meta.loaded.get(f.path) === sig) continue;
            meta.loaded.set(f.path, sig);
            memory.push({
              seq: 0,
              source: "instructions",
              op: "read",
              ref: f.path,
              preview: clip(content, PREVIEW_MAX),
              at,
            });
          }
        }
        break;
      }

      case "user": {
        const content = line.message?.content;
        if (Array.isArray(content) && content.some((b: any) => b?.type === "tool_result")) {
          for (const b of content) {
            if (b?.type !== "tool_result") continue;
            const step = pending.get(b.tool_use_id);
            if (!step) continue;
            pending.delete(b.tool_use_id);
            step.output = clip(textOf(b.content), OUTPUT_MAX);
            step.isError = b.is_error === true;
            // How long the tool ran, when that is known. Not when a person was in the loop: a call a
            // person had to approve (Claude Code records who approved it), or a tool that waits for a
            // person by design. And not hours later: that is a session resumed after a pause.
            const d = ms(step.at, at);
            const approval = line.permissionDecision;
            const personWaited = (approval && typeof approval === "object" && approval.source && approval.source !== "config") || WAITS_FOR_PERSON.test(step.name);
            step.durationMs = d != null && d <= MAX_TOOL_MS && !personWaited ? d : null;
          }
          break;
        }
        if (line.isMeta || line.isCompactSummary) break;
        const text = stripReminders(textOf(content));
        if (!text) break;
        if (/^\[Request interrupted by user/.test(text)) {
          steps.push(draft("interrupt", "Interrupted by the user", "", "", at, sidechain));
          break;
        }
        steps.push(draft("prompt", sidechain ? "Subagent task" : "Prompt", clip(text, INPUT_MAX), "", at, sidechain));
        if (!sidechain && !meta.firstPrompt) meta.firstPrompt = text;
        break;
      }

      case "assistant": {
        const m = line.message ?? {};
        if (m.model && m.model !== "<synthetic>" && !sidechainFile) meta.model = m.model;
        if (m.id && m.usage && !meta.usageSeen.has(m.id)) {
          meta.usageSeen.add(m.id);
          const u = m.usage;
          meta.inputTokens +=
            (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
          meta.outputTokens += u.output_tokens ?? 0;
        }
        if (!Array.isArray(m.content)) break;
        for (const b of m.content) {
          if (b?.type === "text" && b.text?.trim()) {
            steps.push(draft("reply", "Reply", "", clip(b.text, OUTPUT_MAX), at, sidechain));
          } else if (b?.type === "tool_use") {
            const name: string = b.name ?? "tool";
            const kind = SUBAGENT_TOOLS.has(name) ? "subagent" : "tool";
            const step = draft(kind, shortToolName(name), clip(describeInput(name, b.input), INPUT_MAX), "", at, sidechain);
            step.toolId = b.id;
            step.fingerprint = fingerprintOf(b.input);
            steps.push(step);
            if (b.id) pending.set(b.id, step);
            const mem = memoryOfTool(name, b.input, at);
            if (mem) memory.push(mem);
          }
        }
        break;
      }
    }
  }
}

function draft(kind: Step["kind"], name: string, input: string, output: string, at: string, sidechain: boolean): Draft {
  return { seq: 0, kind, name, input, output, isError: false, at, durationMs: null, sidechain };
}

function memoryOfTool(name: string, input: any, at: string): MemoryEvent | null {
  const path: unknown = input?.file_path ?? input?.notebook_path;
  if (typeof path === "string" && MEMORY_FILE.test(path)) {
    if (FILE_READ_TOOLS.has(name)) return { seq: 0, source: "file", op: "read", ref: path, preview: "", at };
    if (FILE_WRITE_TOOLS.has(name)) {
      const body = input?.content ?? input?.new_string ?? input?.new_source ?? "";
      return { seq: 0, source: "file", op: "write", ref: path, preview: clip(String(body), PREVIEW_MAX), at };
    }
  }
  if (name === "Skill" && typeof input?.skill === "string") {
    return { seq: 0, source: "skill", op: "read", ref: input.skill, preview: clip(String(input.args ?? ""), PREVIEW_MAX), at };
  }
  if (name.startsWith("mcp__") && MEMORY_TOOL.test(name)) {
    const tool = shortToolName(name);
    const op = WRITE_VERB.test(tool.split("/").pop() ?? "") ? "write" : "read";
    return { seq: 0, source: "mcp", op, ref: tool, preview: clip(describeInput(name, input), PREVIEW_MAX), at };
  }
  return null;
}

type Meta = {
  project?: string;
  gitBranch?: string;
  version?: string;
  model?: string;
  title?: string;
  summary?: string;
  firstPrompt?: string;
  firstAt?: string;
  lastAt?: string;
  inputTokens: number;
  outputTokens: number;
  usageSeen: Set<string>;
  loaded: Map<string, string>;
};

function outcomeOf(steps: Step[], running: boolean): Outcome {
  const main = steps.filter((s) => !s.sidechain);
  const last = main[main.length - 1];
  if (last?.kind === "interrupt") return "interrupted";
  if (running) return "running";
  const lastTool = [...main].reverse().find((s) => s.kind === "tool" || s.kind === "subagent");
  const lastIndex = lastTool ? main.lastIndexOf(lastTool) : -1;
  const repliedAfter = main.slice(lastIndex + 1).some((s) => s.kind === "reply");
  if (lastTool?.isError && !repliedAfter) return "error";
  return "ok";
}

export function parseClaudeSession(sessionId: string, transcript: string | string[], opts: ParseOptions): Trace {
  const meta: Meta = { inputTokens: 0, outputTokens: 0, usageSeen: new Set(), loaded: new Map() };
  const steps: Draft[] = [];
  const memory: MemoryEvent[] = [];

  collect(parseLines(transcript), false, memory, steps, meta);
  for (const sub of opts.subagents ?? []) collect(parseLines(sub), true, memory, steps, meta);

  // Main and subagent steps share one timeline; a stable sort keeps the order within a file.
  const fingerprints = new Map<number, string>();
  const ordered = steps
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.at === b.s.at ? a.i - b.i : a.s.at < b.s.at ? -1 : 1))
    .map(({ s }, i) => {
      const { toolId: _, fingerprint, ...step } = s;
      if (fingerprint) fingerprints.set(i + 1, fingerprint);
      return { ...step, seq: i + 1 };
    });

  // Each memory event points at the step it happened next to.
  const sortedMemory = memory
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .map((m) => {
      let seq = 0;
      for (const s of ordered) {
        if (s.at <= m.at) seq = s.seq;
        else break;
      }
      return { ...m, seq };
    });

  const tools = ordered.filter((s) => s.kind === "tool" || s.kind === "subagent");
  const titleSource = meta.title ?? meta.summary ?? meta.firstPrompt ?? "Untitled session";
  const firstLine = titleSource.split("\n").find((l) => l.trim()) ?? titleSource;

  const session: Session = {
    id: sessionId,
    agent: "claude-code",
    person: opts.person,
    project: meta.project ?? "",
    title: clip(firstLine.trim(), 120),
    gitBranch: meta.gitBranch ?? null,
    model: meta.model ?? null,
    agentVersion: meta.version ?? null,
    startedAt: meta.firstAt ?? new Date(0).toISOString(),
    endedAt: meta.lastAt ?? meta.firstAt ?? new Date(0).toISOString(),
    outcome: outcomeOf(ordered, opts.running === true),
    stepCount: ordered.length,
    toolCalls: tools.length,
    toolErrors: tools.filter((s) => s.isError).length,
    inputTokens: meta.inputTokens,
    outputTokens: meta.outputTokens,
  };

  return { session: { ...session, project: redact(session.project) }, steps: ordered, memory: sortedMemory, findings: findIssues(ordered, fingerprints) };
}
