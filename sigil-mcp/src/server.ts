import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { FORMAT_SHEET } from "./format";
import { entrySchema } from "./diagram";
import { MAX_ELEMENTS } from "./schema";
import { createDiagram, formatOutcome, mermaidToDiagram } from "./tools";

export const SERVER_NAME = "sigil-mcp";
export const SERVER_VERSION = "0.4.1";
/** The tools this server registers (usage is counted per name). */
export const TOOL_NAMES = ["create_diagram", "mermaid_to_diagram", "describe_format"] as const;

const LOCAL_CREATE_EXAMPLE = `Example: {"elements":[{"type":"rectangle","id":"a","x":0,"y":0,"label":{"text":"Client"}},{"type":"rectangle","id":"b","x":300,"y":0,"label":{"text":"API"}},{"type":"arrow","start":{"id":"a"},"end":{"id":"b"},"label":{"text":"HTTPS"}}],"path":"/tmp/api.sigil"}`;
const REMOTE_CREATE_EXAMPLE = LOCAL_CREATE_EXAMPLE.replace(',"path":"/tmp/api.sigil"', "");

export const createDiagramDescription = (remote = false) => `Draw a diagram as a Sigil (.sigil) file from a list of shapes, text and arrows. ${
  remote
    ? 'Remote server: the diagram is built on the server and returned in the reply; nothing is written to disk, so do not pass "path".'
    : "Nothing is sent anywhere; the file is made locally."
}

Shapes: rectangle, ellipse, diamond (give "label": {"text": ...}; omit width/height to auto-fit, min 180x80). Connect them with arrows using "start": {"id"} and "end": {"id"}; give every connected shape an "id". Also: text, line, frame.
BPMN and flowchart: an entry {"shape":"bpmn.task","id":"t1","x":0,"y":0,"label":"Review request"} draws a ready-made shape (bpmn.start-event, bpmn.exclusive-gateway, bpmn.pool with "lanes", flow.process, ...; describe_format lists them), and {"flow":"sequence"|"message"|"association","from":"t1","to":"g1","label":"yes"} connects two of them. Sequence flows stay inside one pool; message flows go between pools. These entries can sit next to plain elements in the same list.
Result: open_url (a link that opens the diagram directly in Sigil; share it with the user) plus warnings about overlapping shapes or frames, labels that do not fit, arrows that are unattached or cut through a shape, and BPMN rules (message flow inside one pool, sequence flow across pools, element outside every pool, element on a lane boundary). Fix them and call again${remote ? "" : " with the same path"}.
Call describe_format first if unsure of the fields.

${remote ? REMOTE_CREATE_EXAMPLE : LOCAL_CREATE_EXAMPLE}`;

export const mermaidDescription = (remote = false) => `Turn Mermaid text into a Sigil (.sigil) diagram, laid out automatically. Best for flowchart, sequence, class, ER and state diagrams; other diagram types are drawn as an image. ${remote ? "Runs on the remote server; nothing is written to disk." : "Runs locally."} Returns open_url like create_diagram.
Use this when the diagram is a plain graph and you do not need to control positions; use create_diagram for full control.
Example: {"mermaid":"flowchart TD\\n  A[Start] --> B{Valid?}\\n  B -->|yes| C[Done]\\n  B -->|no| A"${remote ? "" : ',"path":"/tmp/flow.sigil"'}}`;

export const CREATE_DIAGRAM_DESCRIPTION = createDiagramDescription();
export const MERMAID_DESCRIPTION = mermaidDescription();

export const DESCRIBE_DESCRIPTION =
  "Returns a short cheat-sheet of the create_diagram format: element fields, the BPMN and flowchart shape names with a two-pool BPMN example, a 3-node flowchart example and layout tips (spacing, grid, sizes). No input. Call it once before your first diagram.";

const pathField = (remote: boolean) =>
  z
    .string()
    .optional()
    .describe(
      remote
        ? "Not available on the remote server (it never writes files): leave it out. The reply carries the JSON and open_url."
        : "Where to write the file, ending in .sigil or .excalidraw (absolute is safest; the folder is created; an existing file is overwritten). Omit to get the JSON back in the reply instead.",
    );

export type ServerOptions = {
  /** HTTP mode: writes nothing to disk and refuses `path`. */
  remote?: boolean;
};

export const createServer = ({ remote = false }: ServerOptions = {}) => {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: remote
        ? "Sigil diagram drawing (remote). Use create_diagram (or mermaid_to_diagram) and give the user the open_url from the reply, or the returned JSON saved as name.sigil. This server only draws; it does not call any model, and it writes nothing to disk, so never pass path."
        : "Sigil diagram drawing. Use create_diagram (or mermaid_to_diagram) to write .sigil files the user opens in Sigil. This server only draws; it does not call any model or network service.",
    },
  );

  server.registerTool(
    "create_diagram",
    {
      title: "Create a Sigil diagram",
      description: createDiagramDescription(remote),
      inputSchema: {
        elements: z
          .array(entrySchema)
          .min(1)
          .max(MAX_ELEMENTS)
          .describe(
            'Plain elements (with "type"), BPMN/flowchart shapes (with "shape") and flows (with "flow"), in drawing order (later ones on top). Draw pools first so they sit behind.',
          ),
        path: pathField(remote),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => formatOutcome(await createDiagram(args, { remote })),
  );

  server.registerTool(
    "mermaid_to_diagram",
    {
      title: "Mermaid to Sigil diagram",
      description: mermaidDescription(remote),
      inputSchema: {
        mermaid: z
          .string()
          .min(1)
          .describe('Mermaid source, starting with the diagram type, e.g. "flowchart TD" or "sequenceDiagram".'),
        path: pathField(remote),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => formatOutcome(await mermaidToDiagram(args, { remote })),
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
