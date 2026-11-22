// SQLite storage for the remote (HTTP) mode: rate-limit counters, the IP-hash
// salt and the usage aggregates. One file in SIGIL_MCP_DATA_DIR, WAL mode.
//
// What is stored, and only this:
//   - meta: the salt (random, generated once, kept across restarts)
//   - rate_minute / rate_day / rate_global: counters keyed by an HMAC-SHA256
//     of the client address (IPv6 as /64) with that salt. The address itself
//     is never written. Old rows are swept (see sweep()).
//   - usage / usage_day: per UTC day and tool, how many calls, how many were
//     answered 429 and how many failed, plus how many distinct clients.
//   No diagram content, no address, no request text.
//
// node:sqlite is built into Node 24 (no flag, no warning). It is loaded with
// createRequire at runtime, NOT with a static import: the bundle is one file,
// and a static import would be hoisted to its top and open sqlite in stdio
// mode too.
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

export const DB_FILE = "sigil-mcp.db";

const MINUTE = 60_000;
const DAY = 86_400_000;

/** The three tools plus everything else (initialize, tools/list, junk). */
export const USAGE_TOOLS = [
  "create_diagram",
  "mermaid_to_diagram",
  "describe_format",
  "other",
] as const;
export type UsageTool = (typeof USAGE_TOOLS)[number];
export type Outcome = "ok" | "limited" | "error";

export type RateLimitConfig = {
  /** requests per client per fixed minute window */
  perMinute: number;
  /** requests per client per UTC day */
  perDay: number;
  /** requests per fixed minute window across every client */
  globalPerMinute: number;
};

export type Verdict =
  | { allowed: true }
  | { allowed: false; scope: "minute" | "day" | "global"; retryAfterSec: number };

export type ToolStats = { calls: number; rate_limited: number; errors: number };
export type DayStats = {
  day: string;
  distinct_ips: number;
  tools: Record<UsageTool, ToolStats>;
  total: ToolStats;
};
export type Stats = {
  since: string;
  until: string;
  days: DayStats[];
  total: ToolStats & { distinct_ip_days: number };
};

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const emptyTool = (): ToolStats => ({ calls: 0, rate_limited: 0, errors: 0 });

type Row = Record<string, unknown>;

export class Store {
  private db: DatabaseSyncType;
  private salt: Buffer;
  private sweeper?: ReturnType<typeof setInterval>;

