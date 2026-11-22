// Remote mode: the same tools over MCP Streamable HTTP, stateless (a fresh
// McpServer and transport per request, no sessions, nothing kept between
// calls). Meant to sit behind a Cloudflare Tunnel.
//
//   sigil-mcp --http            (or SIGIL_MCP_HTTP=1; PORT, default 8080)
//
// Persistence: rate-limit counters, the IP-hash salt and per-day usage
// aggregates live in one SQLite file in SIGIL_MCP_DATA_DIR (see store.ts), so
// a restart or redeploy does not reset the limits. Diagrams are never written
// to disk, and their content is never logged or stored: a log line is method,
// path, status, duration and a salted hash of the IP.
import { createHash, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { isIP } from "node:net";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createServer, SERVER_VERSION, TOOL_NAMES } from "./server";
import { Store, type Outcome, type UsageTool } from "./store";

export type HttpConfig = {
  port: number;
  host: string;
  perMinute: number;
  perDay: number;
  globalPerMinute: number;
  maxBodyBytes: number;
  requestTimeoutMs: number;
  maxInFlight: number;
  /** simultaneous requests per client key (checked before the body is read) */
  maxInFlightPerIp: number;
  /** how long the body of a request may take to arrive (408 above) */
  bodyTimeoutMs: number;
  /** read the client IP from CF-Connecting-IP (turn off when not behind Cloudflare) */
  trustCfHeader: boolean;
  /** folder of the SQLite file (counters, salt, usage); needs a persistent volume */
  dataDir: string;
  /** Bearer token for GET /stats; without one the route is a 404 */
  statsToken?: string;
  /** when set, /mcp and /stats need `X-Sigil-Origin-Auth: <this>` (Cloudflare adds it) */
  originSecret?: string;
  /** SIGIL_MCP_ALLOW_NO_ORIGIN_SECRET=1: start without an origin secret */
  allowNoOriginSecret: boolean;
};

export const ORIGIN_HEADER = "x-sigil-origin-auth";

export const MIN_STATS_TOKEN_LENGTH = 16;

const intEnv = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min = 1,
) => {
  const raw = env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    console.error(`${name}=${raw} is not valid (integer >= ${min}); using ${fallback}`);
    return fallback;
  }
  return n;
};

const statsToken = (env: NodeJS.ProcessEnv) => {
  const token = env.SIGIL_MCP_STATS_TOKEN?.trim();
  if (!token) {
    return undefined;
  }
  if (token.length < MIN_STATS_TOKEN_LENGTH) {
    console.error(
      `SIGIL_MCP_STATS_TOKEN is shorter than ${MIN_STATS_TOKEN_LENGTH} characters; /stats stays off`,
    );
    return undefined;
  }
  return token;
};

const originSecret = (env: NodeJS.ProcessEnv) => {
  // kept even when too short: configProblem() turns that into a startup error
  return env.SIGIL_MCP_ORIGIN_SECRET?.trim() || undefined;
};

/**
 * Why this configuration must not start, or undefined when it is fine. Remote
 * mode without an origin secret lets anyone who can reach the port forge
 * CF-Connecting-IP, so it is refused unless the operator opted out on purpose.
 */
export const configProblem = (config: HttpConfig) => {
  if (!config.originSecret) {
    return config.allowNoOriginSecret
      ? undefined
      : "SIGIL_MCP_ORIGIN_SECRET is not set. Set a random secret of " +
          `${MIN_STATS_TOKEN_LENGTH}+ characters (and have Cloudflare send it as X-Sigil-Origin-Auth), ` +
          "or set SIGIL_MCP_ALLOW_NO_ORIGIN_SECRET=1 to run without the check.";
  }
  if (config.originSecret.length < MIN_STATS_TOKEN_LENGTH) {
    return `SIGIL_MCP_ORIGIN_SECRET is shorter than ${MIN_STATS_TOKEN_LENGTH} characters: easy to guess.`;
  }
  return undefined;
};

