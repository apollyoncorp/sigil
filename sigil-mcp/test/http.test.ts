import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { wantsHttp } from "../src/http-flag";
import {
  bearerMatches,
  clientKey,
  createRemoteServer,
  configProblem,
  loadHttpConfig,
  normalizeIp,
  originMatches,
  toolOf,
  type HttpConfig,
  type RemoteServer,
} from "../src/http";
import { Store } from "../src/store";
import { createDiagram, mermaidToDiagram, REMOTE_PATH_ERROR } from "../src/tools";

const baseConfig: HttpConfig = {
  ...loadHttpConfig({}),
  port: 0,
  host: "127.0.0.1",
};

// a fixed clock (UTC noon, 30 s into the minute) so the fixed windows of the
// limiter never roll over in the middle of a test
const NOON = Date.parse("2026-06-15T12:00:30Z");
let now = NOON;
const clock = () => now;

let running: RemoteServer | undefined;
let logs: string[] = [];
const dirs: string[] = [];
const newDir = () => {
  const d = mkdtempSync(join(tmpdir(), "sigil-mcp-test-"));
  dirs.push(d);
  return d;
};

const start = async (over: Partial<HttpConfig> = {}) => {
  logs = [];
  const dataDir = over.dataDir ?? newDir();
  running = createRemoteServer({ ...baseConfig, dataDir, ...over }, (l) => logs.push(l), clock);
  await new Promise<void>((r) => running!.server.listen(0, "127.0.0.1", r));
  const { port } = running.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
};

beforeEach(() => {
  now = NOON;
});

afterEach(async () => {
  await running?.close();
  running = undefined;
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

const rpc = (id: number, method: string, params?: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });

const post = (
  url: string,
  body: string,
  headers: Record<string, string> = {},
) =>
  fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      // what Cloudflare adds; the tests that care send their own
      "cf-connecting-ip": "198.51.100.1",
      ...headers,
    },
    body,
  });

