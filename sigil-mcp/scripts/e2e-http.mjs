// End-to-end for the remote mode: starts the BUILT server with --http on a
// free port, talks to it with the SDK's Streamable HTTP client, and checks
// the plain routes and the rate limit with fetch. It also restarts the server
// on the same data folder and checks that the limit and the salt survived, and
// reads /stats and the SQLite file (no clear IP address in it).
//
//   node scripts/e2e-http.mjs
//
// The local server runs the way production does: it trusts CF-Connecting-IP and
// wants the origin secret, so this script plays Cloudflare and sends both.
//
// SIGIL_MCP_URL=https://mcp.example.org skips the local server and runs the
// same checks against a deployed one (the rate-limit, restart, stats and
// header checks are skipped there). Against a deployed server NO
// CF-Connecting-IP and no origin header are sent: Cloudflare adds them, and
// refuses a client that sends CF-Connecting-IP itself.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "../dist/sigil-mcp.mjs");

const assert = (cond, msg) => {
  if (!cond) {
    console.error("E2E-HTTP FAIL:", msg);
    process.exit(1);
  }
};

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

let child;
let base = process.env.SIGIL_MCP_URL?.replace(/\/+$/, "");
const local = !base;
const dataDir = mkdtempSync(join(tmpdir(), "sigil-mcp-e2e-data-"));
const STATS_TOKEN = "e2e-stats-token-0123456789";
const ORIGIN_SECRET = "e2e-origin-secret-0123456789";
const CLIENT_IP = "203.0.113.5";
// what Cloudflare would add in front of the local server
const edge = local
  ? { "cf-connecting-ip": CLIENT_IP, "x-sigil-origin-auth": ORIGIN_SECRET }
  : {};
let port;

const startServer = async () => {
  child = spawn(process.execPath, [dist, "--http"], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      SIGIL_MCP_RATE_PER_MINUTE: "100",
      SIGIL_MCP_RATE_PER_DAY: "25",
      SIGIL_MCP_DATA_DIR: dataDir,
      SIGIL_MCP_STATS_TOKEN: STATS_TOKEN,
      SIGIL_MCP_ORIGIN_SECRET: ORIGIN_SECRET,
    },
    stdio: "ignore",
  });
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      // not listening yet
    }
    assert(i < 100, "server did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
};
const stopServer = () =>
  new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });

if (local) {
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  // without an origin secret the server must refuse to start (exit 1) ...
  const noSecret = (extra = {}) =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, [dist, "--http"], {
        env: { ...process.env, PORT: "0", HOST: "127.0.0.1", SIGIL_MCP_DATA_DIR: dataDir, SIGIL_MCP_ORIGIN_SECRET: "", ...extra },
        stdio: "ignore",
      });
      const t = setTimeout(() => (c.kill("SIGTERM"), resolve("still running")), 5000);
      c.once("exit", (code) => (clearTimeout(t), resolve(code)));
    });
  assert((await noSecret()) === 1, "no origin secret: exit 1");
  assert((await noSecret({ SIGIL_MCP_ORIGIN_SECRET: "short" })) === 1, "short origin secret: exit 1");
  // ... unless that is allowed on purpose
  assert((await noSecret({ SIGIL_MCP_ALLOW_NO_ORIGIN_SECRET: "1" })) === "still running", "opt-out starts");
  console.log("startup checks: ok");
  await startServer();
}
console.log("server:", local ? `${dist} --http` : base);
const stop = () => {
  child?.kill("SIGTERM");
  rmSync(dataDir, { recursive: true, force: true });
};

