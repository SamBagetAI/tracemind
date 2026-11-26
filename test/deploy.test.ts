/**
 * The Vercel deployment: every path the server answers reaches the function, and the function
 * answers every method those paths use. Checked from the files, since the function itself needs a
 * Postgres database to load.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SECURITY_HEADERS } from "../src/server/app.ts";

const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as {
  rewrites: { source: string; destination: string }[];
  headers?: { source: string; headers: { key: string; value: string }[] }[];
};
const entry = readFileSync("api/index.ts", "utf8");

/** Where Vercel sends a path: the first rewrite whose source matches it. */
function routeOf(path: string): string | undefined {
  return vercel.rewrites.find((r) => new RegExp(`^${r.source.replace(/\(\.\*\)/g, ".*")}$`).test(path))?.destination;
}

describe("Vercel deployment", () => {
  it("sends the API, the health check and MCP to the function, and pages to the web app", () => {
    expect(routeOf("/api/overview")).toBe("/api");
    expect(routeOf("/healthz")).toBe("/api");
    expect(routeOf("/mcp")).toBe("/api");
    expect(routeOf("/sessions/abc")).toBe("/index.html");
  });

  it("sends pages the same security headers the app sends with everything it answers", () => {
    // On Vercel the pages are static files: they never reach the app, so vercel.json sends them.
    const everywhere = vercel.headers?.find((h) => h.source === "/(.*)");
    expect(Object.fromEntries((everywhere?.headers ?? []).map((h) => [h.key.toLowerCase(), h.value]))).toEqual(SECURITY_HEADERS);
  });

  it("answers every method MCP over HTTP uses", () => {
    for (const method of ["GET", "POST", "DELETE", "OPTIONS"]) expect(entry).toMatch(new RegExp(`export const ${method} = handle\\(app\\)`));
  });

  it("is linked from the README with the variables the server needs", () => {
    const readme = readFileSync("README.md", "utf8");
    const link = /\(https:\/\/vercel\.com\/new\/clone\?([^)]+)\)/.exec(readme)?.[1];
    expect(link).toBeTruthy();
    const q = new URLSearchParams(link!);
    expect(q.get("repository-url")).toBe("https://github.com/SamBagetAI/tracemind");
    expect(q.get("env")?.split(",")).toEqual(["DATABASE_URL", "TRACEMIND_SETUP_SECRET"]);
  });
});
