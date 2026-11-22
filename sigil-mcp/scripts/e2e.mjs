// End-to-end: spawns the BUILT server over stdio with the SDK Client, lists
// tools, draws a 5-node flowchart (with a decision diamond) and a Mermaid
// flowchart, and writes the files.
//
//   node scripts/e2e.mjs [outDir]
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "../dist/sigil-mcp.mjs");
const outDir = resolve(process.argv[2] ?? join(tmpdir(), "sigil-mcp-e2e"));
mkdirSync(outDir, { recursive: true });

const client = new Client({ name: "sigil-e2e", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [dist] }),
);

const assert = (cond, msg) => {
  if (!cond) {
    console.error("E2E FAIL:", msg);
    process.exit(1);
  }
};

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));
assert(tools.some((t) => t.name === "create_diagram"), "create_diagram missing");
assert(tools.some((t) => t.name === "describe_format"), "describe_format missing");

const fmt = await client.callTool({ name: "describe_format", arguments: {} });
assert(fmt.content[0].text.includes("Layout tips"), "describe_format content");

// 5 nodes: Start, Process, Decision (diamond), Yes-end, No-end, laid out top-down
const flow = {
  elements: [
    { type: "rectangle", id: "start", x: 300, y: 0, label: { text: "Start" }, backgroundColor: "#a5d8ff" },
    { type: "rectangle", id: "load", x: 300, y: 160, label: { text: "Load configuration" }, backgroundColor: "#e9ecef" },
    { type: "diamond", id: "valid", x: 300, y: 320, label: { text: "Config valid?" }, backgroundColor: "#ffec99" },
    { type: "rectangle", id: "run", x: 40, y: 520, label: { text: "Run the job" }, backgroundColor: "#b2f2bb" },
    { type: "rectangle", id: "fail", x: 560, y: 520, label: { text: "Report error" }, backgroundColor: "#ffc9c9" },
    { type: "arrow", start: { id: "start" }, end: { id: "load" } },
    { type: "arrow", start: { id: "load" }, end: { id: "valid" } },
    { type: "arrow", start: { id: "valid" }, end: { id: "run" }, label: { text: "yes" } },
    { type: "arrow", start: { id: "valid" }, end: { id: "fail" }, label: { text: "no" } },
  ],
  path: join(outDir, "flow.excalidraw"),
};
const res = await client.callTool({ name: "create_diagram", arguments: flow });
console.log(res.content[0].text);
assert(!res.isError, "create_diagram returned an error");
const file = JSON.parse(readFileSync(flow.path, "utf8"));
assert(file.type === "excalidraw" && file.version === 2, "file header");
assert(file.source === "https://sigil.apollyoncorp.com", "file source");
console.log("flow.excalidraw elements:", file.elements.length);

// an invalid call must give an actionable error, not a crash
const bad = await client.callTool({
  name: "create_diagram",
  arguments: {
    elements: [
      { type: "rectangle", id: "a", x: 0, y: 0 },
      { type: "arrow", start: { id: "a" }, end: { id: "b2" } },
    ],
  },
});
console.log("invalid call ->", bad.isError, bad.content[0].text.split("\n")[1]);
assert(bad.isError && bad.content[0].text.includes("end.id 'b2' not found"), "validation message");

const mm = await client.callTool({
  name: "mermaid_to_diagram",
  arguments: {
    mermaid: "flowchart TD\n  A[Start] --> B[Load configuration]\n  B --> C{Config valid?}\n  C -->|yes| D[Run the job]\n  C -->|no| E[Report error]",
    path: join(outDir, "mermaid.excalidraw"),
  },
});
console.log(mm.content[0].text);
assert(!mm.isError, "mermaid_to_diagram returned an error");

await client.close();
console.log("E2E OK ->", outDir);
