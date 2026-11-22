import { getFontString, getLineHeight } from "@excalidraw/common";
import {
  convertToExcalidrawElements,
  getBoundTextMaxHeight,
  getBoundTextMaxWidth,
  setCustomTextMetricsProvider,
} from "@excalidraw/element";

import { measureLine, textMetricsProvider } from "./metrics";
import { FONT_IDS, type Skeleton } from "./schema";
import { describeElement } from "./validate";

// Excalidraw would measure text on a canvas, which Node has not. Use the
// real font advance widths instead (see metrics/).
setCustomTextMetricsProvider(textMetricsProvider as any);

export const FILE_SOURCE = "https://sigil.apollyoncorp.com";

export type Warning = { code: string; message: string };

export type Rect = { x: number; y: number; w: number; h: number };

const DEFAULT_FONT_SIZE = 20;
const MIN_W = 180;
const MIN_H = 80;
const MIN_DIAMOND_H = 100;
const MAX_AUTO_W = 320;
const PAD = 5; // BOUND_TEXT_PADDING
const COMFORT = 28; // extra horizontal room around an auto-fitted label

const fontIdOf = (name?: string) =>
  name ? FONT_IDS[name as keyof typeof FONT_IDS] : FONT_IDS.Excalifont;

const fontStringOf = (size: number, familyId: number) =>
  getFontString({ fontSize: size, fontFamily: familyId as any });

const maxLineWidth = (text: string, font: string) =>
  Math.max(...text.split("\n").map((l) => measureLine(l, font)));

/** Greedy word wrap, to estimate how many lines a label takes in `maxWidth`. */
const countWrappedLines = (text: string, font: string, maxWidth: number) => {
  let lines = 0;
  for (const paragraph of text.split("\n")) {
    let current = "";
    let n = 1;
    for (const word of paragraph.split(/(\s+)/)) {
      const next = current + word;
      if (current && measureLine(next.trimEnd(), font) > maxWidth) {
        n++;
        current = word.trimStart();
      } else {
        current = next;
      }
    }
    lines += n;
  }
  return lines;
};

/** Smallest container width whose inscribed text box is `textWidth` wide. */
const widthForText = (type: string, textWidth: number) => {
  const need = textWidth + PAD * 2 + COMFORT;
  if (type === "ellipse") {
    return (need * 2) / Math.SQRT2;
  }
  if (type === "diamond") {
    return need * 2;
  }
  return need;
};

const heightForText = (type: string, textHeight: number) => {
  if (type === "ellipse") {
    return ((textHeight + PAD * 2 + 20) * 2) / Math.SQRT2;
  }
  if (type === "diamond") {
    return (textHeight + PAD * 2 + 10) * 2;
  }
  return textHeight + PAD * 2 + 22;
};

const round = (n: number) => Math.ceil(n / 10) * 10;

/** Fills in width/height of shapes (auto-fit to the label, min 180x80). */
const autoSize = (el: Skeleton) => {
  const type = el.type;
  const minH = type === "diamond" ? MIN_DIAMOND_H : MIN_H;
  let width = el.width;
  let height = el.height;
  if (el.label) {
    const size = el.label.fontSize ?? DEFAULT_FONT_SIZE;
    const family = fontIdOf(el.label.fontFamily);
    const font = fontStringOf(size, family);
    const lineH = size * getLineHeight(family as any);
    if (width === undefined) {
      const natural = maxLineWidth(el.label.text, font);
      const cap = type === "rectangle" ? MAX_AUTO_W : MAX_AUTO_W + 40;
      width = Math.min(cap, Math.max(MIN_W, round(widthForText(type, natural))));
    }
    if (height === undefined) {
      const textMax = getBoundTextMaxWidth(
        { type, width } as any,
        null,
      );
      const lines = countWrappedLines(el.label.text, font, textMax);
      height = Math.max(minH, round(heightForText(type, lines * lineH)));
    }
  }
  return { width: width ?? MIN_W, height: height ?? minH };
};

