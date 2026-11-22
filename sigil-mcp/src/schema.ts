import { z } from "zod";

// The documented subset of ExcalidrawElementSkeleton
// (packages/element/src/transform.ts) that the tools accept. Kept flat (one
// object, `type` selects the kind) so the JSON schema stays short for the
// model reading it; per-type rules are enforced, with readable messages, in
// validate.ts.

export const ELEMENT_TYPES = [
  "rectangle",
  "ellipse",
  "diamond",
  "text",
  "arrow",
  "line",
  "frame",
] as const;

export const FONT_NAMES = [
  "Excalifont",
  "Nunito",
  "Lilita One",
  "Cascadia",
] as const;

/** Excalidraw FONT_FAMILY ids (packages/common/src/constants.ts). */
export const FONT_IDS: Record<(typeof FONT_NAMES)[number], number> = {
  Excalifont: 5,
  Nunito: 6,
  "Lilita One": 7,
  Cascadia: 3,
};

const ARROWHEADS = ["arrow", "triangle", "bar", "dot"] as const;

const color = z
  .string()
  .describe('CSS color, e.g. "#1e1e1e", "#a5d8ff" or "transparent"');

const fontFamily = z
  .enum(FONT_NAMES)
  .describe(
    "Excalifont (default, hand-drawn), Nunito (clean sans), Lilita One (bold display), Cascadia (monospace)",
  );

const bindRef = z
  .object({
    id: z.string().describe("id of a rectangle, ellipse, diamond or text in this same list"),
  })
  .strict();

export const labelSchema = z
  .object({
    text: z.string().min(1).describe("Text drawn inside the shape or on the arrow. Use \\n for line breaks."),
    fontSize: z.number().positive().optional().describe("px, default 20"),
    fontFamily: fontFamily.optional(),
  })
  .strict();

export const elementSchema = z
  .object({
    type: z.enum(ELEMENT_TYPES),
    id: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Unique id. Needed on anything an arrow or frame points to. Short and meaningful: "api", "db".',
      ),
    x: z.number().optional().describe("Left edge, px. Arrows between two ids may omit it."),
    y: z.number().optional().describe("Top edge, px. Arrows between two ids may omit it."),
    width: z
      .number()
      .optional()
      .describe(
        "Shapes: omit to auto-fit the label (min 180). Arrows without ids: horizontal travel, may be negative.",
      ),
    height: z
      .number()
      .optional()
      .describe(
        "Shapes: omit to auto-fit the label (min 80, diamonds 100). Arrows without ids: vertical travel, may be negative.",
      ),
    label: labelSchema
      .optional()
      .describe("Text inside a rectangle/ellipse/diamond, or on an arrow. Not for text/line/frame."),
    text: z.string().optional().describe('Only for type "text": the content.'),
    fontSize: z.number().positive().optional().describe('Only for type "text", px, default 20'),
    fontFamily: fontFamily.optional().describe('Only for type "text"'),
    textAlign: z.enum(["left", "center", "right"]).optional().describe('Only for type "text"'),
    strokeColor: color.optional().describe("Border / line / text color. Default #1e1e1e"),
    backgroundColor: color.optional().describe("Fill color of shapes. Default transparent"),
    strokeStyle: z.enum(["solid", "dashed", "dotted"]).optional(),
    strokeWidth: z.number().positive().optional().describe("1 thin, 2 normal (default), 4 bold"),
    roughness: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe("0 = clean lines, 1 = hand-drawn (default), 2 = very sketchy"),
    rounded: z
      .boolean()
      .optional()
      .describe("Rounded corners for rectangle/diamond. Default true"),
    start: bindRef
      .optional()
      .describe('Arrow only. Attach the tail to the shape with this id: {"id":"a"}'),
    end: bindRef
      .optional()
      .describe('Arrow only. Attach the head to the shape with this id: {"id":"b"}'),
    startArrowhead: z.enum(ARROWHEADS).nullable().optional().describe("Arrow/line only. Default none"),
    endArrowhead: z.enum(ARROWHEADS).nullable().optional().describe("Arrow/line only. Default arrow for arrows"),
    children: z
      .array(z.string())
      .optional()
      .describe('Frame only: ids of the elements the frame wraps'),
    name: z.string().optional().describe("Frame only: title shown above the frame"),
  })
  .strict();

export type Skeleton = z.infer<typeof elementSchema>;
export type Label = z.infer<typeof labelSchema>;

export const MAX_ELEMENTS = 400;
