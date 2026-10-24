import pg from "pg";
import { config } from "./config";
import { migrations } from "./migrations";
import { logger } from "./logger";

export type Row = Record<string, any>;
export interface Queryable {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T | undefined>;
}
export interface Database extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  kind: "postgres";
  close(): Promise<void>;
}

// Return BIGINT/NUMERIC as JS numbers (all our counts and amounts fit comfortably).
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

function wrap(run: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>): Queryable {
  return {
    async query(sql, params = []) {
      return (await run(sql, params)).rows;
    },
    async one(sql, params = []) {
      return (await run(sql, params)).rows[0];
    },
  };
}

const sslFor = (url: string) =>
  /sslmode=require/.test(url) || process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: process.env.DATABASE_SSL_STRICT === "true" } : undefined;

/** Friendly explanations for the usual local PostgreSQL problems. */
function explain(err: any, url: URL): string {
  const where = `${url.hostname}:${url.port || 5432}`;
  switch (err?.code) {
    case "ECONNREFUSED":
      return `Can't connect to PostgreSQL at ${where}. Is the PostgreSQL service running? (Windows: open "Services" and start "postgresql-x64-…")`;
    case "28P01":
      return `PostgreSQL rejected the password for user "${decodeURIComponent(url.username)}". Fix the password in DATABASE_URL in your .env file.`;
    case "28000":
      return `PostgreSQL user "${decodeURIComponent(url.username)}" isn't allowed to connect. Check the user name in DATABASE_URL.`;
    case "ENOTFOUND":
      return `PostgreSQL host "${url.hostname}" was not found. Check DATABASE_URL.`;
    case "ETIMEDOUT":
    case "ECONNRESET":
    case "EHOSTUNREACH":
      return `Timed out reaching ${where}. Check your internet connection, or that the database allows connections from this server (Neon allows all IPs unless you set an IP allow-list).`;
    case "3D000":
      return `Database "${decodeURIComponent(url.pathname.slice(1))}" doesn't exist on ${url.hostname}. Check the name at the end of DATABASE_URL.`;
    default:
      if (/self[- ]signed|certificate/i.test(err?.message ?? "")) return `SSL certificate problem talking to ${url.hostname}: ${err.message}. Keep "?sslmode=require" at the end of DATABASE_URL.`;
      if (/endpoint.*(disabled|not found|could not be found)|compute.*suspended|project.*(not found|deleted)/i.test(err?.message ?? "")) return `Neon says: ${err.message}. Open the Neon console and check the project/branch is active and the connection string is current.`;
      if (/password authentication failed/i.test(err?.message ?? "")) return `The database rejected the password for "${decodeURIComponent(url.username)}". Copy a fresh connection string from your database dashboard (Neon: Dashboard → Connect).`;
      if (/ssl|SSL off/i.test(err?.message ?? "") && !/sslmode=/.test(url.search)) return `This database requires SSL. Add "?sslmode=require" to the end of DATABASE_URL.`;
      return `Database error (${url.hostname}): ${err?.message ?? err}`;
  }
}

/** Creates the database named in DATABASE_URL if it doesn't exist yet (handy for local PostgreSQL). */
async function ensureDatabaseExists(url: URL) {
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!name) throw new Error("DATABASE_URL must include a database name, e.g. postgres://postgres:password@localhost:5432/votehub");
  const probe = new pg.Client({ connectionString: url.toString(), ssl: sslFor(url.toString()), connectionTimeoutMillis: 20_000 });
  try {
    await probe.connect();
    await probe.end();
    return;
  } catch (err: any) {
    await probe.end().catch(() => undefined);
    if (err?.code !== "3D000") throw err; // 3D000 = database does not exist
  }
  const adminUrl = new URL(url.toString());
  adminUrl.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: adminUrl.toString(), ssl: sslFor(url.toString()) });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
    logger.info(`Created database "${name}"`);
  } finally {
    await admin.end();
  }
}

export let db: Database;

export async function initDatabase(): Promise<Database> {
  if (!config.databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set. Add it to the .env file, e.g. DATABASE_URL=postgres://postgres:YOUR_PASSWORD@localhost:5432/votehub',
    );
  }
  let url: URL;
  try {
    url = new URL(config.databaseUrl);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL. Example: postgres://postgres:YOUR_PASSWORD@localhost:5432/votehub");
  }
  try {
    await ensureDatabaseExists(url);
  } catch (err) {
    throw new Error(explain(err, url));
  }

  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: Number(process.env.DATABASE_POOL_SIZE ?? 10), ssl: sslFor(config.databaseUrl), connectionTimeoutMillis: 20_000, idleTimeoutMillis: 30_000 });
  pool.on("error", (err) => logger.error("PostgreSQL pool error", err));
  db = {
    ...wrap((sql, params) => pool.query(sql, params as any[])),
    kind: "postgres",
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(wrap((sql, params) => client.query(sql, params as any[])));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
  logger.info(`Database: PostgreSQL ${url.hostname}:${url.port || 5432}/${url.pathname.slice(1)}`);

  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const applied = new Set((await db.query<{ id: number }>("SELECT id FROM schema_migrations")).map((r) => r.id));
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    await db.tx(async (q) => {
      for (const statement of m.sql.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean)) await q.query(statement);
      await q.query("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]);
    });
    logger.info(`Applied migration ${m.id}: ${m.name}`);
  }
  return db;
}