const stripUndefined = <T extends Record<string, unknown>>(o: T): T => {
  for (const k of Object.keys(o)) {
    if (o[k] === undefined) {
      delete o[k];
    }
  }
  return o;
};

export type Prepared = {
  /** skeleton in upstream format */
  skeleton: any[];
  /** position of each element in the list the caller sent (shapes and flows were taken out) */
  positions: number[];
  /** id -> 1-based index in the user's list */
  indexById: Map<string, number>;
  /** user element by id */
  byId: Map<string, Skeleton>;
};

/** Turns the validated tool input into upstream skeleton elements. */
export const prepare = (
  elements: Skeleton[],
  opts: { positions?: number[]; reserved?: Iterable<string> } = {},
): Prepared => {
  const used = new Set([
    ...(elements.map((e) => e.id).filter(Boolean) as string[]),
    ...(opts.reserved ?? []),
  ]);
  const withIds = elements.map((el, i) => {
    if (el.id) {
      return el;
    }
    let id = `${el.type}-${i + 1}`;
    while (used.has(id)) {
      id += "_";
    }
    used.add(id);
    return { ...el, id };
  });

  const indexById = new Map<string, number>();
  const byId = new Map<string, Skeleton>();
  withIds.forEach((el, i) => {
    indexById.set(el.id!, i);
    byId.set(el.id!, el);
  });

  // sizes of shapes, needed to aim arrows at their centers
  const rects = new Map<string, Rect>();
  for (const el of withIds) {
    if (el.type === "rectangle" || el.type === "ellipse" || el.type === "diamond") {
      const { width, height } = autoSize(el);
      rects.set(el.id!, { x: el.x ?? 0, y: el.y ?? 0, w: width, h: height });
    } else if (el.type === "text" && el.text) {
      const size = el.fontSize ?? DEFAULT_FONT_SIZE;
      const family = fontIdOf(el.fontFamily);
      const font = fontStringOf(size, family);
      rects.set(el.id!, {
        x: el.x ?? 0,
        y: el.y ?? 0,
        w: maxLineWidth(el.text, font),
        h: el.text.split("\n").length * size * getLineHeight(family as any),
      });
    }
  }

  const label = (l: Skeleton["label"]) =>
    l
      ? stripUndefined({
          text: l.text,
          fontSize: l.fontSize,
          fontFamily: l.fontFamily ? fontIdOf(l.fontFamily) : undefined,
        })
      : undefined;

  const common = (el: Skeleton) => ({
    id: el.id,
    strokeColor: el.strokeColor,
    backgroundColor: el.backgroundColor,
    strokeStyle: el.strokeStyle,
    strokeWidth: el.strokeWidth,
    roughness: el.roughness,
  });

  const skeleton = withIds.map((el) => {
    switch (el.type) {
      case "rectangle":
      case "ellipse":
      case "diamond": {
        const { width, height } = autoSize(el);
        const rounded = el.rounded ?? true;
        return stripUndefined({
          type: el.type,
          ...common(el),
          x: el.x,
          y: el.y,
          width,
          height,
          roundness:
            rounded && el.type !== "ellipse" ? { type: 3 } : undefined,
          label: label(el.label),
        });
      }
      case "text":
        return stripUndefined({
          type: "text",
          ...common(el),
          x: el.x,
          y: el.y,
          text: el.text,
          fontSize: el.fontSize,
          fontFamily: el.fontFamily ? fontIdOf(el.fontFamily) : undefined,
          textAlign: el.textAlign,
        });
      case "line":
        return stripUndefined({
          type: "line",
          ...common(el),
          x: el.x,
          y: el.y,
          // explicit points: upstream turns a 0 width/height into 100
          width: el.width ?? 0,
          height: el.height ?? 0,
          points: [
            [0, 0],
            [el.width ?? 0, el.height ?? 0],
          ],
          startArrowhead: el.startArrowhead,
          endArrowhead: el.endArrowhead,
        });
      case "arrow": {
        let { x, y, width, height } = el;
        const a = el.start && rects.get(el.start.id);
        const b = el.end && rects.get(el.end.id);
        if (a && b) {
          // aim center to center; the binding trims the ends to the outlines
          x = a.x + a.w / 2;
          y = a.y + a.h / 2;
          width = b.x + b.w / 2 - x;
          height = b.y + b.h / 2 - y;
        }
        return stripUndefined({
          type: "arrow",
          ...common(el),
          x,
          y,
          width: width ?? 0,
          height: height ?? 0,
          points: [
            [0, 0],
            [width ?? 0, height ?? 0],
          ],
          start: el.start ? { id: el.start.id } : undefined,
          end: el.end ? { id: el.end.id } : undefined,
          startArrowhead: el.startArrowhead,
          endArrowhead: el.endArrowhead,
          label: label(el.label),
        });
      }
      case "frame":
        return stripUndefined({
          type: "frame",
          ...common(el),
          children: el.children,
          name: el.name,
        });
    }
  });

  return {
    skeleton,
    positions: opts.positions ?? elements.map((_, i) => i),
    indexById,
    byId,
  };
};