export const loadHttpConfig = (
  env: NodeJS.ProcessEnv = process.env,
): HttpConfig => ({
  port: intEnv(env, "PORT", 8080, 0),
  host: env.HOST?.trim() || "0.0.0.0",
  perMinute: intEnv(env, "SIGIL_MCP_RATE_PER_MINUTE", 30),
  perDay: intEnv(env, "SIGIL_MCP_RATE_PER_DAY", 500),
  globalPerMinute: intEnv(env, "SIGIL_MCP_RATE_GLOBAL_PER_MINUTE", 600),
  maxBodyBytes: intEnv(env, "SIGIL_MCP_MAX_BODY_BYTES", 1_048_576),
  requestTimeoutMs: intEnv(env, "SIGIL_MCP_REQUEST_TIMEOUT_MS", 30_000),
  maxInFlight: intEnv(env, "SIGIL_MCP_MAX_IN_FLIGHT", 16),
  maxInFlightPerIp: intEnv(env, "SIGIL_MCP_MAX_IN_FLIGHT_PER_IP", 4),
  bodyTimeoutMs: intEnv(env, "SIGIL_MCP_BODY_TIMEOUT_MS", 5_000),
  trustCfHeader: !/^(0|false|no)$/i.test(env.SIGIL_MCP_TRUST_CF_HEADER ?? ""),
  dataDir: env.SIGIL_MCP_DATA_DIR?.trim() || join(homedir(), ".sigil-mcp"),
  statsToken: statsToken(env),
  originSecret: originSecret(env),
  allowNoOriginSecret: env.SIGIL_MCP_ALLOW_NO_ORIGIN_SECRET?.trim() === "1",
});

// --- client address -------------------------------------------------------

/**
 * The key a client is limited by. IPv4-mapped IPv6 collapses to IPv4, and an
 * IPv6 address collapses to its /64 (one subscriber owns a whole /64, so
 * limiting single addresses would be no limit at all).
 */
