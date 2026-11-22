---
name: sigil-diagrams
description: Draw clean diagrams (flowcharts, architecture, BPMN process maps with pools and lanes, sequence) as Sigil/Excalidraw .excalidraw files. Use when the user asks for a diagram, flowchart, architecture sketch, process map or "draw this", or wants something opened in Sigil. Prefers the sigil-mcp tools; falls back to writing the file by hand.
---

# Drawing diagrams for Sigil

Sigil opens `.excalidraw` files. You draw; the user's own assistant (you) does the thinking, and the local tools send nothing to any service.

## 1. Pick the route

1. **Tools `create_diagram` / `mermaid_to_diagram` available (sigil-mcp)?** Use them. Call `describe_format` once if unsure of a field.
   - Plain graph, no layout opinions: `mermaid_to_diagram` (flowchart, sequence, class, ER, state).
   - Anything where position matters, or any custom look: `create_diagram`.
2. **No MCP?** Write the file yourself (section 5), then tell the user to open it in Sigil (File > Open, or drop it on the canvas).

Pass an absolute `path` ending in `.excalidraw` so the user gets a file, and give them `open_url` when the tool returns one. The remote server (HTTP, `mcp.apollyoncorp.com`) refuses `path` because it writes nothing: leave it out, then give the user `open_url`, or save the returned JSON as a `.excalidraw` file for them.

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
- Process with several actors, events, gateways or pools: use the BPMN shapes (section 3b), not boxes.

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

## 3b. BPMN processes (shape and flow entries)

`create_diagram` also takes ready-made shapes, drawn in the same hand-drawn style as the "Shape libraries" in Sigil. Use them when the user asks for BPMN, a process with several actors, or hand-offs between teams. For a plain flowchart, rectangles and diamonds are enough (or `flow.process`, `flow.decision`... if they want standard flowchart symbols).

- **Shape:** `{"shape":"bpmn.task","id":"t1","x":290,"y":110,"label":"Review request"}`. Position is the top-left corner; size is fixed (task 160x80, events 40x40, gateways 56x56). Names: `bpmn.start-event`, `bpmn.timer-start-event`, `bpmn.message-start-event`, `bpmn.intermediate-event`, `bpmn.intermediate-message-event`, `bpmn.end-event`, `bpmn.task`, `bpmn.sub-process`, `bpmn.exclusive-gateway`, `bpmn.parallel-gateway`, `bpmn.inclusive-gateway`, `bpmn.event-gateway`, `bpmn.data-object`, `bpmn.data-store`, `bpmn.text-annotation`, `bpmn.pool`; flowchart: `flow.terminator`, `flow.process`, `flow.decision`, `flow.input-output`, `flow.document`, `flow.predefined-process`, `flow.database`, `flow.manual-input`, `flow.connector`.
- **Labels.** Tasks hold a short label (2 lines at most). Events, gateways and data get a name drawn next to them (below; gateways above): keep it short, leave 30 px of room for it, and use `"labelSide":"top"|"right"|"bottom"|"left"` when a flow arrives where the name would go (`arrow_crosses` says so).
- **Flow:** `{"flow":"sequence","from":"t1","to":"g1","label":"yes"}`. `sequence` = solid arrow, the order of steps; `message` = dashed arrow, a message between participants; `association` = dotted line to a data store, data object or annotation. Flows attach to the shapes and follow them when moved.
- **Pools and lanes.** One pool per participant (customer, support team, a system). Add `"lanes":["Agent","Specialist"]` to split a pool into departments or roles; give `width` and `height` (lane height 160 or more; defaults are 800 wide, 160 per lane). Draw pools first so they sit behind, and put every event, task and gateway fully inside one lane, clear of the name bands on the left (64 px with lanes, 32 without).
- **The two rules.** Sequence flows stay inside one pool (a hand-off between lanes is still a sequence flow). Message flows go only between elements of different pools. Gateways: one entry, two or more exits, each exit labelled (`yes` / `no`); a start event has no entry, an end event no exit.
- **Layout.** Left to right inside a pool; stack pools top to bottom, 80 px apart. Keep the elements that talk to each other in the same x range so message flows run straight and short. Keep flows clear of other shapes (`arrow_crosses`).

Worked example (customer asks, support answers; two pools, two lanes, two message flows):

