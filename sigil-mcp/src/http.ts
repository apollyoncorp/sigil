// Remote mode: the same tools over MCP Streamable HTTP, stateless (a fresh
// McpServer and transport per request, no sessions, nothing kept between
// calls). Meant to sit behind a Cloudflare Tunnel.
//
//   sigil-mcp --http            (or SIGIL_MCP_HTTP=1; PORT, default 8080)
//
// Nothing is ever written to disk, and the diagram content is never logged:
// a log line is method, path, status, duration and a salted hash of the IP.
import { createHmac, randomBytes } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { isIP } from "node:net";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { RateLimiter } from "./ratelimit";
import { createServer, SERVER_VERSION } from "./server";

export type HttpConfig = {
  port: number;
  host: string;
  perMinute: number;
  perDay: number;
  globalPerMinute: number;
  maxBodyBytes: number;
  requestTimeoutMs: number;
  maxInFlight: number;
  /** read the client IP from CF-Connecting-IP (turn off when not behind Cloudflare) */
  trustCfHeader: boolean;
};

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
  trustCfHeader: !/^(0|false|no)$/i.test(env.SIGIL_MCP_TRUST_CF_HEADER ?? ""),
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
 * CF-Connecting-IP when it is there and is a single valid address, else the
 * socket address. X-Forwarded-For is never read: without Cloudflare in front,
 * anyone can write anything in it.
 */
export const clientKey = (req: IncomingMessage, trustCfHeader = true) => {
  const cf = trustCfHeader ? req.headers["cf-connecting-ip"] : undefined;
  if (typeof cf === "string" && isIP(cf.trim())) {
    return normalizeIp(cf);
  }
  return normalizeIp(req.socket.remoteAddress ?? "unknown");
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

const readJsonBody = (req: IncomingMessage, maxBytes: number) =>
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
        req.off("data", onData);
        resolve(b);
      }
    };
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
  limiter: RateLimiter;
  close: () => Promise<void>;
};

export const createRemoteServer = (
  config: HttpConfig = loadHttpConfig(),
  log: (line: string) => void = (line) => console.error(line),
  clock: () => number = Date.now,
): RemoteServer => {
  const limiter = new RateLimiter(
    {
      perMinute: config.perMinute,
      perDay: config.perDay,
      globalPerMinute: config.globalPerMinute,
    },
    clock,
  );
  limiter.start();
  // a salt that exists only in this process: the hash in the log cannot be
  // turned back into an address, nor matched across restarts
  const salt = randomBytes(16);
  const hashIp = (key: string) =>
    createHmac("sha256", salt).update(key).digest("hex").slice(0, 10);
  let inFlight = 0;

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
    const verdict = limiter.take(clientKey(req, config.trustCfHeader));
    if (!verdict.allowed) {
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

    inFlight++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        inFlight--;
      }
    };
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
    });

    try {
      const body = await readJsonBody(req, config.maxBodyBytes);
      if (!body.ok) {
        send(res, body.status, rpcError(body.status === 400 ? -32700 : -32000, body.message), { Connection: "close" });
        return;
      }
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body.json);
    } catch (e) {
      // only the error class: a message could quote the request
      log(JSON.stringify({ event: "error", name: (e as Error)?.name ?? "Error" }));
      send(res, 500, rpcError(-32603, "Internal error."));
    }
  };

  const server = createHttpServer((req, res) => {
    const started = clock();
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    let path = "other";
    try {
      const p = new URL(req.url ?? "/", "http://sigil").pathname;
      path = p === "/mcp" || p === "/healthz" ? p : "other";
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
            ip: hashIp(clientKey(req, config.trustCfHeader)),
          }),
        );
      }
    });

    if (path === "/healthz") {
      if (req.method === "GET" || req.method === "HEAD") {
        send(res, 200, JSON.stringify({ status: "ok", version: SERVER_VERSION }));
      } else {
        send(res, 405, "Method not allowed", { Allow: "GET, HEAD" });
      }
    } else if (path === "/mcp") {
      void handleMcp(req, res);
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
    limiter,
    close: () =>
      new Promise<void>((resolve) => {
        limiter.stop();
        server.close(() => resolve());
        server.closeIdleConnections?.();
      }),
  };
};

export const startHttp = async (config: HttpConfig = loadHttpConfig()) => {
  const remote = createRemoteServer(config);
  await new Promise<void>((resolve, reject) => {
    remote.server.once("error", reject);
    remote.server.listen(config.port, config.host, resolve);
  });
  console.error(`sigil-mcp ready (http) on ${config.host}:${config.port}, POST /mcp`);
  const stop = () => {
    // let in-flight requests finish, but not forever
    setTimeout(() => process.exit(0), 5_000).unref();
    void remote.close().then(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return remote;
};
