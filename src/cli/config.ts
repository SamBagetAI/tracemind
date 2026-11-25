import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

export type Config = {
  person: string;
  server?: { url: string; token: string; workspace: string; person: string };
  /** Push each session to the server when the hook saves it. On by default once a server is linked. */
  autoPush?: boolean;
};

export function home(): string {
  return process.env.TRACEMIND_HOME ?? join(homedir(), ".tracemind");
}

export const dbPath = () => join(home(), "tracemind.db");
export const logPath = () => join(home(), "hook.log");
export const configPath = () => join(home(), "config.json");

function defaultPerson(): string {
  try {
    const name = execFileSync("git", ["config", "--global", "user.name"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (name) return name;
  } catch {
    // No git, or no name set.
  }
  return userInfo().username;
}

export function loadConfig(): Config {
  try {
    const c = JSON.parse(readFileSync(configPath(), "utf8"));
    if (c && typeof c.person === "string") return c;
  } catch {
    // First run.
  }
  return { person: defaultPerson() };
}

export function saveConfig(c: Config) {
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  chmodSync(configPath(), 0o600);
}

export function ensureHome() {
  if (!existsSync(home())) mkdirSync(home(), { recursive: true, mode: 0o700 });
}
