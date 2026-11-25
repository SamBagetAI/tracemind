/**
 * Formatting shared by every page: one date style, one number style, one mark for zero, the
 * thresholds that decide colour, and short paths. Issue wording and grouping come from
 * src/core/describe.ts, which the server uses too.
 */
export { CAUSE, KIND, UNNAMED, causeKey, describeIssue, projectName, toolLabel, topTools, variantsByMessage } from "../../../src/core/describe";
export { DAY, daysAgo } from "../../../src/core/time";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "just now", "5m ago", "3h ago", "2d ago", then "18 Oct" (with the year when it is not this year). */
export function when(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return ZERO;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return ZERO;
  const s = (now - t) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return dayLabel(new Date(t).toISOString().slice(0, 10), now);
}

export function fullDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "18 Oct", or "18 Oct 2025" for another year. */
export function dayLabel(day: string, now = Date.now()): string {
  const d = new Date(`${day}T12:00:00`);
  const year = d.getFullYear() !== new Date(now).getFullYear() ? ` ${d.getFullYear()}` : "";
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
}

/** The one mark for "nothing" everywhere: zero, never, no value. */
export const ZERO = "—";

/** Whole numbers with thousands separators; zero is ZERO. */
export function num(n: number | null | undefined): string {
  if (!n) return ZERO;
  return n.toLocaleString("en-US");
}

export function duration(ms: number | null | undefined): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Elapsed time as +m:ss. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s >= 3600) return `+${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
  return `${(n / 1e9).toFixed(1)}B`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/**
 * How loud a count should be. Red is kept for what deserves attention, so it keeps its meaning:
 * - sessions an issue hit: red from 5, plain below
 * - a failure rate: red from 10%, plain below
 */
export type Level = "high" | "low" | "none";
export const sessionsLevel = (n: number): Level => (n >= 5 ? "high" : n >= 2 ? "low" : "none");
export const rateLevel = (r: number): Level => (r >= 0.1 ? "high" : r > 0 ? "low" : "none");
/** Red only past the threshold; below it a number is plain. There is no in-between colour. */
export const LEVEL_CLASS: Record<Level, string> = { high: "text-fail", low: "text-foreground", none: "text-muted-foreground" };

/**
 * `/Users/me/.claude/projects/-Users-me-harness-hub/memory/MEMORY.md` → `~/…/harness-hub/memory/MEMORY.md`.
 * Claude Code names a project's memory folder after its path with dashes; the project is what
 * tells two MEMORY.md files apart, so it is kept.
 */
export function shortPath(path: string): string {
  let p = path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
  p = p.replace(/\/\.claude\/projects\/-(?:Users|home)-[^-/]+-([^/]+)\//, "/…/$1/");
  const parts = p.split("/");
  if (parts.length > 5) return [parts[0], "…", ...parts.slice(-3)].join("/");
  return p;
}

/** File name and the folder it is in, for two-line display. */
export function splitPath(path: string): { name: string; folder: string } {
  const short = shortPath(path);
  const i = short.lastIndexOf("/");
  return i < 0 ? { name: short, folder: "" } : { name: short.slice(i + 1), folder: short.slice(0, i) };
}

/** Markdown shown as plain text: links keep their words, list marks and emphasis go. */
export function plainText(md: string): string {
  return md
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^#+\s*/gm, "")
    .replace(/[*_`]{1,2}([^*_`]+)[*_`]{1,2}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}


/** How a memory or instruction ref reads: a file as its name and folder, a skill or tool as its name. */
export function memoryLabel(m: { source: string; ref: string }): { name: string; folder: string } {
  return m.source === "instructions" || m.source === "file" ? splitPath(m.ref) : { name: m.ref, folder: "" };
}

/** A failure rate as a person reads it: one decimal under 10%, whole numbers above. */
export const percent = (rate: number) => `${(rate * 100).toFixed(rate < 0.1 ? 1 : 0)}%`;
