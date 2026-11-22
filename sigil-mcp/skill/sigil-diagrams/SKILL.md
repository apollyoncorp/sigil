---
name: sigil-diagrams
description: Draw clean diagrams (flowcharts, architecture, process, sequence) as Sigil/Excalidraw .excalidraw files. Use when the user asks for a diagram, flowchart, architecture sketch, process map or "draw this", or wants something opened in Sigil. Prefers the sigil-mcp tools; falls back to writing the file by hand.
---

# Drawing diagrams for Sigil

Sigil opens `.excalidraw` files. You draw; the user's own assistant (you) does the thinking, nothing is sent to any service.

## 1. Pick the route

1. **Tools `create_diagram` / `mermaid_to_diagram` available (sigil-mcp)?** Use them. Call `describe_format` once if unsure of a field.
   - Plain graph, no layout opinions: `mermaid_to_diagram` (flowchart, sequence, class, ER, state).
   - Anything where position matters, or any custom look: `create_diagram`.
2. **No MCP?** Write the file yourself (section 5), then tell the user to open it in Sigil (File > Open, or drop it on the canvas).

Always pass an absolute `path` ending in `.excalidraw` so the user gets a file, and give them `open_url` when the tool returns one.

## 2. Layout rules (these make it look good)

- **Grid.** Columns 260 px apart, rows 160 px apart. Every x and y a multiple of 20.
- **One centre axis.** The main flow runs down a single x (all boxes same x, same width). Side branches sit symmetrically left and right of it.
- **Flow direction.** Top to bottom (rising y) or left to right, never both in one diagram.
- **Gaps.** At least 60 px between shapes; arrows need that room. Never overlap shapes.
- **One idea per box.** If a label needs "and", split it in two boxes.
- **Short labels.** Under about 30 characters, verbs for steps ("Validate input"), questions for decisions ("Valid?"). Move detail to a note, not into the box.
- **Omit width/height.** Boxes then fit their label (180x80, diamonds 180x100). Set a size only to make boxes of one role equal.
- **Colour sparingly.** Default stroke `#1e1e1e`. Fill by role, at most 3 or 4 colours: `#a5d8ff` start/input, `#e9ecef` normal step, `#ffec99` decision, `#b2f2bb` success/end, `#ffc9c9` error. No fill on anything else.
- **Connect with ids.** Give each shape a short `id` and use `"start": {"id": "a"}, "end": {"id": "b"}`; never guess arrow coordinates.
- **Title** (optional): one `text` element, fontSize 28, centred above the flow.

## 3. Flowchart patterns

- **Linear:** boxes stacked on one x, one arrow each.
- **Decision:** diamond on the axis. "yes" branch down-left, "no" branch down-right (or "yes" continues straight down and "no" goes right). Put the label on the arrow (`"label": {"text": "yes"}`). Every diamond has exactly two exits, both labelled.
- **Merge:** both branches end in an arrow into one box on the axis below them.
- **Loop back (retry):** place the target to the side, or add a small box on the axis; avoid a long arrow across other boxes (the report flags `arrow_crosses`).
- **Swimlanes / groups:** a `frame` with `children: [ids]` and a `name`; keep each lane in its own column.
- **Architecture:** layers as rows (clients, API, services, data), components as boxes in the row, arrows only between neighbouring layers.
- BPMN-style notation (events, gateways, pools) comes later; for now use rectangles, diamonds and ellipses as above.

Worked example (decision with two branches):

```json
{"elements":[
 {"type":"rectangle","id":"s","x":300,"y":0,"label":{"text":"Receive order"},"backgroundColor":"#a5d8ff"},
 {"type":"diamond","id":"d","x":300,"y":160,"label":{"text":"In stock?"},"backgroundColor":"#ffec99"},
 {"type":"rectangle","id":"y","x":40,"y":360,"label":{"text":"Ship"},"backgroundColor":"#b2f2bb"},
 {"type":"rectangle","id":"n","x":560,"y":360,"label":{"text":"Back-order"},"backgroundColor":"#ffc9c9"},
 {"type":"arrow","start":{"id":"s"},"end":{"id":"d"}},
 {"type":"arrow","start":{"id":"d"},"end":{"id":"y"},"label":{"text":"yes"}},
 {"type":"arrow","start":{"id":"d"},"end":{"id":"n"},"label":{"text":"no"}}
],"path":"/abs/path/order.excalidraw"}
```

## 4. Read the result and fix it

The tool replies with `warnings`. Fix them and call again with the same `path` (it overwrites). Stop when the list is empty.

| warning | meaning | fix |
|---|---|---|
| `overlap` | two shapes partly cover each other | move one so the gap is 60 px or more |
| `label_too_wide` | label wider than the shape you sized, so it wraps | the message gives the width to set; or drop `width` to auto-fit; or shorten the text |
| `label_too_tall` | wrapped label taller than the shape | raise `height` or shorten the text |
| `arrow_unbound` | an arrow end is free, or its id could not attach | add `start`/`end` ids, check the id spelling, bring the shapes closer |
| `arrow_crosses` | a straight arrow cuts through another shape | move that shape aside, or route via an extra box |
| `image_fallback` | (Mermaid) diagram type was added as a picture | use flowchart, sequence, class, ER or state, or redraw with `create_diagram` |

A validation error (`Not drawn. N problems`) lists each problem as `type #position: what is wrong`. Fix all of them in one go.

## 5. No MCP: write the file by hand

Write a UTF-8 file named `something.excalidraw` containing JSON with this envelope:

```json
{"type":"excalidraw","version":2,"source":"https://sigil.apollyoncorp.com","elements":[ ... ],"appState":{"viewBackgroundColor":"#ffffff"},"files":{}}
```

Hand-written `elements` must be full Excalidraw elements, which is error prone. Keep it to rectangles, diamonds, text and arrows, and for every shape set `type, id, x, y, width, height, angle:0, strokeColor, backgroundColor, fillStyle:"solid", strokeWidth:2, strokeStyle:"solid", roughness:1, opacity:100, groupIds:[], frameId:null, roundness:null, seed, version:1, versionNonce, isDeleted:false, boundElements:null, updated:1, link:null, locked:false`. Put text in a separate `text` element (`text, fontSize:20, fontFamily:5, textAlign:"center", verticalAlign:"middle", containerId`) and list it in the shape's `boundElements` as `{"type":"text","id":"..."}`. Arrows need `points:[[0,0],[dx,dy]]` plus `startBinding`/`endBinding` `{elementId, focus:0, gap:6}` on both ends and a matching entry in each shape's `boundElements`. Same layout rules as above: grid, one axis, 60 px gaps. If you can run a command, installing sigil-mcp (`npx @apollyoncorp/sigil-mcp`) is far easier.
