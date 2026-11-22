import { getFontString } from "@excalidraw/common";

import { convert, FILE_SOURCE } from "../convert";
import { measureLine } from "../metrics";

import { GRID } from "./defs";

import type {
  Arrowhead,
  Part,
  Port,
  Pt,
  ShapeDef,
  Variant,
} from "./types";

// Excalidraw font family ids (packages/common/src/constants.ts)
const EXCALIFONT = 5;
const NUNITO = 6;

/**
 * The two looks of a shape set. "hand" is Sigil's default (hand-drawn lines,
 * Excalifont); "clean" has straight lines and the app's Normal font (Nunito).
 */
export const VARIANTS: Record<
  Variant,
  { roughness: number; fontFamily: number; label: string }
> = {
  hand: { roughness: 1, fontFamily: EXCALIFONT, label: "hand-drawn" },
  clean: { roughness: 0, fontFamily: NUNITO, label: "clean" },
};

const STROKE_COLOR = "#1e1e1e";
const DEFAULT_FONT_SIZE = 20;
const MIN_FONT_SIZE = 10;

// ------------------------------------------------------------- instances --

export type Box = { x: number; y: number; w: number; h: number };

type PieceMeta = {
  group?: string;
  /** text placed by its center (or left-middle) after it is measured */
  place?: {
    at: Pt;
    align: "center" | "left";
    rotate: boolean;
    /** wraps the text at this width instead of growing with it */
    width?: number;
  };
  closed?: boolean;
};

/** Skeleton elements (upstream format) plus what the compiler must finish. */
export type Piece = {
  skeleton: any[];
  meta: Map<string, PieceMeta>;
};

export type Instance = Piece & {
  id: string;
  def: ShapeDef;
  box: Box;
  /** id of the element arrows attach to, when the shape has one */
  anchor?: string;
  ports: Record<Port, Pt>;
};

export type PlaceOptions = {
  /** unique within the scene; prefix of every element id of the shape */
  id: string;
  x?: number;
  y?: number;
  variant?: Variant;
  /** replaces the default label */
  label?: string;
  /** lane names of a pool */
  labels?: string[];
  /** size, for the shapes marked resizable */
  w?: number;
  h?: number;
};

const portsOf = ({ x, y, w, h }: Box): Record<Port, Pt> => ({
  top: [x + w / 2, y],
  right: [x + w, y + h / 2],
  bottom: [x + w / 2, y + h],
  left: [x, y + h / 2],
});

