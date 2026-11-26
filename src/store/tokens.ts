/** Access tokens for the shared server: only a hash is stored. */
import { createHash, randomBytes } from "node:crypto";
import type { Db, Row } from "./db.ts";
import { n, now } from "./rows.ts";

type Role = "admin" | "member";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * How a token is named when it is listed or revoked: the start of its hash. Enough to tell a
 * workspace's tokens apart, and of no use as a token.
 */
const ID_LENGTH = 8;
export const tokenId = (token: string) => hashToken(token).slice(0, ID_LENGTH);

/** A token as an admin sees it: who holds it, and whether it is in use. Never the token itself. */
export type TokenInfo = { id: string; person: string; role: Role; createdAt: string; lastUsedAt: string | null };

export async function createToken(db: Db, ws: string, person: string, role: Role): Promise<string> {
  const token = `tm_${randomBytes(24).toString("base64url")}`;
  await db.run("INSERT INTO tokens (hash, workspace, person, role, created_at) VALUES (?, ?, ?, ?, ?)", [
    hashToken(token), ws, person, role, now(),
  ]);
  return token;
}

export async function tokenOwner(db: Db, token: string): Promise<{ workspace: string; person: string; role: Role } | null> {
  if (!token.startsWith("tm_")) return null;
  const hash = hashToken(token);
  const rows = await db.all<Row>("SELECT workspace, person, role FROM tokens WHERE hash = ?", [hash]);
  if (rows.length === 0) return null;
  await db.run("UPDATE tokens SET last_used_at = ? WHERE hash = ?", [now(), hash]);
  return { workspace: String(rows[0].workspace), person: String(rows[0].person), role: rows[0].role as Role };
}

export async function tokenCount(db: Db): Promise<number> {
  const [r] = await db.all<Row>("SELECT CAST(COUNT(*) AS INTEGER) AS c FROM tokens");
  return n(r?.c);
}

/** A workspace's tokens, oldest first. */
export async function listTokens(db: Db, ws: string): Promise<TokenInfo[]> {
  const rows = await db.all<Row>("SELECT hash, person, role, created_at, last_used_at FROM tokens WHERE workspace = ? ORDER BY created_at, hash", [ws]);
  return rows.map((r) => ({
    id: String(r.hash).slice(0, ID_LENGTH),
    person: String(r.person),
    role: r.role as Role,
    createdAt: String(r.created_at),
    lastUsedAt: (r.last_used_at as string) ?? null,
  }));
}

export type Revoked = { outcome: "revoked"; id: string } | { outcome: "not found" | "ambiguous" | "last admin" };

/**
 * Revokes the one token of a workspace whose id starts with `id`: it stops working at once, in the
 * browser too. Refuses a workspace's last admin token, which would leave no one able to create or
 * revoke tokens there.
 */
export async function revokeToken(db: Db, ws: string, id: string): Promise<Revoked> {
  if (!/^[0-9a-f]{6,64}$/.test(id)) return { outcome: "not found" };
  return db.transaction(async (db) => {
    // A workspace has a handful of tokens: read them all, rather than match a pattern in SQL.
    const all = await db.all<Row>("SELECT hash, role FROM tokens WHERE workspace = ?", [ws]);
    const matches = all.filter((r) => String(r.hash).startsWith(id));
    if (matches.length !== 1) return { outcome: matches.length ? "ambiguous" : "not found" } as const;
    const [token] = matches;
    if (token.role === "admin" && all.filter((r) => r.role === "admin").length === 1) return { outcome: "last admin" } as const;
    await db.run("DELETE FROM tokens WHERE workspace = ? AND hash = ?", [ws, token.hash]);
    return { outcome: "revoked", id: String(token.hash).slice(0, ID_LENGTH) } as const;
  });
}
