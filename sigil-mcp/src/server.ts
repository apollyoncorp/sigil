import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { FORMAT_SHEET } from "./format";
import { elementSchema, MAX_ELEMENTS } from "./schema";
import { createDiagram, formatOutcome, mermaidToDiagram } from "./tools";

export const SERVER_NAME = "sigil-mcp";
export const SERVER_VERSION = "0.1.0";

export const CREATE_DIAGRAM_DESCRIPTION = `Draw a diagram as a Sigil/Excalidraw (.excalidraw) file from a list of shapes, text and arrows. Nothing is sent anywhere; the file is made locally.

Shapes: rectangle, ellipse, diamond (give "label": {"text": ...}; omit width/height to auto-fit, min 180x80). Connect them with arrows using "start": {"id"} and "end": {"id"}; give every connected shape an "id". Also: text, line, frame.
Result: open_url (a link that opens the diagram directly in Sigil; share it with the user) plus warnings about overlapping shapes, labels that do not fit, arrows that are unattached or cut through a shape. Fix them and call again with the same path.
Call describe_format first if unsure of the fields.

Example: {"elements":[{"type":"rectangle","id":"a","x":0,"y":0,"label":{"text":"Client"}},{"type":"rectangle","id":"b","x":300,"y":0,"label":{"text":"API"}},{"type":"arrow","start":{"id":"a"},"end":{"id":"b"},"label":{"text":"HTTPS"}}],"path":"/tmp/api.excalidraw"}`;

export const MERMAID_DESCRIPTION = `Turn Mermaid text into a Sigil/Excalidraw (.excalidraw) diagram, laid out automatically. Best for flowchart, sequence, class, ER and state diagrams; other diagram types are drawn as an image. Runs locally. Returns open_url like create_diagram.
Use this when the diagram is a plain graph and you do not need to control positions; use create_diagram for full control.
Example: {"mermaid":"flowchart TD\\n  A[Start] --> B{Valid?}\\n  B -->|yes| C[Done]\\n  B -->|no| A","path":"/tmp/flow.excalidraw"}`;

export const DESCRIBE_DESCRIPTION =
  "Returns a short cheat-sheet of the create_diagram format: element fields, a 3-node flowchart example and layout tips (spacing, grid, sizes). No input. Call it once before your first diagram.";

const pathField = z
  .string()
  .optional()
  .describe(
    'Where to write the file, ending in .excalidraw (absolute is safest; the folder is created; an existing file is overwritten). Omit to get the JSON back in the reply instead.',
  );

export const createServer = () => {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Sigil diagram drawing. Use create_diagram (or mermaid_to_diagram) to write .excalidraw files the user opens in Sigil. This server only draws; it does not call any model or network service.",
    },
  );

  server.registerTool(
    "create_diagram",
    {
      title: "Create a Sigil diagram",
      description: CREATE_DIAGRAM_DESCRIPTION,
      inputSchema: {
        elements: z
          .array(elementSchema)
          .min(1)
          .max(MAX_ELEMENTS)
          .describe("Shapes, text and arrows, in drawing order (later ones on top)."),
        path: pathField,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => formatOutcome(await createDiagram(args)),
  );

  server.registerTool(
    "mermaid_to_diagram",
    {
      title: "Mermaid to Sigil diagram",
      description: MERMAID_DESCRIPTION,
      inputSchema: {
        mermaid: z
          .string()
          .min(1)
          .describe('Mermaid source, starting with the diagram type, e.g. "flowchart TD" or "sequenceDiagram".'),
        path: pathField,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => formatOutcome(await mermaidToDiagram(args)),
  );

  server.registerTool(
    "describe_format",
    {
      title: "Describe the diagram format",
      description: DESCRIBE_DESCRIPTION,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({ content: [{ type: "text" as const, text: FORMAT_SHEET }] }),
  );

  return server;
};
