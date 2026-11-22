import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer } from "./server";

const main = async () => {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  // stdout is the protocol channel: log to stderr only
  console.error("sigil-mcp ready (stdio)");
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