describe("routes and headers", () => {
  it("answers /healthz with 200", async () => {
    const url = await start();
    const res = await fetch(`${url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  it("answers every other route with 404", async () => {
    const url = await start();
    for (const path of ["/", "/mcp/", "/healthz/x", "/favicon.ico", "/mcp.json"]) {
      const res = await fetch(url + path);
      expect(res.status, path).toBe(404);
    }
  });

  it("takes only POST on /mcp", async () => {
    const url = await start();
    for (const method of ["GET", "DELETE", "PUT", "OPTIONS"]) {
      const res = await fetch(`${url}/mcp`, { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });

  it("sets nosniff and opens no CORS", async () => {
    const url = await start();
    for (const res of [
      await fetch(`${url}/healthz`),
      await fetch(`${url}/nope`),
      await post(url, rpc(1, "tools/list")),
    ]) {
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("refuses a body that is not JSON", async () => {
    const url = await start();
    const res = await post(url, "{nope");
    expect(res.status).toBe(400);
    const text = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "content-type": "text/plain", "cf-connecting-ip": "198.51.100.1" },
      body: "x",
    });
    expect(text.status).toBe(415);
  });
});

describe("rate limit", () => {
  it("answers 429 with Retry-After once the per-minute bucket is empty", async () => {
    const url = await start({ perMinute: 3 });
    for (let i = 0; i < 3; i++) {
      expect((await post(url, rpc(i, "tools/list"))).status).toBe(200);
    }
    const res = await post(url, rpc(9, "tools/list"));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(await res.json())).toContain("Rate limit");
    // health checks are not counted
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
  });

  it("limits per day as well", async () => {
    const url = await start({ perMinute: 100, perDay: 2 });
    await post(url, rpc(1, "tools/list"));
    await post(url, rpc(2, "tools/list"));
    const res = await post(url, rpc(3, "tools/list"));
    expect(res.status).toBe(429);
    // a day refills 2 tokens in 24h: the next one is ~12h away
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(3600);
  });

  it("limits each client by CF-Connecting-IP", async () => {
    const url = await start({ perMinute: 2 });
    const as = (ip: string) => post(url, rpc(1, "tools/list"), { "cf-connecting-ip": ip });
    expect((await as("203.0.113.1")).status).toBe(200);
    expect((await as("203.0.113.1")).status).toBe(200);
    expect((await as("203.0.113.1")).status).toBe(429);
    // another address is another bucket
    expect((await as("203.0.113.2")).status).toBe(200);
  });

  it("ignores X-Forwarded-For", async () => {
    // not behind Cloudflare: the socket address, whatever X-Forwarded-For says
    const url = await start({ perMinute: 2, trustCfHeader: false });
    const spoof = (n: number) =>
      post(url, rpc(n, "tools/list"), { "x-forwarded-for": `198.51.100.${n}` });
    expect((await spoof(1)).status).toBe(200);
    expect((await spoof(2)).status).toBe(200);
    expect((await spoof(3)).status).toBe(429);
  });

  it("can ignore CF-Connecting-IP (not behind Cloudflare)", async () => {
    const url = await start({ perMinute: 1, trustCfHeader: false });
    const as = (ip: string) => post(url, rpc(1, "tools/list"), { "cf-connecting-ip": ip });
    expect((await as("203.0.113.1")).status).toBe(200);
    expect((await as("203.0.113.2")).status).toBe(429);
  });

  it("has a global ceiling across clients", async () => {
    const url = await start({ globalPerMinute: 2 });
    const as = (ip: string) => post(url, rpc(1, "tools/list"), { "cf-connecting-ip": ip });
    expect((await as("203.0.113.1")).status).toBe(200);
    expect((await as("203.0.113.2")).status).toBe(200);
    const res = await as("203.0.113.3");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });
});

describe("limits on the request", () => {
  it("answers 413 above the body limit", async () => {
    const url = await start({ maxBodyBytes: 2000 });
    const res = await post(url, rpc(1, "tools/call", { name: "describe_format", arguments: { pad: "x".repeat(5000) } }));
    expect(res.status).toBe(413);
  });

  it("answers 413 when the body streams past the limit without a length", async () => {
    const url = await start({ maxBodyBytes: 2000 });
    const chunk = new TextEncoder().encode("x".repeat(1500));
    const body = new ReadableStream({
      start(c) {
        c.enqueue(chunk);
        c.enqueue(chunk);
        c.close();
      },
    });
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.1" },
      body,
      // @ts-expect-error node-only option for streamed bodies
      duplex: "half",
    });
    expect(res.status).toBe(413);
  });

  it("times out a request that never finishes", async () => {
    const url = await start({ requestTimeoutMs: 300 });
    const { port } = new URL(url);
    const reply = await new Promise<string>((resolve) => {
      const s = connect(Number(port), "127.0.0.1");
      let data = "";
      s.on("data", (d) => (data += d));
      s.on("close", () => resolve(data));
      s.write(
        "POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nCF-Connecting-IP: 198.51.100.1\r\nContent-Length: 500\r\n\r\n{",
      );
    });
    expect(reply).toMatch(/^HTTP\/1\.1 (504|408)/);
  });
});

describe("batch, slow body and per-client slots", () => {
  it("refuses a JSON-RPC batch with 400 -32600 and still debits the limit", async () => {
    const url = await start({ perMinute: 2 });
    const batch = JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    const first = await post(url, batch);
    expect(first.status).toBe(400);
    expect(await first.json()).toMatchObject({ error: { code: -32600, message: "Batch requests are not supported." } });
    expect((await post(url, batch)).status).toBe(400);
    // two refused batches used the two requests of the minute
    expect((await post(url, batch)).status).toBe(429);
  });

  it("answers 408 and closes when the body is too slow, and frees the slot", async () => {
    const url = await start({ bodyTimeoutMs: 200, maxInFlightPerIp: 1 });
    const { port } = new URL(url);
    const reply = await new Promise<string>((resolve) => {
      const s = connect(Number(port), "127.0.0.1");
      let data = "";
      s.on("data", (d) => (data += d));
      s.on("close", () => resolve(data));
      s.write(
        "POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nCF-Connecting-IP: 198.51.100.1\r\nContent-Length: 500\r\n\r\n{",
      );
    });
    expect(reply).toMatch(/^HTTP\/1\.1 408/);
    expect(reply.toLowerCase()).toContain("connection: close");
    // the slot is back (cap of 1 for this client)
    expect((await post(url, rpc(1, "tools/list"))).status).toBe(200);
  });

  it("caps simultaneous requests per client before the body is read", async () => {
    const url = await start({ maxInFlightPerIp: 2, bodyTimeoutMs: 3000 });
    const { port } = new URL(url);
    const hang = (ip: string) => {
      const s = connect(Number(port), "127.0.0.1");
      s.on("error", () => {});
      s.write(
        `POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nCF-Connecting-IP: ${ip}\r\nContent-Length: 500\r\n\r\n{`,
      );
      return s;
    };
    const held = [hang("198.51.100.1"), hang("198.51.100.1")];
    await new Promise((r) => setTimeout(r, 150));
    const third = await post(url, rpc(1, "tools/list"), { "cf-connecting-ip": "198.51.100.1" });
    expect(third.status).toBe(503);
    expect(third.headers.get("retry-after")).toBe("1");
    // another client is not affected
    expect((await post(url, rpc(2, "tools/list"), { "cf-connecting-ip": "198.51.100.2" })).status).toBe(200);
    // the refused request was not debited and held no slot; closing frees them
    for (const s of held) s.destroy();
    await new Promise((r) => setTimeout(r, 150));
    expect((await post(url, rpc(3, "tools/list"), { "cf-connecting-ip": "198.51.100.1" })).status).toBe(200);
  });
});

describe("remote tools", () => {
  const connectClient = async (url: string) => {
    const client = new Client({ name: "http-test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
        requestInit: { headers: { "cf-connecting-ip": "198.51.100.1" } },
      }),
    );
    return client;
  };

  it("draws and returns the diagram and open_url, no path", async () => {
    const url = await start();
    const client = await connectClient(url);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "create_diagram",
      "describe_format",
      "mermaid_to_diagram",
    ]);
    const res: any = await client.callTool({
      name: "create_diagram",
      arguments: {
        elements: [
          { type: "rectangle", id: "a", x: 0, y: 0, label: { text: "Alpha" } },
          { type: "rectangle", id: "b", x: 300, y: 0, label: { text: "Beta" } },
          { type: "arrow", start: { id: "a" }, end: { id: "b" } },
        ],
      },
    });
    expect(res.isError).toBeFalsy();
    const summary = JSON.parse(res.content[0].text);
    expect(summary.written).toBeUndefined();
    expect(summary.open_url).toMatch(/^https:\/\/sigil\.apollyoncorp\.com\/#data=/);
    expect(JSON.parse(res.content[1].text).type).toBe("excalidraw");

    const mm: any = await client.callTool({
      name: "mermaid_to_diagram",
      arguments: { mermaid: "flowchart TD\n  A[Start] --> B[End]" },
    });
    expect(mm.isError).toBeFalsy();
    expect(JSON.parse(mm.content[0].text).open_url).toBeTruthy();
    await client.close();
  });

  it("refuses path with a clear message and writes nothing", async () => {
    const url = await start();
    const client = await connectClient(url);
    const target = "/tmp/sigil-remote-must-not-exist.excalidraw";
    for (const call of [
      {
        name: "create_diagram",
        arguments: { elements: [{ type: "rectangle", x: 0, y: 0 }], path: target },
      },
      {
        name: "mermaid_to_diagram",
        arguments: { mermaid: "flowchart TD\n  A --> B", path: target },
      },
    ]) {
      const res: any = await client.callTool(call);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("path is not accepted by the remote server");
    }
    const { existsSync } = await import("node:fs");
    expect(existsSync(target)).toBe(false);
    await client.close();
  });

  it("never logs the diagram content", async () => {
    const url = await start();
    const client = await connectClient(url);
    await client.callTool({
      name: "create_diagram",
      arguments: {
        elements: [{ type: "rectangle", x: 0, y: 0, label: { text: "TOP-SECRET-LABEL" } }],
      },
    });
    await client.close();
    expect(logs.length).toBeGreaterThan(0);
    const all = logs.join("\n");
    expect(all).not.toContain("TOP-SECRET-LABEL");
    expect(all).not.toContain("127.0.0.1");
    for (const line of logs) {
      expect(Object.keys(JSON.parse(line)).sort()).toEqual(["ip", "method", "ms", "path", "status", "t"]);
    }
  });
});

describe("tools in remote mode", () => {
  it("refuse path before doing anything else", async () => {
    const a = await createDiagram({ elements: [], path: "/tmp/x.excalidraw" }, { remote: true });
    expect(a).toEqual({ ok: false, errors: [REMOTE_PATH_ERROR] });
    const b = await mermaidToDiagram({ mermaid: "", path: "x.excalidraw" }, { remote: true });
    expect(b).toEqual({ ok: false, errors: [REMOTE_PATH_ERROR] });
  });
});

describe("client address", () => {
  it("collapses IPv4-mapped IPv6 and keys IPv6 by /64", () => {
    expect(normalizeIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeIp("203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeIp("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(normalizeIp("2001:db8:1:2::9")).toBe("2001:db8:1:2::/64");
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8:0:0::/64");
  });

  it("reads CF-Connecting-IP, else the socket, never X-Forwarded-For", () => {
    const req = (headers: Record<string, string>, remote = "10.0.0.9") =>
      ({ headers, socket: { remoteAddress: remote } }) as any;
    expect(clientKey(req({ "cf-connecting-ip": "203.0.113.5", "x-forwarded-for": "1.1.1.1" }))).toBe("203.0.113.5");
    // behind Cloudflare, no valid header means no client: never the socket
    expect(clientKey(req({ "x-forwarded-for": "1.1.1.1" }))).toBeUndefined();
    expect(clientKey(req({}))).toBeUndefined();
    expect(clientKey(req({ "cf-connecting-ip": "1.1.1.1, 2.2.2.2" }))).toBeUndefined();
    expect(clientKey(req({ "cf-connecting-ip": "not-an-ip" }))).toBeUndefined();
    // not behind Cloudflare: the socket, and the header is ignored
    expect(clientKey(req({ "cf-connecting-ip": "203.0.113.5" }), false)).toBe("10.0.0.9");
    expect(clientKey(req({ "x-forwarded-for": "1.1.1.1" }), false)).toBe("10.0.0.9");
  });
});

describe("configuration", () => {
  it("has the documented defaults and reads the environment", () => {
    expect(loadHttpConfig({})).toMatchObject({
      port: 8080,
      perMinute: 30,
      perDay: 500,
      globalPerMinute: 600,
      maxBodyBytes: 1_048_576,
      trustCfHeader: true,
      statsToken: undefined,
    });
    expect(loadHttpConfig({}).dataDir).toMatch(/\.sigil-mcp$/);
    expect(
      loadHttpConfig({
        PORT: "9000",
        SIGIL_MCP_RATE_PER_MINUTE: "5",
        SIGIL_MCP_TRUST_CF_HEADER: "0",
        SIGIL_MCP_DATA_DIR: "/data",
        SIGIL_MCP_STATS_TOKEN: "a-long-enough-token",
        SIGIL_MCP_ORIGIN_SECRET: "an-origin-secret-123",
      }),
    ).toMatchObject({
      port: 9000,
      perMinute: 5,
      trustCfHeader: false,
      dataDir: "/data",
      statsToken: "a-long-enough-token",
      originSecret: "an-origin-secret-123",
    });
    expect(loadHttpConfig({}).originSecret).toBeUndefined();
    expect(loadHttpConfig({ SIGIL_MCP_ORIGIN_SECRET: "  " }).originSecret).toBeUndefined();
    expect(loadHttpConfig({})).toMatchObject({ maxInFlightPerIp: 4, bodyTimeoutMs: 5000, allowNoOriginSecret: false });
    expect(
      loadHttpConfig({
        SIGIL_MCP_MAX_IN_FLIGHT_PER_IP: "2",
        SIGIL_MCP_BODY_TIMEOUT_MS: "900",
        SIGIL_MCP_ALLOW_NO_ORIGIN_SECRET: "1",
      }),
    ).toMatchObject({ maxInFlightPerIp: 2, bodyTimeoutMs: 900, allowNoOriginSecret: true });
    // a short token would be guessable: /stats stays off
    expect(loadHttpConfig({ SIGIL_MCP_STATS_TOKEN: "short" }).statsToken).toBeUndefined();
    expect(loadHttpConfig({ SIGIL_MCP_RATE_PER_DAY: "abc" }).perDay).toBe(500);
  });

  it("refuses to start without a usable origin secret unless that is allowed", () => {
    expect(configProblem(loadHttpConfig({}))).toMatch(/SIGIL_MCP_ORIGIN_SECRET is not set/);
    expect(configProblem(loadHttpConfig({ SIGIL_MCP_ORIGIN_SECRET: "   " }))).toMatch(/not set/);
    expect(configProblem(loadHttpConfig({ SIGIL_MCP_ORIGIN_SECRET: "short" }))).toMatch(/shorter than 16/);
    // the opt-out covers a missing secret, not a weak one
    expect(
      configProblem(loadHttpConfig({ SIGIL_MCP_ORIGIN_SECRET: "short", SIGIL_MCP_ALLOW_NO_ORIGIN_SECRET: "1" })),
    ).toMatch(/shorter than 16/);
    expect(configProblem(loadHttpConfig({ SIGIL_MCP_ALLOW_NO_ORIGIN_SECRET: "1" }))).toBeUndefined();
    expect(configProblem(loadHttpConfig({ SIGIL_MCP_ORIGIN_SECRET: "an-origin-secret-123" }))).toBeUndefined();
  });

  it("turns on with --http or SIGIL_MCP_HTTP", () => {
    expect(wantsHttp(["node", "x", "--http"], {})).toBe(true);
    expect(wantsHttp(["node", "x"], { SIGIL_MCP_HTTP: "1" })).toBe(true);
    expect(wantsHttp(["node", "x"], {})).toBe(false);
    expect(wantsHttp(["node", "x"], { SIGIL_MCP_HTTP: "0" })).toBe(false);
  });
});

const limits = { perMinute: 30, perDay: 500, globalPerMinute: 600 };
const DAY_MS = 86_400_000;
const call = (url: string, name: string, args: unknown, ip: string) =>
  post(url, rpc(1, "tools/call", { name, arguments: args }), { "cf-connecting-ip": ip });

// the server records a request when its response closes, which can land a
// moment after the client has the reply
const eventually = async (check: () => void) => {
  let last: unknown;
  for (let i = 0; i < 50; i++) {
    try {
      return check();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  throw last;
};

describe("limits survive a restart", () => {
  it("keeps the daily count across two servers on the same file", async () => {
    const dataDir = newDir();
    let url = await start({ perDay: 3, dataDir });
    const as = () => post(url, rpc(1, "tools/list"), { "cf-connecting-ip": "203.0.113.9" });
    for (let i = 0; i < 3; i++) {
      expect((await as()).status).toBe(200);
    }
    expect((await as()).status).toBe(429);

    // "restart": a new server (new process in production) on the same folder
    await running!.close();
    running = undefined;
    url = await start({ perDay: 3, dataDir });
    // a few minutes later, so only the day limit can be what answers
    now += 5 * 60_000;
    const after = await as();
    expect(after.status).toBe(429);
    expect(JSON.stringify(await after.json())).toContain("(day)");
    // another client is unaffected
    const other = await post(url, rpc(2, "tools/list"), { "cf-connecting-ip": "203.0.113.10" });
    expect(other.status).toBe(200);
    // the next UTC day starts a fresh count
    now = Date.parse("2026-06-16T00:00:01Z");
    expect((await as()).status).toBe(200);
  });

  it("keeps the global ceiling across a restart", async () => {
    const dataDir = newDir();
    let url = await start({ globalPerMinute: 2, dataDir });
    const as = (ip: string) => post(url, rpc(1, "tools/list"), { "cf-connecting-ip": ip });
    expect((await as("203.0.113.1")).status).toBe(200);
    expect((await as("203.0.113.2")).status).toBe(200);
    await running!.close();
    running = undefined;
    url = await start({ globalPerMinute: 2, dataDir });
    const res = await as("203.0.113.3");
    expect(res.status).toBe(429);
    expect(JSON.stringify(await res.json())).toContain("capacity");
    now += 60_000; // the next minute window
    expect((await as("203.0.113.3")).status).toBe(200);
  });

  it("limits per minute with a fixed window and a Retry-After to its end", async () => {
    const url = await start({ perMinute: 2 });
    const as = () => post(url, rpc(1, "tools/list"), { "cf-connecting-ip": "203.0.113.9" });
    await as();
    await as();
    const res = await as();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30"); // 12:00:30 -> 12:01:00
  });

  it("shares the counters between two live servers on one file", () => {
    const dir = newDir();
    const a = new Store(dir, { ...limits, perDay: 2 }, clock);
    const b = new Store(dir, { ...limits, perDay: 2 }, clock);
    expect(a.take("k").allowed).toBe(true);
    expect(b.take("k").allowed).toBe(true);
    expect(a.take("k")).toMatchObject({ allowed: false, scope: "day" });
    a.close();
    b.close();
  });
});

describe("rows written by refused requests", () => {
  it("a request refused by the global cap leaves no row and no distinct count", () => {
    const store = new Store(newDir(), { perMinute: 10, perDay: 10, globalPerMinute: 1 }, clock);
    const a = store.hash("198.51.100.1");
    const b = store.hash("198.51.100.2");
    expect(store.take(a)).toEqual({ allowed: true });
    expect(store.take(b)).toMatchObject({ allowed: false, scope: "global" });
    expect(store.stats(1).total.distinct_ip_days).toBe(1);
    expect(store.take(b)).toMatchObject({ allowed: false, scope: "global" });
    expect(store.stats(1).total.distinct_ip_days).toBe(1);
    // once the next minute opens, b is counted when it is finally allowed
    now += 60_000;
    expect(store.take(b)).toEqual({ allowed: true });
    expect(store.stats(1).total.distinct_ip_days).toBe(2);
    store.close();
  });

  it("indexes the minute buckets, on a new or an existing database", () => {
    const dir = newDir();
    new Store(dir, limits, clock).close();
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(join(dir, "sigil-mcp.db"));
    db.exec("DROP INDEX rate_minute_bucket");
    db.close();
    new Store(dir, limits, clock).close(); // reopens an old database
    const check = new DatabaseSync(join(dir, "sigil-mcp.db"));
    const plan = check.prepare("EXPLAIN QUERY PLAN DELETE FROM rate_minute WHERE bucket < 5").all();
    check.close();
    expect(JSON.stringify(plan)).toContain("rate_minute_bucket");
  });
});

describe("salt and what is stored", () => {
  it("keeps the same salt across restarts and a different one per file", () => {
    const dir = newDir();
    const first = new Store(dir, limits, clock);
    const h1 = first.hash("203.0.113.9");
    first.close();
    const second = new Store(dir, limits, clock);
    expect(second.hash("203.0.113.9")).toBe(h1);
    expect(second.hash("203.0.113.10")).not.toBe(h1);
    expect(h1).toMatch(/^[0-9a-f]{32}$/);
    second.close();
    const other = new Store(newDir(), limits, clock);
    expect(other.hash("203.0.113.9")).not.toBe(h1);
    other.close();
  });

  it("writes no clear IP address and no diagram content into the database", async () => {
    const dataDir = newDir();
    const url = await start({ dataDir });
    const ips = ["203.0.113.77", "2001:db8:abcd:1234:1:2:3:4"];
    for (const ip of ips) {
      await call(url, "create_diagram", { elements: [{ type: "rectangle", x: 0, y: 0, label: { text: "TOP-SECRET-LABEL" } }] }, ip);
      await call(url, "describe_format", {}, ip);
    }
    // and one that is limited, one that is not a tool call
    await post(url, rpc(1, "tools/list"));
    await eventually(() => expect(running!.store.stats().total.calls).toBe(5));
    await running!.close();
    running = undefined;

    const files = readdirSync(dataDir);
    expect(files).toContain("sigil-mcp.db");
    let bytes = 0;
    for (const f of files) {
      const buf = readFileSync(join(dataDir, f));
      bytes += buf.length;
      const text = buf.toString("latin1");
      for (const needle of [...ips, "2001:db8", "203.0.113", "127.0.0.1", "TOP-SECRET-LABEL", "abcd:1234"]) {
        expect(text.includes(needle), `${f} contains ${needle}`).toBe(false);
      }
    }
    expect(bytes).toBeGreaterThan(0);
    // what is there for a client is the hash
    const store = new Store(dataDir, limits, clock);
    expect(store.hash("203.0.113.77")).toMatch(/^[0-9a-f]{32}$/);
    store.close();
  });

  it("sweeps old minute rows and per-client day rows, keeps the aggregates", async () => {
    const dir = newDir();
    const store = new Store(dir, limits, clock);
    store.take("k");
    store.record("create_diagram", "ok");
    const { DatabaseSync } = (await import("node:module")).createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const peek = new DatabaseSync(join(dir, "sigil-mcp.db"));
    const count = (t: string) => Number((peek.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n);
    expect([count("rate_minute"), count("rate_day"), count("rate_global")]).toEqual([1, 1, 1]);

    now += 5 * 60_000;
    store.sweep();
    expect(count("rate_minute")).toBe(1); // recent enough to keep
    now += 6 * 60_000;
    store.sweep();
    expect([count("rate_minute"), count("rate_global")]).toEqual([0, 0]);
    expect(count("rate_day")).toBe(1);

    now = NOON + 2 * DAY_MS; // still "today - 2 days": kept
    store.sweep();
    expect(count("rate_day")).toBe(1);
    now = NOON + 3 * DAY_MS;
    store.sweep();
    expect(count("rate_day")).toBe(0);
    // the day's aggregates (and the distinct count) outlive the per-client rows
    expect(count("usage")).toBe(1);
    expect(count("usage_day")).toBe(1);
    peek.close();
    store.close();
  });

  it("keeps usage for 90 days; /stats looks at the last 30", () => {
    const store = new Store(newDir(), limits, clock);
    store.take("k");
    store.record("describe_format", "ok");
    now = NOON + 40 * DAY_MS;
    store.take("k2");
    store.record("create_diagram", "error");
    const s = store.stats(30);
    expect(s.days.map((d) => d.day)).toEqual(["2026-07-25"]);
    expect(s.days[0].tools.create_diagram).toEqual({ calls: 1, rate_limited: 0, errors: 1 });
    expect(store.stats(90).days).toHaveLength(2);
    now = NOON + 91 * DAY_MS;
    store.sweep();
    expect(store.stats(365).days).toHaveLength(1);
    store.close();
  });
});

describe("usage and /stats", () => {
  const TOKEN = "test-token-0123456789";

  it("counts calls, 429s, errors and distinct clients per tool, without content", async () => {
    const url = await start({ perMinute: 4, statsToken: TOKEN });
    const ok = { elements: [{ type: "rectangle", x: 0, y: 0, label: { text: "A" } }] };
    expect((await call(url, "describe_format", {}, "203.0.113.1")).status).toBe(200);
    expect((await call(url, "create_diagram", ok, "203.0.113.1")).status).toBe(200);
    expect((await call(url, "create_diagram", { elements: [] }, "203.0.113.1")).status).toBe(200); // tool error
    expect((await post(url, rpc(1, "tools/list"), { "cf-connecting-ip": "203.0.113.1" })).status).toBe(200);
    expect((await call(url, "create_diagram", ok, "203.0.113.1")).status).toBe(429);
    expect((await call(url, "describe_format", {}, "203.0.113.2")).status).toBe(200);
    // an unknown tool name is counted as "other", never stored as sent
    await call(url, "tool-with-a-very-odd-name", {}, "203.0.113.2");

    const get = () =>
      fetch(`${url}/stats`, { headers: { authorization: `Bearer ${TOKEN}` } });
    await eventually(async () => expect(running!.store.stats().total.calls).toBe(7));
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const stats = await res.json();
    expect(stats.since).toBe("2026-05-17");
    expect(stats.until).toBe("2026-06-15");
    expect(stats.days).toHaveLength(1);
    const day = stats.days[0];
    expect(day.day).toBe("2026-06-15");
    expect(day.distinct_ips).toBe(2);
    expect(day.tools.create_diagram).toEqual({ calls: 3, rate_limited: 1, errors: 1 });
    expect(day.tools.describe_format).toEqual({ calls: 2, rate_limited: 0, errors: 0 });
    expect(day.tools.mermaid_to_diagram).toEqual({ calls: 0, rate_limited: 0, errors: 0 });
    // tools/list is fine; the unknown tool name is an error
    expect(day.tools.other).toEqual({ calls: 2, rate_limited: 0, errors: 1 });
    expect(day.total).toEqual({ calls: 7, rate_limited: 1, errors: 2 });
    expect(stats.total).toEqual({ calls: 7, rate_limited: 1, errors: 2, distinct_ip_days: 2 });
    const text = JSON.stringify(stats);
    expect(text).not.toContain("203.0.113");
    expect(text).not.toContain("odd-name");
  });

  it("answers /stats only with the right Bearer token", async () => {
    const url = await start({ statsToken: TOKEN });
    expect((await fetch(`${url}/stats`)).status).toBe(401);
    expect((await fetch(`${url}/stats`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect((await fetch(`${url}/stats`, { headers: { authorization: `Basic ${TOKEN}` } })).status).toBe(401);
    expect((await fetch(`${url}/stats`, { headers: { authorization: TOKEN } })).status).toBe(401);
    const denied = await fetch(`${url}/stats`);
    expect(denied.headers.get("www-authenticate")).toBe("Bearer");
    const ok = await fetch(`${url}/stats`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(ok.status).toBe(200);
    const post405 = await fetch(`${url}/stats`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(post405.status).toBe(405);
    // the token never shows up in the log
    expect(logs.join("\n")).not.toContain(TOKEN);
  });

  it("is a 404 when no token is configured, whatever is sent", async () => {
    const url = await start();
    expect((await fetch(`${url}/stats`)).status).toBe(404);
    expect((await fetch(`${url}/stats`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
  });

  it("compares the token in constant time (same-length digests)", () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(bearerMatches(`Bearer `, TOKEN)).toBe(false);
    expect(bearerMatches(undefined, TOKEN)).toBe(false);
  });

  it("reads the tool from the JSON-RPC body", () => {
    const callOf = (name: unknown) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name } });
    expect(toolOf(callOf("create_diagram"))).toBe("create_diagram");
    expect(toolOf(callOf("mermaid_to_diagram"))).toBe("mermaid_to_diagram");
    expect(toolOf(callOf("x"))).toBe("other");
    expect(toolOf(callOf({ a: 1 }))).toBe("other");
    expect(toolOf({ method: "tools/list" })).toBe("other");
    expect(toolOf([{ method: "initialize" }, callOf("describe_format")])).toBe("describe_format");
    expect(toolOf(null)).toBe("other");
    expect(toolOf("text")).toBe("other");
  });
});

describe("when the database fails", () => {
  it("refuses with 503 (fails closed), logs no content, and says so on /healthz and /stats", async () => {
    const url = await start({ statsToken: "test-token-0123456789" });
    const ok = (label: string) =>
      call(url, "create_diagram", { elements: [{ type: "rectangle", x: 0, y: 0, label: { text: label } }] }, "203.0.113.5");
    expect((await ok("FIRST")).status).toBe(200);

    running!.store.close(); // as if the disk went away

    const res = await ok("TOP-SECRET-LABEL");
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(JSON.stringify(await res.json())).toContain("temporarily unavailable");
    // not even a tools/list goes through
    expect((await post(url, rpc(2, "tools/list"))).status).toBe(503);

    const all = logs.join("\n");
    expect(all).toContain('"event":"store_error"');
    expect(all).not.toContain("TOP-SECRET-LABEL");
    expect(all).not.toContain("203.0.113.5");

    const health = await fetch(`${url}/healthz`);
    // 503, so the platform healthcheck (Dockerfile.remote) sees the failure
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ store: "error" });
    const stats = await fetch(`${url}/stats`, { headers: { authorization: "Bearer test-token-0123456789" } });
    expect(stats.status).toBe(503);
  });

  it("refuses with 503 when a table is gone, too", async () => {
    const dataDir = newDir();
    const url = await start({ dataDir });
    const { DatabaseSync } = (await import("node:module")).createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const other = new DatabaseSync(join(dataDir, "sigil-mcp.db"));
    other.exec("DROP TABLE rate_minute");
    other.close();
    expect((await post(url, rpc(1, "tools/list"))).status).toBe(503);
  });

  it("does not start when the data folder cannot be used", () => {
    const dir = newDir();
    const file = join(dir, "a-file");
    // a file where the folder should be
    writeFileSync(file, "x");
    expect(() => createRemoteServer({ ...baseConfig, dataDir: join(file, "sub") }, () => {}, clock)).toThrow();
  });
});

describe("who may reach /mcp", () => {
  const SECRET = "origin-secret-0123456789";
  const bare = (url: string, headers: Record<string, string>) =>
    fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: rpc(1, "tools/list"),
    });

  it("refuses /mcp with 403 when CF-Connecting-IP is missing or invalid, never using the socket", async () => {
    const url = await start({ perMinute: 100 });
    for (const headers of [{}, { "cf-connecting-ip": "not-an-ip" }, { "cf-connecting-ip": "1.1.1.1, 2.2.2.2" }, { "x-forwarded-for": "203.0.113.1" }]) {
      const res = await bare(url, headers);
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(JSON.stringify(await res.json())).toContain("Forbidden");
    }
    // refused requests are not usage
    expect(running!.store.stats().total.calls).toBe(0);
    // with a valid header it works
    expect((await bare(url, { "cf-connecting-ip": "203.0.113.1" })).status).toBe(200);
    // and the log has the refusals, with no clear address
    const all = logs.join("\n");
    expect(logs.filter((l) => JSON.parse(l).status === 403)).toHaveLength(4);
    expect(all).not.toContain("127.0.0.1");
    expect(all).not.toContain("203.0.113.1");
  });

  it("keeps /healthz free of any header", async () => {
    const url = await start({ originSecret: SECRET });
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    expect((await fetch(`${url}/healthz`, { method: "HEAD" })).status).toBe(200);
  });

  it("uses the socket address when not told to trust CF-Connecting-IP", async () => {
    const url = await start({ perMinute: 1, trustCfHeader: false });
    // no header needed, and a forged one does not make another client
    expect((await bare(url, {})).status).toBe(200);
    expect((await bare(url, { "cf-connecting-ip": "203.0.113.50" })).status).toBe(429);
    expect((await bare(url, {})).status).toBe(429);
  });

  it("with an origin secret, /mcp needs X-Sigil-Origin-Auth (wrong, missing, right)", async () => {
    const url = await start({ originSecret: SECRET, perMinute: 100 });
    const cf = { "cf-connecting-ip": "203.0.113.1" };
    expect((await bare(url, cf)).status).toBe(403);
    expect((await bare(url, { ...cf, "x-sigil-origin-auth": "wrong" })).status).toBe(403);
    expect((await bare(url, { ...cf, "x-sigil-origin-auth": SECRET + "x" })).status).toBe(403);
    expect((await bare(url, { ...cf, "x-sigil-origin-auth": "" })).status).toBe(403);
    expect((await bare(url, { ...cf, "x-sigil-origin-auth": SECRET })).status).toBe(200);
    // the secret does not replace the client address
    expect((await bare(url, { "x-sigil-origin-auth": SECRET })).status).toBe(403);
    // the secret is checked even when the address is not trusted
    const open = await start({ originSecret: SECRET, trustCfHeader: false });
    expect((await bare(open, {})).status).toBe(403);
    expect((await bare(open, { "x-sigil-origin-auth": SECRET })).status).toBe(200);
  });

  it("with an origin secret, /stats needs it too, then the Bearer token", async () => {
    const TOKEN = "test-token-0123456789";
    const url = await start({ originSecret: SECRET, statsToken: TOKEN });
    const bearer = { authorization: `Bearer ${TOKEN}` };
    expect((await fetch(`${url}/stats`, { headers: bearer })).status).toBe(403);
    expect((await fetch(`${url}/stats`, { headers: { ...bearer, "x-sigil-origin-auth": "wrong" } })).status).toBe(403);
    expect((await fetch(`${url}/stats`, { headers: { "x-sigil-origin-auth": SECRET } })).status).toBe(401);
    expect((await fetch(`${url}/stats`, { headers: { ...bearer, "x-sigil-origin-auth": SECRET } })).status).toBe(200);
  });

  it("changes nothing without the secret, and never logs it", async () => {
    const url = await start({ perMinute: 100 });
    // a header that nobody asked for is simply ignored
    expect((await bare(url, { "cf-connecting-ip": "203.0.113.1", "x-sigil-origin-auth": "anything" })).status).toBe(200);
    const guarded = await start({ originSecret: SECRET });
    await bare(guarded, { "cf-connecting-ip": "203.0.113.1", "x-sigil-origin-auth": SECRET });
    await bare(guarded, { "cf-connecting-ip": "203.0.113.1", "x-sigil-origin-auth": "WRONG-VALUE-IN-LOG" });
    const all = logs.join("\n");
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain("WRONG-VALUE-IN-LOG");
  });

  it("compares the secret in constant time (same-length digests)", () => {
    expect(originMatches(SECRET, SECRET)).toBe(true);
    expect(originMatches(SECRET + "x", SECRET)).toBe(false);
    expect(originMatches("", SECRET)).toBe(false);
    expect(originMatches(undefined, SECRET)).toBe(false);
    expect(originMatches([SECRET], SECRET)).toBe(false);
  });
});
