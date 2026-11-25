/** How the MCP tools reach Tracemind's API: an in-process request to the same Hono app the web UI uses. */
import type { Hono } from "hono";
import type { ApiCall } from "./server.ts";

/**
 * A caller for `app`. `headers` carries the caller's token on a shared server. Writes are sent the
 * way the local web page sends them (JSON, from localhost), so the API's own checks decide.
 */
export function apiCaller(app: Hono<any>, headers: Record<string, string> = {}): ApiCall {
  return async (path, body) => {
    const init: RequestInit =
      body === undefined
        ? { headers }
        : { method: "POST", headers: { ...headers, "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify(body) };
    const res = await app.request(`http://localhost/api${path}`, init);
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error ?? `Tracemind answered ${res.status}`);
    return data;
  };
}