const pointsBox = (points: readonly Pt[]) => {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Draws a shape at a position: skeleton elements, ports and anchor. */
export const placeShape = (def: ShapeDef, opts: PlaceOptions): Instance => {
  const variant = VARIANTS[opts.variant ?? "hand"];
  const ox = opts.x ?? 0;
  const oy = opts.y ?? 0;
  const w = def.resizable ? opts.w ?? def.w : def.w;
  const h = def.resizable ? opts.h ?? def.h : def.h;
  const drawing = def.draw({ w, h, label: opts.label, labels: opts.labels });
  const group = drawing.parts.length > 1 ? `${opts.id}.group` : undefined;

  const skeleton: any[] = [];
  const meta = new Map<string, PieceMeta>();
  let anchor: string | undefined;

  const look = (p: Part) => {
    const l = p as { strokeWidth?: number; strokeStyle?: string; backgroundColor?: string };
    return {
      strokeColor: STROKE_COLOR,
      backgroundColor: l.backgroundColor ?? "transparent",
      strokeWidth: l.strokeWidth ?? 2,
      strokeStyle: l.strokeStyle ?? "solid",
      roughness: variant.roughness,
    };
  };

  drawing.parts.forEach((part, i) => {
    const id = `${opts.id}.${i}`;
    meta.set(id, { group });
    switch (part.kind) {
      case "rectangle":
      case "ellipse":
      case "diamond":
        skeleton.push({
          type: part.kind,
          id,
          x: round2(ox + part.x),
          y: round2(oy + part.y),
          width: part.w,
          height: part.h,
          ...look(part),
          roundness: part.round ? { type: 3 } : null,
          label: part.label
            ? {
                text: part.label.text,
                fontSize: part.label.fontSize ?? DEFAULT_FONT_SIZE,
                fontFamily: variant.fontFamily,
              }
            : undefined,
        });
        if (i === drawing.anchor) {
          anchor = id;
        }
        break;
      case "line":
      case "arrow": {
        const pts =
          part.kind === "line" && part.closed
            ? [...part.points, part.points[0]]
            : part.points;
        const [x0, y0] = pts[0];
        const rel = pts.map((p) => [round2(p[0] - x0), round2(p[1] - y0)]);
        const b = pointsBox(rel as unknown as Pt[]);
        skeleton.push({
          type: part.kind,
          id,
          x: round2(ox + x0),
          y: round2(oy + y0),
          width: b.maxX - b.minX,
          height: b.maxY - b.minY,
          points: rel,
          ...look(part),
          ...(part.kind === "arrow"
            ? {
                startArrowhead: part.start ?? null,
                endArrowhead: part.end ?? null,
              }
            : { startArrowhead: null, endArrowhead: null }),
        });
        if (part.kind === "line" && part.closed) {
          meta.get(id)!.closed = true;
        }
        break;
      }
      case "text": {
        let size = part.fontSize ?? DEFAULT_FONT_SIZE;
        // shrink a name that is longer than its band
        while (
          part.fit &&
          size > MIN_FONT_SIZE &&
          measureLine(
            part.text,
            getFontString({ fontSize: size, fontFamily: variant.fontFamily as any }),
          ) > part.fit
        ) {
          size -= 1;
        }
        skeleton.push({
          type: "text",
          id,
          x: ox,
          y: oy,
          text: part.text,
          fontSize: size,
          fontFamily: variant.fontFamily,
          textAlign: part.align === "left" ? "left" : "center",
          strokeColor: STROKE_COLOR,
        });
        meta.get(id)!.place = {
          at: [round2(ox + part.at[0]), round2(oy + part.at[1])],
          align: part.align ?? "center",
          rotate: !!part.rotate,
          width: part.width,
        };
        break;
      }
    }
  });

  const box = { x: ox, y: oy, w, h };
  return { id: opts.id, def, box, anchor, ports: portsOf(box), skeleton, meta };
};

// ----------------------------------------------------------------- links --

export type LinkKind = "sequence" | "message" | "association";

export type End = { of: Instance; port?: Port };

const LINK_LOOK: Record<
  LinkKind,
  {
    type: "arrow" | "line";
    start: Arrowhead | null;
    end: Arrowhead | null;
    strokeStyle: "solid" | "dashed" | "dotted";
  }
> = {
  sequence: { type: "arrow", start: null, end: "triangle", strokeStyle: "solid" },
  message: {
    type: "arrow",
    start: "circle_outline",
    end: "triangle_outline",
    strokeStyle: "dashed",
  },
  association: { type: "line", start: null, end: null, strokeStyle: "dotted" },
};

const centerOf = (b: Box): Pt => [b.x + b.w / 2, b.y + b.h / 2];

const autoPort = (from: Box, to: Box): [Port, Port] => {
  const [fx, fy] = centerOf(from);
  const [tx, ty] = centerOf(to);
  const dx = tx - fx;
  const dy = ty - fy;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? ["right", "left"] : ["left", "right"];
  }
  return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
};

/**
 * Connects two placed shapes. Between shapes that have an anchor the arrow is
 * attached (it follows them when moved); otherwise it ends on their ports.
 */
export const link = (
  kind: LinkKind,
  from: End,
  to: End,
  opts: { id: string; label?: string; variant?: Variant } = { id: "link" },
): Piece => {
  const variant = VARIANTS[opts.variant ?? "hand"];
  const look = LINK_LOOK[kind];
  const [autoFrom, autoTo] = autoPort(from.of.box, to.of.box);
  const fromPort = from.port ?? autoFrom;
  const toPort = to.port ?? autoTo;
  const attached =
    look.type === "arrow" && !!from.of.anchor && !!to.of.anchor;
  const a = attached ? centerOf(from.of.box) : from.of.ports[fromPort];
  const b = attached ? centerOf(to.of.box) : to.of.ports[toPort];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const skeleton = {
    type: look.type,
    id: opts.id,
    x: round2(a[0]),
    y: round2(a[1]),
    width: Math.abs(dx),
    height: Math.abs(dy),
    points: [
      [0, 0],
      [round2(dx), round2(dy)],
    ],
    strokeColor: STROKE_COLOR,
    backgroundColor: "transparent",
    strokeWidth: 2,
    strokeStyle: look.strokeStyle,
    roughness: variant.roughness,
    startArrowhead: look.start,
    endArrowhead: look.end,
    ...(attached
      ? { start: { id: from.of.anchor }, end: { id: to.of.anchor } }
      : {}),
    label: opts.label
      ? {
          text: opts.label,
          fontSize: 16,
          fontFamily: variant.fontFamily,
        }
      : undefined,
  };
  return { skeleton: [skeleton], meta: new Map([[opts.id, {}]]) };
};

