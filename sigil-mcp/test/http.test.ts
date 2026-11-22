import { connect, type AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import { wantsHttp } from "../src/http-flag";
import {
  clientKey,
  createRemoteServer,
  loadHttpConfig,
  normalizeIp,
  type HttpConfig,
  type RemoteServer,
} from "../src/http";
import { RateLimiter } from "../src/ratelimit";
import { createDiagram, mermaidToDiagram, REMOTE_PATH_ERROR } from "../src/tools";

const baseConfig: HttpConfig = {
  ...loadHttpConfig({}),
  port: 0,
  host: "127.0.0.1",
};

let running: RemoteServer | undefined;
let logs: string[] = [];

const start = async (over: Partial<HttpConfig> = {}) => {
  logs = [];
  running = createRemoteServer({ ...baseConfig, ...over }, (l) => logs.push(l));
  await new Promise<void>((r) => running!.server.listen(0, "127.0.0.1", r));
  const { port } = running.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
};

afterEach(async () => {
  await running?.close();
  running = undefined;
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
      headers: { "content-type": "text/plain" },
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
    const url = await start({ perMinute: 2 });
    const spoof = (n: number) =>
      post(url, rpc(n, "tools/list"), { "x-forwarded-for": `198.51.100.${n}` });
    expect((await spoof(1)).status).toBe(200);
    expect((await spoof(2)).status).toBe(200);
    expect((await spoof(3)).status).toBe(429);
  });

  it("falls back to the socket when CF-Connecting-IP is not an address", async () => {
    const url = await start({ perMinute: 1 });
    const bad = (n: number) =>
      post(url, rpc(n, "tools/list"), { "cf-connecting-ip": `not-an-ip-${n}` });
    expect((await bad(1)).status).toBe(200);
    expect((await bad(2)).status).toBe(429);
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
      headers: { "content-type": "application/json" },
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
        "POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{",
      );
    });
    expect(reply).toMatch(/^HTTP\/1\.1 (504|408)/);
  });
});

describe("remote tools", () => {
  const connectClient = async (url: string) => {
    const client = new Client({ name: "http-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
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

describe("RateLimiter", () => {
  it("refills over time", () => {
    let now = 0;
    const l = new RateLimiter({ perMinute: 60, perDay: 1000, globalPerMinute: 1000 }, () => now);
    for (let i = 0; i < 60; i++) {
      expect(l.take("a").allowed).toBe(true);
    }
    const denied = l.take("a");
    expect(denied).toMatchObject({ allowed: false, scope: "minute", retryAfterSec: 1 });
    now += 1000; // 60/min = 1 per second
    expect(l.take("a").allowed).toBe(true);
    expect(l.take("a").allowed).toBe(false);
  });

  it("sweeps idle clients and caps how many it remembers", () => {
    let now = 0;
    const l = new RateLimiter(
      { perMinute: 5, perDay: 5, globalPerMinute: 1000, maxClients: 3 },
      () => now,
    );
    for (const k of ["a", "b", "c", "d"]) {
      l.take(k);
    }
    expect(l.size).toBe(3);
    now += 86_400_000;
    l.sweep();
    expect(l.size).toBe(0);
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
    expect(clientKey(req({ "x-forwarded-for": "1.1.1.1" }))).toBe("10.0.0.9");
    expect(clientKey(req({ "cf-connecting-ip": "1.1.1.1, 2.2.2.2" }))).toBe("10.0.0.9");
    expect(clientKey(req({ "cf-connecting-ip": "203.0.113.5" }), false)).toBe("10.0.0.9");
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
    });
    expect(
      loadHttpConfig({
        PORT: "9000",
        SIGIL_MCP_RATE_PER_MINUTE: "5",
        SIGIL_MCP_TRUST_CF_HEADER: "0",
      }),
    ).toMatchObject({ port: 9000, perMinute: 5, trustCfHeader: false });
    expect(loadHttpConfig({ SIGIL_MCP_RATE_PER_DAY: "abc" }).perDay).toBe(500);
  });

  it("turns on with --http or SIGIL_MCP_HTTP", () => {
    expect(wantsHttp(["node", "x", "--http"], {})).toBe(true);
    expect(wantsHttp(["node", "x"], { SIGIL_MCP_HTTP: "1" })).toBe(true);
    expect(wantsHttp(["node", "x"], {})).toBe(false);
    expect(wantsHttp(["node", "x"], { SIGIL_MCP_HTTP: "0" })).toBe(false);
  });
});
