import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { wantsHttp } from "./http-flag";
import { createServer } from "./server";

const main = async () => {
  if (wantsHttp()) {
    // loaded only in remote mode: stdio never touches the HTTP code
    const { startHttp } = await import("./http");
    await startHttp();
    return;
  }
  const server = createServer();
  await server.connect(new StdioServerTransport());
  // stdout is the protocol channel: log to stderr only
  console.error("sigil-mcp ready (stdio)");
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
