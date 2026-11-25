/**
 * Vercel entry for the shared server. Needs DATABASE_URL (Postgres, e.g. Neon) and, to create the
 * first admin token, TRACEMIND_SETUP_SECRET.
 */
import { handle } from "hono/vercel";
import { createApp } from "../src/server/app.ts";
import { openPostgres } from "../src/store/db.ts";
import { Store } from "../src/store/store.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const store = new Store(await openPostgres(url));
await store.migrate();

const app = createApp({ store, mode: "server", setupSecret: process.env.TRACEMIND_SETUP_SECRET });

// /mcp (streamable HTTP) also uses DELETE, and browsers send OPTIONS before a cross-site POST.
export const GET = handle(app);
export const POST = handle(app);
export const DELETE = handle(app);
export const OPTIONS = handle(app);