  constructor(
    dir: string,
    private config: RateLimitConfig,
    private clock: () => number = Date.now,
  ) {
    let DatabaseSync: typeof DatabaseSyncType;
    try {
      ({ DatabaseSync } = createRequire(import.meta.url)(
        "node:sqlite",
      ) as typeof import("node:sqlite"));
    } catch {
      throw new Error(
        "The remote mode needs node:sqlite, which is built into Node 24 and later. Use Node 24+.",
      );
    }
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(join(dir, DB_FILE));
    // other processes (an old container during a redeploy) wait up to 2 s
    // for a write lock instead of failing
    this.db.exec("PRAGMA busy_timeout = 2000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS rate_minute (key TEXT NOT NULL, bucket INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (key, bucket)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS rate_minute_bucket ON rate_minute(bucket);
      CREATE TABLE IF NOT EXISTS rate_global (bucket INTEGER PRIMARY KEY, n INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rate_day (day TEXT NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, key)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS usage (day TEXT NOT NULL, tool TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, limited INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, tool)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS usage_day (day TEXT PRIMARY KEY, ips INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
    `);
    // first writer wins; a second process reads the same salt back
    this.db
      .prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('salt', ?)")
      .run(randomBytes(32).toString("hex"));
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'salt'").get() as Row;
    this.salt = Buffer.from(String(row.value), "hex");
    this.sweep();
  }

  /** The stored form of a client key: HMAC-SHA256 with the persistent salt. */
  hash(clientKey: string, length = 32) {
    return createHmac("sha256", this.salt).update(clientKey).digest("hex").slice(0, length);
  }

  /** Starts the periodic sweep (the timer does not keep the process alive). */
  start(intervalMs = MINUTE) {
    this.sweeper ??= setInterval(() => {
      try {
        this.sweep();
      } catch {
        // a failing disk shows up on the next request (503); not here
      }
    }, intervalMs);
    this.sweeper.unref?.();
  }

  close() {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  /** Throws when the database cannot be used. */
  ping() {
    this.db.prepare("SELECT 1").get();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // the connection is gone
      }
      throw e;
    }
  }

  /**
   * Counts one request from `keyHash` when every limit allows it.
   *
   * Fixed windows: a minute is the wall-clock minute (UTC), a day is the UTC
   * day. A denied request costs nothing against the counters and writes no row. A client can
   * therefore send up to twice the per-minute limit across a minute boundary,
   * and the per-day limit resets at 00:00 UTC. Also registers an allowed client
   * as seen today (distinct count in usage_day).
   */
  take(keyHash: string): Verdict {
    const now = this.clock();
    const bucket = Math.floor(now / MINUTE);
    const day = dayOf(now);
    return this.tx(() => {
      const db = this.db;
      const n = (sql: string, ...args: (string | number)[]) =>
        Number((db.prepare(sql).get(...args) as Row | undefined)?.n ?? 0);
      const minute = n("SELECT n FROM rate_minute WHERE key = ? AND bucket = ?", keyHash, bucket);
      const today = n("SELECT n FROM rate_day WHERE day = ? AND key = ?", day, keyHash);
      const global = n("SELECT n FROM rate_global WHERE bucket = ?", bucket);

      const toMinuteEnd = (bucket + 1) * MINUTE - now;
      const toDayEnd = Date.parse(`${day}T00:00:00Z`) + DAY - now;
      const waits: { scope: "minute" | "day" | "global"; ms: number }[] = [];
      if (minute >= this.config.perMinute) waits.push({ scope: "minute", ms: toMinuteEnd });
      if (today >= this.config.perDay) waits.push({ scope: "day", ms: toDayEnd });
      if (global >= this.config.globalPerMinute) waits.push({ scope: "global", ms: toMinuteEnd });
      if (waits.length > 0) {
        const worst = waits.reduce((a, b) => (b.ms > a.ms ? b : a));
        return {
          allowed: false,
          scope: worst.scope,
          retryAfterSec: Math.max(1, Math.ceil(worst.ms / 1000)),
        };
      }
      // only an allowed request leaves rows behind (a refused one is not
      // written, so it cannot inflate the table or the distinct count)
      if (db.prepare("INSERT OR IGNORE INTO rate_day (day, key, n) VALUES (?, ?, 0)").run(day, keyHash).changes > 0) {
        this.bumpIps(day);
      }
      db.prepare(
        "INSERT INTO rate_minute (key, bucket, n) VALUES (?, ?, 1) ON CONFLICT (key, bucket) DO UPDATE SET n = n + 1",
      ).run(keyHash, bucket);
      db.prepare("UPDATE rate_day SET n = n + 1 WHERE day = ? AND key = ?").run(day, keyHash);
      db.prepare(
        "INSERT INTO rate_global (bucket, n) VALUES (?, 1) ON CONFLICT (bucket) DO UPDATE SET n = n + 1",
      ).run(bucket);
      return { allowed: true };
    });
  }

  private bumpIps(day: string) {
    this.db
      .prepare("INSERT INTO usage_day (day, ips) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET ips = ips + 1")
      .run(day);
  }

  /** One request, attributed to a tool and an outcome. */
  record(tool: UsageTool, outcome: Outcome) {
    const day = dayOf(this.clock());
    this.db
      .prepare(
        `INSERT INTO usage (day, tool, calls, limited, errors) VALUES (?, ?, 1, ?, ?)
         ON CONFLICT (day, tool) DO UPDATE SET calls = calls + 1, limited = limited + excluded.limited, errors = errors + excluded.errors`,
      )
      .run(day, tool, outcome === "limited" ? 1 : 0, outcome === "error" ? 1 : 0);
  }

  /**
   * Drops what is no longer needed: minute counters older than 10 minutes,
   * per-client day rows older than 2 days, usage aggregates older than 90 days.
   */
  sweep() {
    const now = this.clock();
    const bucket = Math.floor(now / MINUTE);
    const keepDays = dayOf(now - 2 * DAY);
    const keepUsage = dayOf(now - 90 * DAY);
    this.tx(() => {
      this.db.prepare("DELETE FROM rate_minute WHERE bucket < ?").run(bucket - 10);
      this.db.prepare("DELETE FROM rate_global WHERE bucket < ?").run(bucket - 10);
      this.db.prepare("DELETE FROM rate_day WHERE day < ?").run(keepDays);
      this.db.prepare("DELETE FROM usage WHERE day < ?").run(keepUsage);
      this.db.prepare("DELETE FROM usage_day WHERE day < ?").run(keepUsage);
    });
  }

  /** Aggregates of the last `days` days (today included), oldest first. */
  stats(days = 30): Stats {
    const now = this.clock();
    const until = dayOf(now);
    const since = dayOf(now - (days - 1) * DAY);
    const byDay = new Map<string, DayStats>();
    const day = (d: string) => {
      let s = byDay.get(d);
      if (!s) {
        s = {
          day: d,
          distinct_ips: 0,
          tools: Object.fromEntries(USAGE_TOOLS.map((t) => [t, emptyTool()])) as Record<UsageTool, ToolStats>,
          total: emptyTool(),
        };
        byDay.set(d, s);
      }
      return s;
    };
    for (const r of this.db
      .prepare("SELECT day, ips FROM usage_day WHERE day >= ? AND day <= ?")
      .all(since, until) as Row[]) {
      day(String(r.day)).distinct_ips = Number(r.ips);
    }
    for (const r of this.db
      .prepare("SELECT day, tool, calls, limited, errors FROM usage WHERE day >= ? AND day <= ?")
      .all(since, until) as Row[]) {
      const s = day(String(r.day));
      const t: ToolStats = {
        calls: Number(r.calls),
        rate_limited: Number(r.limited),
        errors: Number(r.errors),
      };
      s.tools[(USAGE_TOOLS as readonly string[]).includes(String(r.tool)) ? (r.tool as UsageTool) : "other"] = t;
      s.total.calls += t.calls;
      s.total.rate_limited += t.rate_limited;
      s.total.errors += t.errors;
    }
    const list = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
    return {
      since,
      until,
      days: list,
      total: {
        calls: list.reduce((a, d) => a + d.total.calls, 0),
        rate_limited: list.reduce((a, d) => a + d.total.rate_limited, 0),
        errors: list.reduce((a, d) => a + d.total.errors, 0),
        distinct_ip_days: list.reduce((a, d) => a + d.distinct_ips, 0),
      },
    };
  }
}
