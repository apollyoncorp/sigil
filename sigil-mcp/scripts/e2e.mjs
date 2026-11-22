// End-to-end: spawns the BUILT server over stdio with the SDK Client, lists
// tools, draws a 5-node flowchart (with a decision diamond) and a Mermaid
// flowchart, and writes the files.
//
//   node scripts/e2e.mjs [outDir]
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
// Proof that stdio mode never loads sqlite: a preload makes the server write
// its loaded built-in modules to a file every 100 ms (Node lists
// "NativeModule sqlite" only once node:sqlite has been loaded).
const loadedFile = join(tmpdir(), `sigil-mcp-e2e-modules-${process.pid}.json`);
const preload = `data:text/javascript,${encodeURIComponent(
  `import{writeFileSync}from"node:fs";setInterval(()=>writeFileSync(${JSON.stringify(loadedFile)},JSON.stringify(process.moduleLoadList)),100).unref();`,
)}`;
// SIGIL_MCP_INSTALL_DIR=<dir> runs the server the way a user would: through
// npx, from a directory where the packed tarball was installed (no repo, no
// registry: --no-install).
const installDir = process.env.SIGIL_MCP_INSTALL_DIR;
await client.connect(
  installDir
    ? new StdioClientTransport({
        command: "npx",
        args: ["--no-install", "@apollyoncorp/sigil-mcp"],
        cwd: installDir,
      })
    : new StdioClientTransport({ command: process.execPath, args: ["--import", preload, dist] }),
);
console.log("server:", installDir ? `npx in ${installDir}` : dist);

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
  path: join(outDir, "flow.sigil"),
};
const res = await client.callTool({ name: "create_diagram", arguments: flow });
console.log(res.content[0].text);
assert(!res.isError, "create_diagram returned an error");
const summary = JSON.parse(res.content[0].text);
assert(
  /^https:\/\/sigil\.apollyoncorp\.com\/#data=[A-Za-z0-9_-]+$/.test(summary.open_url),
  "open_url",
);
console.log("open_url length:", summary.open_url.length);
writeFileSync(join(outDir, "flow.url.txt"), summary.open_url + "\n");
const file = JSON.parse(readFileSync(flow.path, "utf8"));
assert(file.type === "excalidraw" && file.version === 2, "file header");
assert(file.source === "https://sigil.apollyoncorp.com", "file source");
console.log("flow.sigil elements:", file.elements.length);

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
    path: join(outDir, "mermaid.sigil"),
  },
});
console.log(mm.content[0].text);
assert(!mm.isError, "mermaid_to_diagram returned an error");

// BPMN: the two-pool process of the skill, drawn from shapes and flows
const skill = readFileSync(join(here, "../skill/sigil-diagrams/SKILL.md"), "utf8");
const bpmnJson = [...skill.matchAll(/```json\n(\{"elements".*?)\n```/gs)]
  .map((m) => m[1])
  .find((s) => s.includes('"bpmn.pool"'));
assert(bpmnJson, "skill has no BPMN example");
const bpmn = JSON.parse(bpmnJson);
bpmn.path = join(outDir, "support.sigil");
const bp = await client.callTool({ name: "create_diagram", arguments: bpmn });
assert(!bp.isError, `BPMN example rejected: ${bp.content[0].text}`);
const bpSummary = JSON.parse(bp.content[0].text);
assert(bpSummary.warnings.length === 0, `BPMN example warnings: ${bpSummary.warnings}`);
assert(bpSummary.open_url, "BPMN open_url");
console.log("BPMN: elements", bpSummary.elements, "open_url length", bpSummary.open_url.length);
writeFileSync(join(outDir, "support.url.txt"), bpSummary.open_url + "\n");

// a message flow between two elements of one pool must be reported
const wrong = JSON.parse(bpmnJson);
wrong.elements = wrong.elements.map((e) =>
  e.flow === "message" && e.from === "submit" ? { ...e, to: "answer" } : e,
);
wrong.path = join(outDir, "support-wrong.sigil");
const wr = await client.callTool({ name: "create_diagram", arguments: wrong });
const wrSummary = JSON.parse(wr.content[0].text);
console.log("wrong BPMN ->", wrSummary.warnings);
assert(
  wrSummary.warnings.some((w) => w.startsWith("message_flow_same_pool")),
  "message_flow_same_pool warning",
);
writeFileSync(join(outDir, "support-wrong.url.txt"), wrSummary.open_url + "\n");
writeFileSync(join(outDir, "support-wrong.warnings.txt"), wrSummary.warnings.join("\n") + "\n");

// the schema refuses an unknown shape before anything is drawn
const unknown = await client
  .callTool({
    name: "create_diagram",
    arguments: { elements: [{ shape: "bpmn.nope", id: "a", x: 0, y: 0 }] },
  })
  .then(
    (r) => r.isError,
    () => true,
  );
assert(unknown, "unknown shape should be rejected");

if (!installDir) {
  await new Promise((r) => setTimeout(r, 400));
  const loaded = JSON.parse(readFileSync(loadedFile, "utf8"));
  assert(loaded.some((m) => m === "NativeModule fs"), "preload did not run (control: fs is loaded)");
  assert(!loaded.some((m) => /sqlite/i.test(m)), "stdio mode must not load sqlite");
  console.log("stdio loads sqlite: no (checked in the server's module list)");
  rmSync(loadedFile, { force: true });
}

await client.close();
console.log("E2E OK ->", outDir);