/** A free text, e.g. the name of an event placed under it. */
export const note = (
  id: string,
  text: string,
  at: Pt,
  opts: { variant?: Variant; align?: "center" | "left"; fontSize?: number } = {},
): Piece => {
  const variant = VARIANTS[opts.variant ?? "hand"];
  return {
    skeleton: [
      {
        type: "text",
        id,
        x: at[0],
        y: at[1],
        text,
        fontSize: opts.fontSize ?? 16,
        fontFamily: variant.fontFamily,
        textAlign: opts.align === "left" ? "left" : "center",
        strokeColor: STROKE_COLOR,
      },
    ],
    meta: new Map([
      [id, { place: { at, align: opts.align ?? "center", rotate: false } }],
    ]),
  };
};

// -------------------------------------------------------------- compile --

const hash32 = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

/**
 * Turns pieces into native elements with the fork's own converter, then makes
 * the result deterministic (ids of bound labels, seeds) so a generated library
 * does not change from one run to the next.
 */
export const compile = (pieces: Piece[]): any[] => {
  const skeleton = pieces.flatMap((p) => p.skeleton);
  const meta = new Map<string, PieceMeta>();
  for (const p of pieces) {
    for (const [k, v] of p.meta) {
      meta.set(k, v);
    }
  }

  const log = console.log;
  console.log = (...a: unknown[]) => console.error(...a);
  let out: any[];
  try {
    out = convert(skeleton);
  } finally {
    console.log = log;
  }

  // bound labels get ids derived from their container
  const renamed = new Map<string, string>();
  for (const el of out) {
    if (el.type === "text" && el.containerId) {
      renamed.set(el.id, `${el.containerId}.label`);
    }
  }
  for (const el of out) {
    el.id = renamed.get(el.id) ?? el.id;
    if (el.boundElements) {
      el.boundElements = el.boundElements.map((b: any) => ({
        ...b,
        id: renamed.get(b.id) ?? b.id,
      }));
    }
  }

  for (const el of out) {
    const own = meta.get(el.id) ?? meta.get(el.containerId ?? "");
    if (own?.group) {
      el.groupIds = [own.group];
    }
    const m = meta.get(el.id);
    if (m?.closed) {
      el.polygon = true;
    }
    if (m?.place && el.type === "text") {
      const [cx, cy] = m.place.at;
      el.x = round2(m.place.align === "left" ? cx : cx - el.width / 2);
      el.y = round2(cy - el.height / 2);
      if (m.place.rotate) {
        el.angle = Math.PI * 1.5;
      }
      if (m.place.width) {
        el.width = m.place.width;
        el.autoResize = false;
      }
    }
    el.seed = hash32(`${el.id}:seed`) % 2147483647;
    el.versionNonce = hash32(`${el.id}:nonce`) % 2147483647;
    el.updated = 1;
  }
  return out;
};

// --------------------------------------------------------------- library --

export type LibraryItem = {
  id: string;
  status: "published";
  created: number;
  name: string;
  elements: any[];
};

export type LibraryFile = {
  type: "excalidrawlib";
  version: 2;
  source: string;
  libraryItems: LibraryItem[];
};

/** One library item: the shape at its default size, at the origin. */
export const toLibraryItem = (def: ShapeDef, variant: Variant): LibraryItem => ({
  id: def.id,
  status: "published",
  created: 1,
  name: def.name,
  elements: compile([placeShape(def, { id: def.id, variant })]),
});

export const buildLibrary = (
  defs: ShapeDef[],
  variant: Variant,
): LibraryFile => ({
  type: "excalidrawlib",
  version: 2,
  source: FILE_SOURCE,
  libraryItems: defs.map((d) => toLibraryItem(d, variant)),
});

/** Axis-aligned bounds of a set of elements, the way the library lays them out. */
export const boundsOf = (elements: any[]) => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of elements) {
    if (el.type === "text" && el.containerId) {
      continue;
    }
    if ((el.type === "line" || el.type === "arrow") && el.points) {
      // the element's own x/y is its first point, not its top-left corner
      for (const [px, py] of el.points) {
        minX = Math.min(minX, el.x + px);
        minY = Math.min(minY, el.y + py);
        maxX = Math.max(maxX, el.x + px);
        maxY = Math.max(maxY, el.y + py);
      }
      continue;
    }
    // a rotated box is measured through its center
    const turned = Math.abs(Math.sin(el.angle || 0)) > 0.5;
    const w = turned ? el.height : el.width;
    const h = turned ? el.width : el.height;
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;
    minX = Math.min(minX, cx - w / 2);
    minY = Math.min(minY, cy - h / 2);
    maxX = Math.max(maxX, cx + w / 2);
    maxY = Math.max(maxY, cy + h / 2);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
};

export { GRID };
