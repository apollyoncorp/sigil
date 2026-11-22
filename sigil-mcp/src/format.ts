export const FORMAT_SHEET = `# Sigil diagram format (create_diagram)

Call create_diagram with { elements: [...], path?: "/abs/dir/name.excalidraw" }.
Coordinates are px; x grows right, y grows down. Origin is arbitrary.

## Element fields
type        rectangle | ellipse | diamond | text | arrow | line | frame
id          unique string; REQUIRED on anything an arrow or frame refers to
x, y        top-left corner (required, except arrows with both start and end)
width, height
            shapes: omit to auto-fit the label (min 180x80, diamond min 180x100)
            arrow/line without ids: travel from x,y (can be negative)
            text: not allowed (size follows content; use fontSize)
label       { text, fontSize?, fontFamily? }  text INSIDE a shape or ON an arrow
text        type "text" only: the string; fontSize, fontFamily, textAlign
strokeColor border/line/text color   backgroundColor fill (shapes)
strokeStyle solid|dashed|dotted   strokeWidth 1|2|4   roughness 0 clean|1 sketchy
rounded     rounded corners (rectangle/diamond), default true
start, end  arrow only: { "id": "<shape id>" } attaches that end to the shape
startArrowhead, endArrowhead  arrow|triangle|bar|dot|null
children, name  frame only: ids it wraps, title
fontFamily  Excalifont (default) | Nunito | "Lilita One" | Cascadia

## Example: 3-node flowchart
{ "elements": [
  { "type": "rectangle", "id": "start", "x": 0,   "y": 0,   "label": { "text": "Start" }, "backgroundColor": "#a5d8ff" },
  { "type": "diamond",   "id": "ok",    "x": 0,   "y": 160, "label": { "text": "Valid?" }, "backgroundColor": "#ffec99" },
  { "type": "rectangle", "id": "done",  "x": 0,   "y": 340, "label": { "text": "Done" }, "backgroundColor": "#b2f2bb" },
  { "type": "arrow", "start": { "id": "start" }, "end": { "id": "ok" } },
  { "type": "arrow", "start": { "id": "ok" }, "end": { "id": "done" }, "label": { "text": "yes" } }
], "path": "/abs/path/flow.excalidraw" }

## BPMN and flowchart shapes
Entries of the same list, next to plain elements. Size is fixed; x, y is the top-left corner.
{ "shape": "bpmn.task", "id": "t1", "x": 0, "y": 0, "label": "Review request" }
{ "flow": "sequence" | "message" | "association", "from": "t1", "to": "g1", "label": "yes" }
shape   bpmn.start-event, bpmn.timer-start-event, bpmn.message-start-event, bpmn.intermediate-event,
        bpmn.intermediate-message-event, bpmn.end-event (40x40; label = name drawn below)
        bpmn.task (160x80), bpmn.sub-process (label inside, 2 lines at most)
        bpmn.exclusive-gateway, bpmn.parallel-gateway, bpmn.inclusive-gateway, bpmn.event-gateway
        (56x56; label above)
        bpmn.data-object, bpmn.data-store (label below), bpmn.text-annotation (label inside; width, height)
        bpmn.pool  label = pool name; "lanes": ["Agent","Specialist"] cuts it into lanes;
        width (default 800), height (default 160 per lane)
        flow.terminator, flow.process, flow.decision, flow.input-output, flow.document,
        flow.predefined-process, flow.database, flow.manual-input, flow.connector
labelSide  top|right|bottom|left: side of the name of an event, gateway or data shape (keeps it clear of flows)
id      required, unique, letters, numbers, - and _ only (no dots)
flow    sequence = solid arrow: order of steps INSIDE one pool (also between lanes)
        message  = dashed arrow: BETWEEN two pools only
        association = dotted line to data / annotation
Flows attach to shapes and join center to center; they cannot end on a pool, only on
the elements inside it. Draw pools first (they sit behind). Every event, task and gateway
goes fully inside one lane, right of the name bands (32px; 64px with lanes).
Extra warnings: message_flow_same_pool, sequence_flow_crosses_pools, element_outside_pools, lane_boundary.

## Example: two pools, one message
{ "elements": [
  { "shape": "bpmn.pool", "id": "cust", "x": 0, "y": 0,   "width": 640, "height": 160, "label": "Customer" },
  { "shape": "bpmn.pool", "id": "shop", "x": 0, "y": 240, "width": 640, "height": 160, "label": "Shop" },
  { "shape": "bpmn.start-event", "id": "s", "x": 80, "y": 60, "label": "Need item" },
  { "shape": "bpmn.task", "id": "order", "x": 160, "y": 40, "label": "Place order" },
  { "shape": "bpmn.task", "id": "ship", "x": 360, "y": 280, "label": "Ship order" },
  { "shape": "bpmn.end-event", "id": "e", "x": 580, "y": 300, "label": "Shipped" },
  { "flow": "sequence", "from": "s", "to": "order" },
  { "flow": "message", "from": "order", "to": "ship", "label": "order" },
  { "flow": "sequence", "from": "ship", "to": "e" }
], "path": "/abs/path/shop.excalidraw" }

## Layout tips
- Default box 180x80 (diamond 180x100). Omit width/height and the box fits its label.
- Put boxes on a grid: columns 260px apart, rows 160px apart (gaps of 60-80px for arrows).
- Flow top-down (increasing y) or left-right (increasing x); do not mix.
- Branch a decision to the left and right of the diamond; merge back below.
- Never place shapes so they overlap; the report lists any that do.
- Attach arrows with start/end ids instead of guessing coordinates.
- Keep labels short (under ~30 chars); long text wraps and grows the box.
- Palette that reads well: #a5d8ff blue, #b2f2bb green, #ffec99 yellow, #ffc9c9 red, #d0bfff purple, #e9ecef gray; stroke #1e1e1e.
- Read the "warnings" in the result, fix them and call again with the same path to overwrite.
`;
