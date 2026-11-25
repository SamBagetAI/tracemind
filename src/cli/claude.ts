/** Everything that knows where Claude Code keeps its files. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DAY } from "../core/time.ts";

export const claudeHome = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const projectsDir = () => join(claudeHome(), "projects");

/** The transcript of a session and those of the subagents it started. */
export function readSessionFiles(transcriptPath: string): { lines: string; subagents: string[] } {
  const lines = readFileSync(transcriptPath, "utf8");
  const subDir = join(dirname(transcriptPath), basename(transcriptPath, ".jsonl"), "subagents");
  const subagents: string[] = [];
  if (existsSync(subDir)) {
    for (const f of readdirSync(subDir)) {
      if (f.endsWith(".jsonl")) subagents.push(readFileSync(join(subDir, f), "utf8"));
    }
  }
  return { lines, subagents };
}

/** Every session transcript changed in the last `days` days, oldest first. */
export function listTranscripts(days: number): { id: string; path: string; mtime: number }[] {
  const root = projectsDir();
  if (!existsSync(root)) return [];
  const since = Date.now() - days * DAY;
  const out: { id: string; path: string; mtime: number }[] = [];
  for (const proj of readdirSync(root)) {
    const dir = join(root, proj);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      const path = join(dir, f);
      const mtime = statSync(path).mtimeMs;
      if (mtime >= since) out.push({ id: basename(f, ".jsonl"), path, mtime });
    }
  }
  return out.sort((a, b) => a.mtime - b.mtime);
}

const MARK = "tracemind";
const EVENTS = ["Stop", "SessionEnd"] as const;

type HookEntry = { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] };

function settingsFile(scope: "user" | "project", cwd: string): string {
  return scope === "user" ? join(claudeHome(), "settings.json") : join(cwd, ".claude", "settings.json");
}

/** Adds (or replaces) Tracemind's hooks in Claude Code settings. Returns the file it changed. */
export function installHooks(command: string, scope: "user" | "project", cwd: string): string {
  const file = settingsFile(scope, cwd);
  let settings: Record<string, any> = {};
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8");
    settings = text.trim() ? JSON.parse(text) : {};
    copyFileSync(file, `${file}.tracemind-backup`);
  } else {
    mkdirSync(dirname(file), { recursive: true });
  }
  settings.hooks ??= {};
  for (const event of EVENTS) {
    const list: HookEntry[] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const kept = list
      .map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !String(h.command ?? "").includes(MARK)) }))
      .filter((e) => e.hooks.length > 0);
    kept.push({ hooks: [{ type: "command", command, timeout: 30 }] });
    settings.hooks[event] = kept;
  }
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  return file;
}

export function removeHooks(scope: "user" | "project", cwd: string): string | null {
  const file = settingsFile(scope, cwd);
  if (!existsSync(file)) return null;
  const settings = JSON.parse(readFileSync(file, "utf8") || "{}");
  if (!settings.hooks) return null;
  for (const event of EVENTS) {
    const list: HookEntry[] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const kept = list
      .map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !String(h.command ?? "").includes(MARK)) }))
      .filter((e) => e.hooks.length > 0);
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  return file;
}

export function hooksInstalled(cwd: string): ("user" | "project")[] {
  const found: ("user" | "project")[] = [];
  for (const scope of ["user", "project"] as const) {
    const file = settingsFile(scope, cwd);
    if (existsSync(file) && readFileSync(file, "utf8").includes(MARK)) found.push(scope);
  }
  return found;
}

/**
 * Adds one hook command to one event in the user's Claude Code settings, or takes it out.
 * `marker` is a piece of the command that identifies it (e.g. "tracemind context"); other hooks
 * are left as they are. A backup of the settings is kept next to them.
 */
export function setHook(event: string, command: string, marker: string, present: boolean, timeout = 10): string {
  const file = settingsFile("user", process.cwd());
  let settings: Record<string, any> = {};
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8");
    settings = text.trim() ? JSON.parse(text) : {};
    copyFileSync(file, `${file}.tracemind-backup`);
  } else {
    mkdirSync(dirname(file), { recursive: true });
  }
  settings.hooks ??= {};
  const list: HookEntry[] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  const kept = list
    .map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !String(h.command ?? "").includes(marker)) }))
    .filter((e) => e.hooks.length > 0);
  if (present) kept.push({ hooks: [{ type: "command", command, timeout }] });
  if (kept.length) settings.hooks[event] = kept;
  else delete settings.hooks[event];
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  return file;
}

export function hasHook(event: string, marker: string): boolean {
  const file = settingsFile("user", process.cwd());
  if (!existsSync(file)) return false;
  try {
    const list: HookEntry[] = JSON.parse(readFileSync(file, "utf8")).hooks?.[event] ?? [];
    return list.some((e) => (e.hooks ?? []).some((h) => String(h.command ?? "").includes(marker)));
  } catch {
    return false;
  }
}
