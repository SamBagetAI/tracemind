/**
 * One small interface over the two databases Tracemind runs on: SQLite on a laptop (node:sqlite,
 * no native build) and Postgres on a server. SQL is written once with `?` placeholders.
 */

export type Row = Record<string, unknown>;

export interface Db {
  readonly dialect: "sqlite" | "postgres";
  all<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** `?` → `$1, $2…` for Postgres. The SQL in this project never puts a `?` inside a string literal. */
export function toPg(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

function sqliteValue(v: unknown): any {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === undefined) return null;
  return v;
}

export async function openSqlite(path: string): Promise<Db> {
  // Loaded lazily so the server bundle never needs node:sqlite.
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  let depth = 0;
  const db: Db = {
    dialect: "sqlite",
    async all<T>(sql: string, params: unknown[] = []) {
      return raw.prepare(sql).all(...params.map(sqliteValue)) as T[];
    },
    async run(sql, params = []) {
      raw.prepare(sql).run(...params.map(sqliteValue));
    },
    async exec(sql) {
      raw.exec(sql);
    },
    async transaction(fn) {
      if (depth > 0) return fn(db);
      depth++;
      raw.exec("BEGIN IMMEDIATE");
      try {
        const out = await fn(db);
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      } finally {
        depth--;
      }
    },
    async close() {
      raw.close();
    },
  };
  return db;
}

/** Anything with `query(text, params)` returning `{ rows }`: PGlite in tests. */
export type PgQueryable = {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  exec(sql: string): Promise<unknown>;
  transaction?<T>(fn: (tx: PgQueryable) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
};

export function fromPgQueryable(q: PgQueryable): Db {
  const db: Db = {
    dialect: "postgres",
    async all<T>(sql: string, params: unknown[] = []) {
      return (await q.query(toPg(sql), params)).rows as T[];
    },
    async run(sql, params = []) {
      await q.query(toPg(sql), params);
    },
    async exec(sql) {
      await q.exec(sql);
    },
    async transaction(fn) {
      if (!q.transaction) return fn(db);
      return q.transaction((tx) => fn(fromPgQueryable(tx)));
    },
    async close() {
      await q.close?.();
    },
  };
  return db;
}

/** Postgres through the `postgres` package, for a deployed server (Neon, Supabase, RDS…). */
export async function openPostgres(url: string): Promise<Db> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { max: 5, idle_timeout: 20, prepare: false, onnotice: () => {} });
  const wrap = (s: any): Db => {
    const db: Db = {
      dialect: "postgres",
      async all<T>(text: string, params: unknown[] = []) {
        return (await s.unsafe(toPg(text), params as any[])) as T[];
      },
      async run(text, params = []) {
        await s.unsafe(toPg(text), params as any[]);
      },
      async exec(text) {
        await s.unsafe(text);
      },
      async transaction(fn) {
        if (s !== sql) return fn(db);
        return sql.begin((tx: any) => fn(wrap(tx))) as any;
      },
      async close() {
        await sql.end({ timeout: 5 });
      },
    };
    return db;
  };
  return wrap(sql);
}
