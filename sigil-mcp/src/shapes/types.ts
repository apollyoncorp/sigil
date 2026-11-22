// Shape definitions are plain data: a shape draws itself as a list of parts in
// its own coordinates (origin at the top-left corner). The builder turns the
// parts into native elements (rectangle, ellipse, diamond, line, arrow, text),
// so a placed shape stays fully editable and round-trips through .excalidraw.

export type Pt = readonly [number, number];

export type Variant = "hand" | "clean";

export type Arrowhead =
  | "arrow"
  | "bar"
  | "circle"
  | "circle_outline"
  | "triangle"
  | "triangle_outline"
  | "diamond"
  | "diamond_outline";

export type Look = {
  strokeWidth?: number;
  strokeStyle?: "solid" | "dashed" | "dotted";
  backgroundColor?: string;
};

export type BodyPart = {
  kind: "rectangle" | "ellipse" | "diamond";
  x: number;
  y: number;
  w: number;
  h: number;
  /** rounded corners (rectangles) */
  round?: boolean;
  /** text bound to the shape, centered */
  label?: { text: string; fontSize?: number };
} & Look;

export type LinePart = {
  kind: "line";
  points: readonly Pt[];
  /** joins the last point to the first and marks the line as a polygon */
  closed?: boolean;
} & Look;

export type ArrowPart = {
  kind: "arrow";
  points: readonly Pt[];
  start?: Arrowhead | null;
  end?: Arrowhead | null;
} & Look;

export type TextPart = {
  kind: "text";
  /** the center of the text, or its left-middle point when align is "left" */
  at: Pt;
  text: string;
  fontSize?: number;
  align?: "center" | "left";
  /** longest the text may be (px); the font size shrinks to fit */
  fit?: number;
  /** a box of this width that wraps the text, so the shape keeps its size */
  width?: number;
  /** turned a quarter counter-clockwise, to read bottom to top */
  rotate?: boolean;
};

export type Part = BodyPart | LinePart | ArrowPart | TextPart;

export type Port = "top" | "right" | "bottom" | "left";

export type DrawArgs = {
  w: number;
  h: number;
  label?: string;
  labels?: string[];
};

export type Drawing = {
  parts: Part[];
  /**
   * Index of the part that arrows attach to (a rectangle, ellipse or diamond).
   * Shapes drawn as an outline only have none: arrows end on their ports.
   */
  anchor?: number;
};

export type ShapeSet = "bpmn" | "flowchart";

export type ShapeDef = {
  /** stable id, also the id of the library item: "bpmn-task" */
  id: string;
  set: ShapeSet;
  /** library item name (the library search matches it): "BPMN: Task" */
  name: string;
  /** default size, on the 8px grid */
  w: number;
  h: number;
  /** text the shape starts with, when it has a label */
  label?: string;
  /** may be drawn at another size (pool, annotation) */
  resizable?: boolean;
  draw: (args: DrawArgs) => Drawing;
};
