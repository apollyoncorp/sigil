// End-to-end for the remote mode: starts the BUILT server with --http on a
// free port, talks to it with the SDK's Streamable HTTP client, and checks
// the plain routes and the rate limit with fetch.
//
//   node scripts/e2e-http.mjs
//
// SIGIL_MCP_URL=https://mcp.example.org skips the local server and runs the
// same checks against a deployed one (the rate-limit check is skipped there).
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
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
if (local) {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [dist, "--http"], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      SIGIL_MCP_RATE_PER_MINUTE: "20",
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
}
console.log("server:", local ? `${dist} --http` : base);
const stop = () => child?.kill("SIGTERM");

try {
  // plain routes
  assert((await fetch(`${base}/healthz`)).status === 200, "/healthz");
  assert((await fetch(`${base}/nope`)).status === 404, "unknown route is 404");
  const get = await fetch(`${base}/mcp`);
  assert(get.status === 405, "GET /mcp is 405");
  assert(
    (await fetch(`${base}/healthz`)).headers.get("x-content-type-options") === "nosniff",
    "nosniff",
  );
  console.log("routes: ok");

  const client = new Client({ name: "sigil-e2e-http", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
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
    // rate limit: 20 per minute per client, some already used above
    let limited;
    for (let i = 0; i < 40 && !limited; i++) {
      const r = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "tools/list" }),
      });
      if (r.status === 429) limited = r;
    }
    assert(limited, "expected a 429");
    assert(Number(limited.headers.get("retry-after")) >= 1, "Retry-After");
    console.log("rate limit: 429, Retry-After", limited.headers.get("retry-after"));
  }
  console.log("E2E-HTTP OK");
} finally {
  stop();
}