export type ExcalidrawFile = {
  type: "excalidraw";
  version: 2;
  source: string;
  elements: any[];
  appState: { viewBackgroundColor: string };
  files: Record<string, unknown>;
};

export const buildFile = (
  elements: any[],
  files: Record<string, unknown> = {},
): ExcalidrawFile => ({
  type: "excalidraw",
  version: 2,
  source: FILE_SOURCE,
  elements,
  appState: { viewBackgroundColor: "#ffffff" },
  files,
});

/** Runs the fork's converter on upstream-format skeleton elements. */
export const convert = (skeleton: any[]) =>
  convertToExcalidrawElements(skeleton as any, { regenerateIds: false }) as any[];

// ---------------------------------------------------------------- layout --

export const rectOf = (el: any): Rect => ({ x: el.x, y: el.y, w: el.width, h: el.height });

export const contains = (a: Rect, b: Rect, tol = 1) =>
  b.x >= a.x - tol &&
  b.y >= a.y - tol &&
  b.x + b.w <= a.x + a.w + tol &&
  b.y + b.h <= a.y + a.h + tol;

export const intersection = (a: Rect, b: Rect) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? { w, h } : null;
};

export type Namer = (id: string) => string;

/**
 * Layout report on the converted elements: partial overlaps between shapes,
 * labels that do not fit their shape, arrow ends that are not attached and
 * straight arrows that cut through a shape they do not connect.
 */
