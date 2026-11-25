/** Applying a fix and undoing it: a marked line in an instruction file, or a tagged hook. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { setHook } from "../cli/claude.ts";
import type { Store } from "../store/store.ts";
import { CONTEXT_MARKER, copyOf, tagged, type Suggestion } from "./suggestions.ts";

const marker = (id: string) => `<!-- tracemind:${id} -->`;
const block = (id: string, text: string) => `\n${marker(id)}\n- ${text}\n`;

export type Preview = { file: string; exists: boolean; adds: string; tail: string } | { hook: string; event: string } | { prompt: string };

export function preview(s: Suggestion, command: string): Preview {
  if (s.action.type === "rule") {
    const exists = existsSync(s.action.file);
    const text = exists ? readFileSync(s.action.file, "utf8") : "";
    return { file: s.action.file, exists, adds: block(s.id, s.action.text).trimStart(), tail: text.split("\n").slice(-6).join("\n") };
  }
  if (s.action.type === "routine") return { event: s.action.event, hook: tagged(command) };
  if (s.action.type === "prompt") return { prompt: s.action.text };
  return { prompt: "" };
}

function backupDir(): string {
  const dir = join(process.env.TRACEMIND_HOME ?? join(homedir(), ".tracemind"), "backups");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function apply(store: Store, ws: string, s: Suggestion, command: string): Promise<string> {
  if (!s.fixable) throw new Error("This suggestion is not something Tracemind can apply; copy it to Claude instead.");
  if (s.action.type === "rule") {
    const file = s.action.file;
    const before = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (before?.includes(marker(s.id))) return file; // already there
    if (before != null) copyFileSync(file, join(backupDir(), `${basename(file)}.${s.id}.${Date.now()}.bak`));
    const add = block(s.id, s.action.text);
    writeFileSync(file, (before ?? "").replace(/\n*$/, "\n") + add);
    await setState(store, ws, s.id, "applied", { file, added: add, fix: copyOf(s) });
    return file;
  }
  if (s.action.type === "routine") {
    const file = setHook("SessionStart", tagged(command), CONTEXT_MARKER, true);
    await setState(store, ws, s.id, "applied", { file, fix: copyOf(s) });
    return file;
  }
  throw new Error(`Unknown fix type: ${s.action.type}`);
}

export async function undo(store: Store, ws: string, s: Suggestion): Promise<void> {
  if (s.action.type === "rule") {
    const file = s.action.file;
    if (existsSync(file)) {
      const text = readFileSync(file, "utf8");
      const add = block(s.id, s.action.text);
      // Takes out exactly what was added, and only that.
      const next = text.includes(add) ? text.replace(add, "\n") : text.replace(new RegExp(`\\n?${marker(s.id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n- [^\\n]*\\n?`), "\n");
      writeFileSync(file, next.replace(/\n{3,}$/, "\n"));
    }
  }
  if (s.action.type === "routine") setHook("SessionStart", "", CONTEXT_MARKER, false);
  await setState(store, ws, s.id, "open", {});
}

export async function setState(store: Store, ws: string, id: string, status: Suggestion["status"], detail: object) {
  await store.db.run("DELETE FROM suggestions WHERE workspace = ? AND id = ?", [ws, id]);
  await store.db.run("INSERT INTO suggestions (workspace, id, status, at, detail) VALUES (?, ?, ?, ?, ?)", [ws, id, status, new Date().toISOString(), JSON.stringify(detail)]);
}