```json
{"elements":[
 {"shape":"bpmn.pool","id":"support","x":0,"y":0,"width":880,"height":480,"label":"Support","lanes":["Agent","Specialist"]},
 {"shape":"bpmn.pool","id":"customer","x":0,"y":560,"width":880,"height":160,"label":"Customer"},
 {"shape":"bpmn.message-start-event","id":"request","x":210,"y":130,"label":"Request in","labelSide":"top"},
 {"shape":"bpmn.task","id":"review","x":290,"y":110,"label":"Review request"},
 {"shape":"bpmn.exclusive-gateway","id":"valid","x":502,"y":122,"label":"Valid?"},
 {"shape":"bpmn.task","id":"reject","x":610,"y":110,"label":"Reject request"},
 {"shape":"bpmn.end-event","id":"rejected","x":810,"y":130,"label":"Rejected"},
 {"shape":"bpmn.task","id":"resolve","x":450,"y":320,"label":"Resolve issue"},
 {"shape":"bpmn.end-event","id":"resolved","x":670,"y":340,"label":"Resolved"},
 {"shape":"bpmn.data-store","id":"tickets","x":346,"y":24,"label":"Tickets","labelSide":"right"},
 {"shape":"bpmn.start-event","id":"start","x":80,"y":620,"label":"Need help"},
 {"shape":"bpmn.task","id":"submit","x":150,"y":600,"label":"Submit request"},
 {"shape":"bpmn.intermediate-message-event","id":"answer","x":510,"y":620,"label":"Answer received"},
 {"shape":"bpmn.end-event","id":"done","x":680,"y":620,"label":"Done"},
 {"flow":"sequence","from":"start","to":"submit"},
 {"flow":"sequence","from":"submit","to":"answer"},
 {"flow":"sequence","from":"answer","to":"done"},
 {"flow":"sequence","from":"request","to":"review"},
 {"flow":"sequence","from":"review","to":"valid"},
 {"flow":"sequence","from":"valid","to":"reject","label":"no"},
 {"flow":"sequence","from":"reject","to":"rejected"},
 {"flow":"sequence","from":"valid","to":"resolve","label":"yes"},
 {"flow":"sequence","from":"resolve","to":"resolved"},
 {"flow":"association","from":"review","to":"tickets"},
 {"flow":"message","from":"submit","to":"request"},
 {"flow":"message","from":"resolve","to":"answer"}
],"path":"/abs/path/support.excalidraw"}
```

## 4. Read the result and fix it

The tool replies with `warnings`. Fix them and call again with the same `path` (it overwrites). Stop when the list is empty.

| warning | meaning | fix |
|---|---|---|
| `overlap` | two shapes (or a shape and an event's name) partly cover each other | move one so the gap is 60 px or more (20 px for BPMN shapes) |
| `label_too_wide` | label wider than the shape you sized, so it wraps | the message gives the width to set; or drop `width` to auto-fit; or shorten the text |
| `label_too_tall` | wrapped label taller than the shape | raise `height` or shorten the text (BPMN and flowchart shapes have a fixed size: shorten) |
| `arrow_unbound` | an arrow end is free, or its id could not attach | add `start`/`end` ids, check the id spelling, bring the shapes closer |
| `arrow_crosses` | a straight arrow cuts through another shape | move that shape aside, or route via an extra box |
| `message_flow_same_pool` | a message flow joins two elements of one pool (or there are no pools) | use a `sequence` flow inside a pool; keep `message` for flows between two pools |
| `sequence_flow_crosses_pools` | a sequence flow joins elements of two pools | use a `message` flow between pools |
| `element_outside_pools` | a BPMN element is outside every pool, sticks out of one, or sits on its name band | move it fully inside a pool, right of the name bands |
| `lane_boundary` | an element straddles the line between two lanes | move it fully inside one lane |
| `image_fallback` | (Mermaid) diagram type was added as a picture | use flowchart, sequence, class, ER or state, or redraw with `create_diagram` |

A validation error (`Not drawn. N problems`) lists each problem as `type #position: what is wrong`. Fix all of them in one go.

## 5. No MCP: write the file by hand

Write a UTF-8 file named `something.excalidraw` containing JSON with this envelope:

```json
{"type":"excalidraw","version":2,"source":"https://sigil.apollyoncorp.com","elements":[ ... ],"appState":{"viewBackgroundColor":"#ffffff"},"files":{}}
```

Hand-written `elements` must be full Excalidraw elements, which is error prone. Keep it to rectangles, diamonds, text and arrows, and for every shape set `type, id, x, y, width, height, angle:0, strokeColor, backgroundColor, fillStyle:"solid", strokeWidth:2, strokeStyle:"solid", roughness:1, opacity:100, groupIds:[], frameId:null, roundness:null, seed, version:1, versionNonce, isDeleted:false, boundElements:null, updated:1, link:null, locked:false`. Put text in a separate `text` element (`text, fontSize:20, fontFamily:5, textAlign:"center", verticalAlign:"middle", containerId`) and list it in the shape's `boundElements` as `{"type":"text","id":"..."}`. Arrows need `points:[[0,0],[dx,dy]]` plus `startBinding`/`endBinding` `{elementId, focus:0, gap:6}` on both ends and a matching entry in each shape's `boundElements`. Same layout rules as above: grid, one axis, 60 px gaps. If you can run a command, installing sigil-mcp (`npx @apollyoncorp/sigil-mcp`) is far easier.
