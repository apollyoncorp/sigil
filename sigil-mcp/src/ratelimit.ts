// In-memory token buckets for the remote (HTTP) mode. One process, no shared
// state: good enough for a single container; a second replica would have its
// own counters.

export class TokenBucket {
  private tokens: number;
  private last: number;

  /** @param capacity burst size @param perMs tokens added per millisecond */
  constructor(
    readonly capacity: number,
    readonly perMs: number,
    now: number,
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  private refill(now: number) {
    if (now > this.last) {
      this.tokens = Math.min(
        this.capacity,
        this.tokens + (now - this.last) * this.perMs,
      );
    }
    this.last = now;
  }

  /** 0 when one token is available, otherwise the milliseconds until it is. */
  waitMs(now: number) {
    this.refill(now);
    return this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) / this.perMs);
  }

  take() {
    this.tokens -= 1;
  }

  /** True when the bucket is back at full capacity (nothing worth remembering). */
  isFull(now: number) {
    this.refill(now);
    return this.tokens >= this.capacity;
  }
}

export type RateLimitConfig = {
  /** requests per minute per client (also the burst size) */
  perMinute: number;
  /** requests per day per client */
  perDay: number;
  /** requests per minute across every client */
  globalPerMinute: number;
  /** clients remembered at once; the least recently seen is dropped first */
  maxClients?: number;
};

export type Verdict =
  | { allowed: true }
  | { allowed: false; scope: "minute" | "day" | "global"; retryAfterSec: number };

const MINUTE = 60_000;
const DAY = 86_400_000;

export class RateLimiter {
  private clients = new Map<
    string,
    { minute: TokenBucket; day: TokenBucket }
  >();
  private global: TokenBucket;
  private sweeper?: ReturnType<typeof setInterval>;

  constructor(
    private config: RateLimitConfig,
    private clock: () => number = Date.now,
  ) {
    this.global = new TokenBucket(
      config.globalPerMinute,
      config.globalPerMinute / MINUTE,
      clock(),
    );
  }

  /** Starts the idle-client sweep (the timer does not keep the process alive). */
  start(intervalMs = MINUTE) {
    this.sweeper ??= setInterval(() => this.sweep(), intervalMs);
    this.sweeper.unref?.();
  }

  stop() {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
  }

  get size() {
    return this.clients.size;
  }

  /** Forgets clients whose buckets are full again. */
  sweep() {
    const now = this.clock();
    for (const [key, c] of this.clients) {
      if (c.minute.isFull(now) && c.day.isFull(now)) {
        this.clients.delete(key);
      }
    }
  }

  /** Counts one request from `key` when every limit allows it. */
  take(key: string): Verdict {
    const now = this.clock();
    let c = this.clients.get(key);
    if (c) {
      // keep the Map in least-recently-seen order
      this.clients.delete(key);
    } else {
      c = {
        minute: new TokenBucket(
          this.config.perMinute,
          this.config.perMinute / MINUTE,
          now,
        ),
        day: new TokenBucket(
          this.config.perDay,
          this.config.perDay / DAY,
          now,
        ),
      };
    }
    this.clients.set(key, c);
    const max = this.config.maxClients ?? 50_000;
    while (this.clients.size > max) {
      this.clients.delete(this.clients.keys().next().value as string);
    }

    const waits = [
      { scope: "minute" as const, ms: c.minute.waitMs(now) },
      { scope: "day" as const, ms: c.day.waitMs(now) },
      { scope: "global" as const, ms: this.global.waitMs(now) },
    ];
    const worst = waits.reduce((a, b) => (b.ms > a.ms ? b : a));
    if (worst.ms > 0) {
      return {
        allowed: false,
        scope: worst.scope,
        retryAfterSec: Math.max(1, Math.ceil(worst.ms / 1000)),
      };
    }
    c.minute.take();
    c.day.take();
    this.global.take();
    return { allowed: true };
  }
}