export const layoutReport = (
  elements: any[],
  name: Namer,
  requested: Map<string, { start?: string; end?: string }> = new Map(),
  /** shapes whose width the caller set: only those can be told "too narrow" */
  explicitWidth: Set<string> = new Set(),
): Warning[] => {
  const warnings: Warning[] = [];
  const live = elements.filter((e) => !e.isDeleted);
  const shapes = live.filter((e) =>
    ["rectangle", "ellipse", "diamond"].includes(e.type),
  );
  const textsById = new Map(live.filter((e) => e.type === "text").map((e) => [e.id, e]));

  // overlaps: partial only. A shape fully inside another is read as grouping.
  const boxes = [
    ...shapes,
    ...live.filter((e) => e.type === "text" && !e.containerId),
  ];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = rectOf(boxes[i]);
      const b = rectOf(boxes[j]);
      const hit = intersection(a, b);
      if (hit && hit.w * hit.h > 16 && !contains(a, b) && !contains(b, a)) {
        warnings.push({
          code: "overlap",
          message: `${name(boxes[i].id)} overlaps ${name(boxes[j].id)} by ${Math.round(hit.w)}x${Math.round(hit.h)}px. Move one so there is a gap of 60px or more.`,
        });
      }
    }
  }

  // labels
  for (const shape of shapes) {
    const textRef = (shape.boundElements ?? []).find((b: any) => b.type === "text");
    const text: any = textRef && textsById.get(textRef.id);
    if (!text) {
      continue;
    }
    const font = fontStringOf(text.fontSize, text.fontFamily);
    const natural = maxLineWidth(text.originalText ?? text.text, font);
    const maxW = getBoundTextMaxWidth(shape, text);
    if (natural > maxW + 1 && explicitWidth.has(shape.id)) {
      const need = Math.ceil(widthForText(shape.type, natural) / 10) * 10;
      warnings.push({
        code: "label_too_wide",
        message: `Label of ${name(shape.id)} is ${Math.round(natural)}px wide but the ${shape.type} fits ${Math.round(maxW)}px per line, so it wraps. Set width to ${need} or more, or shorten the text.`,
      });
    }
    if (text.height > getBoundTextMaxHeight(shape, text) + 1) {
      warnings.push({
        code: "label_too_tall",
        message: `Label of ${name(shape.id)} is ${Math.round(text.height)}px tall and does not fit inside the ${shape.type} (${Math.round(shape.height)}px high). Increase height or shorten the text.`,
      });
    }
  }

  // arrows
  for (const arrow of live.filter((e) => e.type === "arrow")) {
    const asked = requested.get(arrow.id) ?? {};
    for (const side of ["start", "end"] as const) {
      const binding = side === "start" ? arrow.startBinding : arrow.endBinding;
      if (binding) {
        continue;
      }
      warnings.push(
        asked[side]
          ? {
              code: "arrow_unbound",
              message: `${name(arrow.id)}: ${side}.id '${asked[side]}' could not be attached (the end ended up too far from the shape). Move the shapes closer or fix the id.`,
            }
          : {
              code: "arrow_unbound",
              message: `${name(arrow.id)}: ${side} is not attached to any shape. Add ${side}: {"id": "..."} so it follows the shape when moved.`,
            },
      );
    }
    if (arrow.points.length === 2) {
      const p0: [number, number] = [arrow.x + arrow.points[0][0], arrow.y + arrow.points[0][1]];
      const p1: [number, number] = [arrow.x + arrow.points[1][0], arrow.y + arrow.points[1][1]];
      const skip = new Set([arrow.startBinding?.elementId, arrow.endBinding?.elementId]);
      for (const shape of shapes) {
        if (skip.has(shape.id)) {
          continue;
        }
        const r = rectOf(shape);
        const inner = { x: r.x + 4, y: r.y + 4, w: r.w - 8, h: r.h - 8 };
        if (segmentCrosses(p0, p1, inner)) {
          warnings.push({
            code: "arrow_crosses",
            message: `${name(arrow.id)} passes through ${name(shape.id)}. Move that shape aside or use an elbow of two arrows.`,
          });
        }
      }
    }
  }
  return warnings;
};

export const segmentCrosses = (p0: [number, number], p1: [number, number], r: Rect) => {
  // slab method
  let tmin = 0;
  let tmax = 1;
  const d = [p1[0] - p0[0], p1[1] - p0[1]];
  const lo = [r.x, r.y];
  const hi = [r.x + r.w, r.y + r.h];
  for (let k = 0; k < 2; k++) {
    if (Math.abs(d[k]) < 1e-9) {
      if (p0[k] < lo[k] || p0[k] > hi[k]) {
        return false;
      }
    } else {
      let t1 = (lo[k] - p0[k]) / d[k];
      let t2 = (hi[k] - p0[k]) / d[k];
      if (t1 > t2) {
        [t1, t2] = [t2, t1];
      }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) {
        return false;
      }
    }
  }
  return true;
};

export const namerFor = (prep: Prepared): Namer => {
  const list = [...prep.byId.values()];
  return (id: string) => {
    const idx = prep.indexById.get(id);
    return idx === undefined
      ? id
      : describeElement(list[idx], prep.positions[idx] ?? idx);
  };
};

export const explicitWidths = (prep: Prepared) =>
  new Set(
    [...prep.byId.values()]
      .filter((el) => el.width !== undefined)
      .map((el) => el.id!),
  );

export const requestedBindings = (prep: Prepared) => {
  const m = new Map<string, { start?: string; end?: string }>();
  for (const el of prep.byId.values()) {
    if (el.type === "arrow") {
      m.set(el.id!, { start: el.start?.id, end: el.end?.id });
    }
  }
  return m;
};