export const normalizeIp = (raw: string) => {
  let ip = raw.trim().replace(/%.*$/, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) {
    ip = mapped[1];
  }
  if (isIP(ip) !== 6 || ip.includes(".")) {
    return ip.toLowerCase();
  }
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = [
    ...h,
    ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"),
    ...t,
  ];
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g || "0", 16).toString(16))
    .join(":")}::/64`;
};

/**
 * The client address a request is limited by.
 *
 * With `trustCfHeader` (the default, for a server behind Cloudflare) it is
 * CF-Connecting-IP when that is a single valid address, and `undefined`
 * otherwise: the caller refuses the request. It never falls back to the socket
 * address, because behind a proxy that is the proxy's address (one bucket for
 * everyone), and a request that reached the server without passing Cloudflare
 * (from the LAN, say) could be anyone. With `trustCfHeader` off (a server not
 * behind Cloudflare) it is the socket address and the header is ignored.
 * X-Forwarded-For is never read: anyone can write anything in it, and Traefik
 * rewrites it.
 */
export const clientKey = (req: IncomingMessage, trustCfHeader = true) => {
  if (!trustCfHeader) {
    return normalizeIp(req.socket.remoteAddress ?? "unknown");
  }
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && isIP(cf.trim())) {
    return normalizeIp(cf);
  }
  return undefined;
};

// --- responses ------------------------------------------------------------

const rpcError = (code: number, message: string) =>
  JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });

const send = (
  res: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string | number> = {},
) => {
  if (res.headersSent || res.writableEnded) {
    return;
  }
  res.writeHead(status, {
    "Content-Type": body.startsWith("{") ? "application/json" : "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
};

type Body = { ok: true; json: unknown } | { ok: false; status: number; message: string };

const readJsonBody = (req: IncomingMessage, maxBytes: number, timeoutMs: number) =>
  new Promise<Body>((resolve) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      resolve({ ok: false, status: 413, message: `Request body too large (limit ${maxBytes} bytes).` });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (b: Body) => {
      if (!done) {
        done = true;
        clearTimeout(deadline);
        req.off("data", onData);
        resolve(b);
      }
    };
    // a client that trickles the body must not hold a slot until the (longer)
    // request timeout
    const deadline = setTimeout(
      () => finish({ ok: false, status: 408, message: "Request body timed out." }),
      timeoutMs,
    );
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        finish({ ok: false, status: 413, message: `Request body too large (limit ${maxBytes} bytes).` });
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.once("end", () => {
      try {
        finish({ ok: true, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch {
        finish({ ok: false, status: 400, message: "Parse error: body is not valid JSON." });
      }
    });
    req.once("error", () => finish({ ok: false, status: 400, message: "Request aborted." }));
    req.once("close", () => finish({ ok: false, status: 400, message: "Request aborted." }));
  });

// --- the server -----------------------------------------------------------

export type RemoteServer = {
  server: Server;
  store: Store;
  close: () => Promise<void>;
};

/** The tool a JSON-RPC body calls; anything else is counted as "other". */
export const toolOf = (json: unknown): UsageTool => {
  for (const m of Array.isArray(json) ? json : [json]) {
    const msg = m as { method?: unknown; params?: { name?: unknown } } | null;
    if (msg?.method === "tools/call") {
      const name = msg.params?.name;
      const known = (TOOL_NAMES as readonly unknown[]).includes(name);
      return known ? (name as UsageTool) : "other";
    }
  }
  return "other";
};

/** True when a JSON-RPC reply (one message or a batch) carries an error. */
const replyFailed = (text: string) => {
  try {
    const msgs = JSON.parse(text);
    return (Array.isArray(msgs) ? msgs : [msgs]).some(
      (m) => m?.error !== undefined || m?.result?.isError === true,
    );
  } catch {
    return false;
  }
};

/** Replies larger than this are not inspected for errors (counted as ok). */
const MAX_REPLY_BYTES = 8 * 1024 * 1024;

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Constant-time check of an `Authorization: Bearer <token>` header. */
export const bearerMatches = (header: string | undefined, token: string) => {
  const m = /^Bearer (.+)$/.exec(header ?? "");
  // both sides are hashed first: same length, so no early exit on length
  return timingSafeEqual(digest(m?.[1] ?? ""), digest(token)) && m !== null;
};

/** Constant-time check of the `X-Sigil-Origin-Auth` header against the secret. */
export const originMatches = (header: string | string[] | undefined, secret: string) =>
  typeof header === "string" && timingSafeEqual(digest(header), digest(secret));

export const createRemoteServer = (
  config: HttpConfig = loadHttpConfig(),
  log: (line: string) => void = (line) => console.error(line),
  clock: () => number = Date.now,
): RemoteServer => {
  const store = new Store(
    config.dataDir,
    {
      perMinute: config.perMinute,
      perDay: config.perDay,
      globalPerMinute: config.globalPerMinute,
    },
    clock,
  );
  store.start();
  // the salt lives in the database: the same address hashes the same way
  // after a restart, and the hash cannot be turned back into an address
  const hashIp = (key: string) => store.hash(key);
  const logStoreError = (e: unknown) =>
    // name and sqlite error code only: a message could quote a path or a query
    log(
      JSON.stringify({
        event: "store_error",
        name: (e as Error)?.name ?? "Error",
        code: (e as { code?: string })?.code,
        errcode: (e as { errcode?: number })?.errcode,
      }),
    );
  let inFlight = 0;
  const inFlightByKey = new Map<string, number>();

  const handleMcp = async (req: IncomingMessage, res: ServerResponse) => {
    // Stateless server: no session to delete and nothing to push, so GET
    // (the optional server-to-client stream) and DELETE are 405, which the
    // spec allows. Browsers send OPTIONS first; it gets 405 too, and since
    // no CORS headers are set a web page cannot use this endpoint.
    if (req.method !== "POST") {
      send(res, 405, rpcError(-32000, "Method not allowed. POST JSON-RPC messages to /mcp."), { Allow: "POST" });
      return;
    }
    if (inFlight >= config.maxInFlight) {
      send(res, 503, rpcError(-32000, "Server busy. Try again shortly."), { "Retry-After": 1 });
      return;
    }

    // Forbidden, with no detail: the answer must not tell a forger which
    // check it failed
    if (config.originSecret && !originMatches(req.headers[ORIGIN_HEADER], config.originSecret)) {
      send(res, 403, rpcError(-32000, "Forbidden."));
      return;
    }
    const key = clientKey(req, config.trustCfHeader);
    if (key === undefined) {
      send(res, 403, rpcError(-32000, "Forbidden."));
      return;
    }

    // before the body is read: a slow sender must not be able to take every slot
    if ((inFlightByKey.get(key) ?? 0) >= config.maxInFlightPerIp) {
      send(res, 503, rpcError(-32000, "Too many simultaneous requests from this client. Try again shortly."), {
        "Retry-After": 1,
      });
      return;
    }

    inFlight++;
    inFlightByKey.set(key, (inFlightByKey.get(key) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        inFlight--;
        const left = (inFlightByKey.get(key) ?? 1) - 1;
        if (left > 0) {
          inFlightByKey.set(key, left);
        } else {
          inFlightByKey.delete(key);
        }
      }
    };
    let tool: UsageTool = "other";
    let limited = false;
    let counted = false;
    const replyChunks: Buffer[] = [];
    let replyBytes = 0;
    const timer = setTimeout(() => {
      send(res, 504, rpcError(-32000, "Request timed out."), { Connection: "close" });
      res.socket?.destroySoon();
    }, config.requestTimeoutMs);
    const mcpServer = createServer({ remote: true });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.once("close", () => {
      clearTimeout(timer);
      release();
      void transport.close().catch(() => {});
      void mcpServer.close().catch(() => {});
      if (counted) {
        const outcome: Outcome = limited
          ? "limited"
          : res.statusCode >= 400 || (replyChunks.length > 0 && replyFailed(Buffer.concat(replyChunks).toString("utf8")))
            ? "error"
            : "ok";
        try {
          store.record(tool, outcome);
        } catch (e) {
          logStoreError(e);
        }
      }
    });

    try {
      // The body is read before the limit check so a 429 can be attributed to
      // the tool that was called. It is bounded (size, time, in-flight cap).
      const body = await readJsonBody(req, config.maxBodyBytes, config.bodyTimeoutMs);
      if (body.ok && !Array.isArray(body.json)) {
        tool = toolOf(body.json);
      }

      // Failing closed: if the counters cannot be read or written, the request
      // is refused. Letting it through would mean serving without a limit.
      let verdict;
      try {
        verdict = store.take(hashIp(key));
      } catch (e) {
        logStoreError(e);
        send(res, 503, rpcError(-32000, "Service temporarily unavailable. Try again shortly."), { "Retry-After": 5 });
        return;
      }
      counted = true;
      if (!verdict.allowed) {
        limited = true;
        send(
          res,
          429,
          rpcError(
            -32000,
            verdict.scope === "global"
              ? "The shared server is at capacity. Try again shortly, or run sigil-mcp locally (npx -y @apollyoncorp/sigil-mcp)."
              : `Rate limit reached (${verdict.scope}). Try again in ${verdict.retryAfterSec}s, or run sigil-mcp locally (npx -y @apollyoncorp/sigil-mcp).`,
          ),
          { "Retry-After": verdict.retryAfterSec },
        );
        return;
      }
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
        send(res, 415, rpcError(-32000, "Content-Type must be application/json."));
        return;
      }
      if (!body.ok) {
        send(res, body.status, rpcError(body.status === 400 ? -32700 : -32000, body.message), { Connection: "close" });
        return;
      }
      // One message per request: a batch would run many tool calls for one
      // debit of the limit. It is refused after the debit, like any bad body.
      if (Array.isArray(body.json)) {
        send(res, 400, rpcError(-32600, "Batch requests are not supported."));
        return;
      }

      // keep what the transport writes (up to MAX_REPLY_BYTES) to see
      // afterwards whether the tool call failed
      const keep = (chunk: unknown) => {
        const buf =
          typeof chunk === "string"
            ? Buffer.from(chunk)
            : chunk instanceof Uint8Array
              ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
              : undefined;
        if (buf && replyBytes + buf.length <= MAX_REPLY_BYTES) {
          replyChunks.push(buf);
          replyBytes += buf.length;
        }
      };
      const write = res.write.bind(res) as (...args: unknown[]) => boolean;
      const end = res.end.bind(res) as (...args: unknown[]) => ServerResponse;
      (res as { write: unknown }).write = (chunk?: unknown, ...rest: unknown[]) => {
        keep(chunk);
        return write(chunk, ...rest);
      };
      (res as { end: unknown }).end = (chunk?: unknown, ...rest: unknown[]) => {
        keep(chunk);
        return end(chunk, ...rest);
      };
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body.json);
    } catch (e) {
      // only the error class: a message could quote the request
      log(JSON.stringify({ event: "error", name: (e as Error)?.name ?? "Error" }));
      send(res, 500, rpcError(-32603, "Internal error."));
    }
  };

  const handleStats = (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "GET") {
      send(res, 405, "Method not allowed", { Allow: "GET" });
      return;
    }
    if (config.originSecret && !originMatches(req.headers[ORIGIN_HEADER], config.originSecret)) {
      send(res, 403, "Forbidden");
      return;
    }
    if (!config.statsToken || !bearerMatches(req.headers.authorization, config.statsToken)) {
      send(res, 401, "Unauthorized", { "WWW-Authenticate": "Bearer" });
      return;
    }
    try {
      send(res, 200, JSON.stringify(store.stats(30)));
    } catch (e) {
      logStoreError(e);
      send(res, 503, "Service temporarily unavailable");
    }
  };

  const server = createHttpServer((req, res) => {
    const started = clock();
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    let path = "other";
    try {
      const p = new URL(req.url ?? "/", "http://sigil").pathname;
      // /stats exists only when a token is configured: otherwise it is a 404
      // like any unknown route
      path =
        p === "/mcp" || p === "/healthz" || (p === "/stats" && config.statsToken) ? p : "other";
    } catch {
      // malformed target: counts as "other"
    }
    // /healthz is called by the platform every few seconds: not logged
    res.once("close", () => {
      if (path !== "/healthz") {
        log(
          JSON.stringify({
            t: new Date(started).toISOString(),
            method: (req.method ?? "?").slice(0, 8),
            path,
            status: res.statusCode,
            ms: clock() - started,
            // no valid CF-Connecting-IP (a refused request): hash the socket
            // address, in its own domain, to see who keeps trying
            ip: store.hash(
              clientKey(req, config.trustCfHeader) ?? `socket:${req.socket.remoteAddress ?? ""}`,
              10,
            ),
          }),
        );
      }
    });

    if (path === "/healthz") {
      if (req.method === "GET" || req.method === "HEAD") {
        let storeState = "ok";
        try {
          store.ping();
        } catch {
          storeState = "error";
        }
        // 503 when the database fails, so the platform healthcheck notices
        send(
          res,
          storeState === "ok" ? 200 : 503,
          JSON.stringify({ status: "ok", version: SERVER_VERSION, store: storeState }),
        );
      } else {
        send(res, 405, "Method not allowed", { Allow: "GET, HEAD" });
      }
    } else if (path === "/mcp") {
      void handleMcp(req, res);
    } else if (path === "/stats") {
      handleStats(req, res);
    } else {
      send(res, 404, "Not found");
    }
  });
  // behind Cloudflare/Traefik: keep idle connections longer than the proxy
  // does, and bound slow clients
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 15_000;
  server.requestTimeout = config.requestTimeoutMs;

  return {
    server,
    store,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          store.close();
          resolve();
        });
        server.closeIdleConnections?.();
      }),
  };
};

export const startHttp = async (config: HttpConfig = loadHttpConfig()) => {
  const problem = configProblem(config);
  if (problem) {
    console.error(`sigil-mcp: refusing to start (remote mode). ${problem}`);
    process.exit(1);
  }
  const remote = createRemoteServer(config);
  await new Promise<void>((resolve, reject) => {
    remote.server.once("error", reject);
    remote.server.listen(config.port, config.host, resolve);
  });
  console.error(
    `sigil-mcp ready (http) on ${config.host}:${config.port}, POST /mcp; data in ${config.dataDir}${config.statsToken ? "; GET /stats on" : ""}`,
  );
  const stop = () => {
    // let in-flight requests finish, but not forever
    setTimeout(() => process.exit(0), 5_000).unref();
    void remote.close().then(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return remote;
};