try {
  // plain routes
  assert((await fetch(`${base}/healthz`)).status === 200, "/healthz");
  assert((await fetch(`${base}/nope`)).status === 404, "unknown route is 404");
  const get = await fetch(`${base}/mcp`, { headers: edge });
  assert(get.status === 405, "GET /mcp is 405");
  assert(
    (await fetch(`${base}/healthz`)).headers.get("x-content-type-options") === "nosniff",
    "nosniff",
  );
  console.log("routes: ok");

  const client = new Client({ name: "sigil-e2e-http", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: edge } }));
  const { tools } = await client.listTools();
  console.log("tools:", tools.map((t) => t.name).join(", "));
  assert(tools.length === 3, "three tools");
  const createTool = tools.find((t) => t.name === "create_diagram");
  assert(!/written locally/.test(createTool.description), "remote description");

  const fmt = await client.callTool({ name: "describe_format", arguments: {} });
  assert(fmt.content[0].text.includes("Layout tips"), "describe_format content");

  // create_diagram: no path, so the JSON and open_url come back
  const res = await client.callTool({
    name: "create_diagram",
    arguments: {
      elements: [
        { type: "rectangle", id: "start", x: 0, y: 0, label: { text: "Start" } },
        { type: "rectangle", id: "load", x: 0, y: 160, label: { text: "Load configuration" } },
        { type: "arrow", start: { id: "start" }, end: { id: "load" } },
      ],
    },
  });
  assert(!res.isError, `create_diagram: ${res.content[0].text}`);
  const summary = JSON.parse(res.content[0].text);
  assert(
    /^https:\/\/sigil\.apollyoncorp\.com\/#data=[A-Za-z0-9_-]+$/.test(summary.open_url),
    "open_url",
  );
  assert(summary.written === undefined, "nothing written");
  const file = JSON.parse(res.content[1].text);
  assert(file.type === "excalidraw" && file.elements.length >= 3, "file in the reply");
  console.log("create_diagram: elements", summary.elements, "open_url length", summary.open_url.length);

  // BPMN example from the skill
  const skill = readFileSync(join(here, "../skill/sigil-diagrams/SKILL.md"), "utf8");
  const bpmnJson = [...skill.matchAll(/```json\n(\{"elements".*?)\n```/gs)]
    .map((m) => m[1])
    .find((s) => s.includes('"bpmn.pool"'));
  assert(bpmnJson, "skill has no BPMN example");
  const bpmn = JSON.parse(bpmnJson);
  delete bpmn.path; // the remote server refuses path
  const bp = await client.callTool({ name: "create_diagram", arguments: bpmn });
  assert(!bp.isError, `BPMN rejected: ${bp.content[0].text}`);
  assert(JSON.parse(bp.content[0].text).warnings.length === 0, "BPMN warnings");
  console.log("BPMN: ok");

  const mm = await client.callTool({
    name: "mermaid_to_diagram",
    arguments: { mermaid: "flowchart TD\n  A[Start] --> B{Valid?}\n  B -->|yes| C[Done]\n  B -->|no| A" },
  });
  assert(!mm.isError, `mermaid_to_diagram: ${mm.content[0].text}`);
  const mmSummary = JSON.parse(mm.content[0].text);
  assert(mmSummary.open_url && mmSummary.written === undefined, "mermaid open_url");
  console.log("mermaid_to_diagram: elements", mmSummary.elements);

  // path is refused, and nothing is written
  const target = join(here, "../dist/must-not-exist.excalidraw");
  for (const call of [
    { name: "create_diagram", arguments: { elements: [{ type: "rectangle", x: 0, y: 0 }], path: target } },
    { name: "mermaid_to_diagram", arguments: { mermaid: "flowchart TD\n A --> B", path: target } },
  ]) {
    const r = await client.callTool(call);
    assert(r.isError && r.content[0].text.includes("not accepted by the remote server"), `${call.name} path refusal`);
  }
  assert(!existsSync(target), "path must not be written");
  console.log("path refusal: ok");
  await client.close();

  if (local) {
    // rate limit: 25 per day per client, about 11 used above
    const hit = (i = 0) =>
      fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...edge },
        body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "tools/list" }),
      });
    let limited;
    for (let i = 0; i < 40 && !limited; i++) {
      const r = await hit(i);
      if (r.status === 429) limited = r;
    }
    assert(limited, "expected a 429");
    assert(Number(limited.headers.get("retry-after")) >= 1, "Retry-After");
    console.log("rate limit: 429, Retry-After", limited.headers.get("retry-after"));

    // who may reach the server: the address header and the origin secret
    const bare = (headers) =>
      fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    assert((await bare({ "x-sigil-origin-auth": ORIGIN_SECRET })).status === 403, "no CF-Connecting-IP is 403");
    assert((await bare({ "cf-connecting-ip": CLIENT_IP })).status === 403, "no origin secret is 403");
    assert(
      (await bare({ "cf-connecting-ip": CLIENT_IP, "x-sigil-origin-auth": "wrong" })).status === 403,
      "wrong origin secret is 403",
    );
    assert((await fetch(`${base}/healthz`)).status === 200, "/healthz needs no header");
    console.log("access: 403 without the address or the secret, /healthz free");

    // usage, with the token
    assert((await fetch(`${base}/stats`, { headers: edge })).status === 401, "/stats without token is 401");
    assert((await fetch(`${base}/stats`, { headers: { authorization: `Bearer ${STATS_TOKEN}` } })).status === 403, "/stats without the origin secret is 403");
    const auth = { headers: { authorization: `Bearer ${STATS_TOKEN}`, ...edge } };
    let stats;
    for (let i = 0; i < 20; i++) {
      stats = await (await fetch(`${base}/stats`, auth)).json();
      if (stats.total.rate_limited >= 1) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const today = stats.days.at(-1);
    assert(today.distinct_ips === 1, `distinct_ips ${today.distinct_ips}`);
    assert(today.tools.create_diagram.calls >= 2, "create_diagram counted");
    assert(today.tools.create_diagram.errors >= 1 && today.tools.mermaid_to_diagram.errors >= 1, "path refusals counted as errors");
    assert(stats.total.rate_limited >= 1, "429 counted");
    assert(!JSON.stringify(stats).includes(CLIENT_IP), "no address in /stats");
    console.log("stats:", JSON.stringify(stats.total), "create_diagram", JSON.stringify(today.tools.create_diagram));

    // restart on the same folder: the day limit is still reached, and the
    // salt is the same (the client hash does not change)
    await stopServer();
    await startServer();
    const again = await hit(99);
    assert(again.status === 429, `after restart expected 429, got ${again.status}`);
    assert(/\(day\)/.test(JSON.stringify(await again.json())), "still the day limit");
    const after = await (await fetch(`${base}/stats`, auth)).json();
    assert(after.total.calls >= stats.total.calls, "usage survived the restart");
    console.log("restart: day limit still 429, usage kept, calls", after.total.calls);

    await stopServer(); // closes the database and its WAL
    const files = readdirSync(dataDir);
    assert(files.includes("sigil-mcp.db"), "sqlite file written");
    for (const f of files) {
      const text = readFileSync(join(dataDir, f)).toString("latin1");
      assert(!text.includes(CLIENT_IP) && !text.includes(ORIGIN_SECRET), `${f} holds a clear address or the secret`);
    }
    console.log("data folder:", files.join(", "), "- no clear address");
  }
  console.log("E2E-HTTP OK");
} finally {
  stop();
}
