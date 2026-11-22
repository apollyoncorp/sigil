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
