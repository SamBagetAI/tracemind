/** Access tokens for the shared server: only a hash is stored. */
import { createHash, randomBytes } from "node:crypto";
import type { Db, Row } from "./db.ts";
import { n, now } from "./rows.ts";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createToken(db: Db, ws: string, person: string, role: "admin" | "member"): Promise<string> {
  const token = `tm_${randomBytes(24).toString("base64url")}`;
  await db.run("INSERT INTO tokens (hash, workspace, person, role, created_at) VALUES (?, ?, ?, ?, ?)", [
    hashToken(token), ws, person, role, now(),
  ]);
  return token;
}

export async function tokenOwner(db: Db, token: string): Promise<{ workspace: string; person: string; role: "admin" | "member" } | null> {
  if (!token.startsWith("tm_")) return null;
  const hash = hashToken(token);
  const rows = await db.all<Row>("SELECT workspace, person, role FROM tokens WHERE hash = ?", [hash]);
  if (rows.length === 0) return null;
  await db.run("UPDATE tokens SET last_used_at = ? WHERE hash = ?", [now(), hash]);
  return { workspace: String(rows[0].workspace), person: String(rows[0].person), role: rows[0].role as "admin" | "member" };
}

export async function tokenCount(db: Db): Promise<number> {
  const [r] = await db.all<Row>("SELECT CAST(COUNT(*) AS INTEGER) AS c FROM tokens");
  return n(r?.c);
}
