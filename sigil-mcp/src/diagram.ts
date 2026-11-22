import { getFontString, getLineHeight } from "@excalidraw/common";
import { z } from "zod";

import {
  contains,
  intersection,
  rectOf,
  segmentCrosses,
  type Namer,
  type Prepared,
  type Rect,
  type Warning,
} from "./convert";
import { measureLine } from "./metrics";
import {
  ALL_SHAPES,
  POOL_BAND,
  VARIANTS,
  link,
  note,
  placeShape,
  shapeById,
  type Instance,
  type LinkKind,
  type Piece,
  type ShapeDef,
} from "./shapes";

import { elementSchema, type Skeleton } from "./schema";

// BPMN and flowchart shapes in create_diagram. The shapes themselves live in
// ./shapes (the same code that writes the libraries shipped with the editor);
// this file only maps the tool input onto them and checks the result.

// ---------------------------------------------------------------- schema --

/** Library items that are drawn by a "flow" entry or chosen by "lanes". */
const NOT_A_SHAPE = new Set([
  "bpmn-sequence-flow",
  "bpmn-message-flow",
  "bpmn-association",
  "bpmn-pool-lanes",
]);

/** "bpmn-task" -> "bpmn.task", "flow-process" -> "flow.process" */
const nameOf = (id: string) => id.replace("-", ".");

const DEFS = ALL_SHAPES.filter((d) => !NOT_A_SHAPE.has(d.id));
const DEF_BY_NAME = new Map(DEFS.map((d) => [nameOf(d.id), d]));

export const SHAPE_NAMES = DEFS.map((d) => nameOf(d.id)) as [string, ...string[]];
export const FLOW_KINDS = ["sequence", "message", "association"] as const;

const MAX_LANES = 8;
const ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const ID_HINT = "letters, digits, '-' and '_', starting with a letter (no dots or spaces)";

export const shapeSchema = z
  .object({
    shape: z
      .enum(SHAPE_NAMES)
      .describe(
        'BPMN or flowchart shape, e.g. "bpmn.task", "bpmn.exclusive-gateway", "bpmn.pool", "flow.process". describe_format lists them all.',
      ),
    id: z
      .string()
      .regex(ID, `id must be ${ID_HINT}`)
      .describe('Unique id; flows refer to it. Short and meaningful: "review", "g1".'),
    x: z.number().describe("Left edge, px"),
    y: z.number().describe("Top edge, px"),
    label: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Task, sub-process, annotation and flowchart shapes: text inside. Events, gateways, data: name drawn next to the shape (below; gateways above). Pool: its name. Use \\n for line breaks.",
      ),
    labelSide: z
      .enum(["top", "right", "bottom", "left"])
      .optional()
      .describe(
        "Events, gateways and data only: which side of the shape the name is drawn on. Default bottom (gateways: top). Use it to keep the name clear of flows.",
      ),
    lanes: z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_LANES)
      .optional()
      .describe('bpmn.pool only: lane names, top to bottom, e.g. ["Agent","Specialist"]. The pool is cut into equal lanes.'),
    width: z
      .number()
      .positive()
      .optional()
      .describe("bpmn.pool (default 800) and bpmn.text-annotation (default 160) only. Other shapes have a fixed size."),
    height: z
      .number()
      .positive()
      .optional()
      .describe("bpmn.pool (default 160 per lane) and bpmn.text-annotation (default 48) only."),
  })
  .strict();

export const flowSchema = z
  .object({
    flow: z
      .enum(FLOW_KINDS)
      .describe(
        'sequence: solid arrow, order of steps INSIDE one pool. message: dashed arrow BETWEEN two pools. association: dotted line to a data object, data store or annotation.',
      ),
    from: z.string().min(1).describe("id of a shape entry"),
    to: z.string().min(1).describe("id of a shape entry"),
    label: z.string().min(1).optional().describe('Text on the flow, e.g. "yes"'),
    id: z.string().regex(ID, `id must be ${ID_HINT}`).optional(),
  })
  .strict();

/** One item of the elements list: a primitive element, a shape or a flow. */
export const entrySchema = z.union([elementSchema, shapeSchema, flowSchema]);

export type ShapeEntry = z.infer<typeof shapeSchema>;
export type FlowEntry = z.infer<typeof flowSchema>;
export type Entry = Skeleton | ShapeEntry | FlowEntry;

export const isShape = (e: Entry): e is ShapeEntry => "shape" in e;
export const isFlow = (e: Entry): e is FlowEntry => "flow" in e;

export type Split = {
  /** primitive elements, in list order */
  prims: Skeleton[];
  /** position of each primitive in the list */
  positions: number[];
  shapes: { entry: ShapeEntry; index: number }[];
  flows: { entry: FlowEntry; index: number }[];
};

export const splitEntries = (entries: Entry[]): Split => {
  const split: Split = { prims: [], positions: [], shapes: [], flows: [] };
  entries.forEach((entry, index) => {
    if (isShape(entry)) {
      split.shapes.push({ entry, index });
    } else if (isFlow(entry)) {
      split.flows.push({ entry, index });
    } else {
      split.prims.push(entry);
      split.positions.push(index);
    }
  });
  return split;
};

/** ids taken by shape entries and by flows that name themselves */
export const claimedIds = (split: Split) => {
  const ids = new Map<string, "shape" | "flow">();
  for (const { entry } of split.shapes) {
    ids.set(entry.id, "shape");
  }
  for (const { entry } of split.flows) {
    if (entry.id) {
      ids.set(entry.id, "flow");
    }
  }
  return ids;
};

// ------------------------------------------------------------ validation --

const truncate = (s: string, n = 28) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s.replace(/\n/g, " ");

const describeShape = (e: ShapeEntry, index: number) =>
  `${e.shape} #${index + 1} (id '${e.id}'${e.label ? `, "${truncate(e.label)}"` : ""})`;

const describeFlow = (e: FlowEntry, index: number) =>
  `${e.flow} flow #${index + 1} (${e.from} -> ${e.to})`;

const RESIZABLE = new Set(["bpmn.pool", "bpmn.text-annotation"]);
const ARTIFACTS = new Set(["bpmn.data-object", "bpmn.data-store", "bpmn.text-annotation"]);

/** Problems in the shape and flow entries (the primitives are checked in validate.ts). */
export const validateShapes = (
  split: Split,
  /** ids of the primitive elements */
  primIds: Set<string>,
  primTypes: Map<string, string>,
): string[] => {
  const errors: string[] = [];
  const shapeById = new Map(split.shapes.map((s) => [s.entry.id, s]));
  const seen = new Map<string, string>();

  for (const { entry: e, index } of split.shapes) {
    const who = describeShape(e, index);
    const first = seen.get(e.id);
    if (first) {
      errors.push(`${who}: duplicate id '${e.id}' (already used by ${first}). Ids must be unique.`);
    }
    seen.set(e.id, who);
    for (const id of primIds) {
      if (id.startsWith(`${e.id}.`)) {
        errors.push(`${who}: element id '${id}' clashes with the shape's own parts; rename one of them.`);
      }
    }
    if (e.labelSide) {
      const def = DEF_BY_NAME.get(e.shape)!;
      if (def.label !== undefined) {
        errors.push(
          `${who}: 'labelSide' is only for events, gateways and data (their name is drawn beside the shape); the label of ${e.shape} is inside it.`,
        );
      }
    }
    if (e.lanes && e.shape !== "bpmn.pool") {
      errors.push(`${who}: 'lanes' is only for bpmn.pool.`);
    }
    for (const f of ["width", "height"] as const) {
      if (e[f] !== undefined && !RESIZABLE.has(e.shape)) {
        errors.push(
          `${who}: '${f}' is only for ${[...RESIZABLE].join(" and ")}; ${e.shape} has a fixed size.`,
        );
      }
    }
  }

  const flowIds = new Map<string, string>();
  for (const { entry: e, index } of split.flows) {
    const who = describeFlow(e, index);
    if (e.id) {
      const other = seen.get(e.id) ?? flowIds.get(e.id);
      if (other) {
        errors.push(`${who}: duplicate id '${e.id}' (already used by ${other}). Ids must be unique.`);
      }
      flowIds.set(e.id, who);
    }
    const ends: ShapeEntry[] = [];
    for (const side of ["from", "to"] as const) {
      const ref = e[side];
      const target = shapeById.get(ref);
      if (target) {
        ends.push(target.entry);
        continue;
      }
      const prim = primTypes.get(ref);
      errors.push(
        prim
          ? `${who}: ${side} '${ref}' is ${/^[aeiou]/.test(prim) ? "an" : "a"} ${prim}; flows connect shape entries. Use an arrow with start/end between plain elements.`
          : `${who}: ${side} '${ref}' not found. Shape ids: ${[...shapeById.keys()].join(", ") || "(none yet)"}.`,
      );
    }
    if (e.from === e.to) {
      errors.push(`${who}: from and to are the same id; a flow needs two different shapes.`);
    }
    for (const end of ends) {
      if (end.shape === "bpmn.pool") {
        errors.push(
          `${who}: '${end.id}' is a pool; flows connect the shapes inside pools (a message flow goes from an element of one pool to an element of another).`,
        );
      } else if (e.flow !== "association" && ARTIFACTS.has(end.shape)) {
        errors.push(
          `${who}: '${end.id}' is ${end.shape}; use an association for data objects, data stores and annotations.`,
        );
      }
    }
  }
  return errors;
};

// ----------------------------------------------------------------- build --

const NOTE_SIZE = 16;
const NOTE_GAP = 8;

export type Placed = {
  entry: ShapeEntry;
  index: number;
  def: ShapeDef;
  inst: Instance;
  /** "bpmn.task 'review' (\"Review request\")" */
  name: string;
  /** name drawn beside the shape (events, gateways, data) */
  noteRect?: Rect;
  lanes: string[];
  isPool: boolean;
};

export type BuiltFlow = {
  id: string;
  entry: FlowEntry;
  index: number;
  from: Placed;
  to: Placed;
  name: string;
};

const noteSize = (text: string) => {
  const family = VARIANTS.hand.fontFamily;
  const font = getFontString({ fontSize: NOTE_SIZE, fontFamily: family as any });
  const lines = text.split("\n");
  return {
    w: Math.max(...lines.map((l) => measureLine(l, font))),
    h: lines.length * NOTE_SIZE * getLineHeight(family as any),
  };
};

/** Where the name of a shape goes: its box and the center of its text. */
const notePlace = (
  box: { x: number; y: number; w: number; h: number },
  text: string,
  side: "top" | "right" | "bottom" | "left",
) => {
  const { w, h } = noteSize(text);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const at: [number, number] =
    side === "top"
      ? [cx, box.y - NOTE_GAP - h / 2]
      : side === "bottom"
        ? [cx, box.y + box.h + NOTE_GAP + h / 2]
        : side === "right"
          ? [box.x + box.w + NOTE_GAP + w / 2, cy]
          : [box.x - NOTE_GAP - w / 2, cy];
  return { at, rect: { x: at[0] - w / 2, y: at[1] - h / 2, w, h } as Rect };
};

const placeEntry = (entry: ShapeEntry, index: number): { placed: Placed; pieces: Piece[] } => {
  const lanes = entry.lanes ?? [];
  const def =
    entry.shape === "bpmn.pool" && lanes.length
      ? shapeById("bpmn-pool-lanes")!
      : DEF_BY_NAME.get(entry.shape)!;
  const pool = entry.shape === "bpmn.pool";
  const inst = placeShape(def, {
    id: entry.id,
    x: entry.x,
    y: entry.y,
    variant: "hand",
    // events, gateways and data objects have no text inside: their label is a note
    label: def.label !== undefined ? entry.label : undefined,
    labels: lanes.length ? lanes : undefined,
    w: pool ? entry.width ?? 800 : entry.width,
    h: pool ? entry.height ?? 160 * Math.max(1, lanes.length) : entry.height,
  });
  const pieces: Piece[] = [inst];
  let noteRect: Rect | undefined;
  if (def.label === undefined && entry.label) {
    const side = entry.labelSide ?? (def.id.endsWith("-gateway") ? "top" : "bottom");
    const place = notePlace(inst.box, entry.label, side);
    noteRect = place.rect;
    const text = note(`${entry.id}.name`, entry.label, place.at, {
      variant: "hand",
      fontSize: NOTE_SIZE,
    });
    // the name moves with its shape
    const group = `${entry.id}.group`;
    for (const m of [...inst.meta.values(), ...text.meta.values()]) {
      m.group = group;
    }
    pieces.push(text);
  }
  const shown = entry.label ? ` ("${truncate(entry.label)}")` : "";
  return {
    placed: {
      entry,
      index,
      def,
      inst,
      name: `${entry.shape} '${entry.id}'${shown}`,
      noteRect,
      lanes,
      isPool: pool,
    },
    pieces,
  };
};

/**
 * Pieces for the whole list, in list order (later ones drawn on top), with the
 * primitives (already prepared) and the shapes and flows interleaved as the
 * caller wrote them.
 */
export const buildDiagram = (entries: Entry[], split: Split, prep: Prepared) => {
  const placed = new Map<string, Placed>();
  const pieceOf = new Map<number, Piece[]>();
  for (const { entry, index } of split.shapes) {
    const r = placeEntry(entry, index);
    placed.set(entry.id, r.placed);
    pieceOf.set(index, r.pieces);
  }

  const used = new Set<string>([
    ...prep.byId.keys(),
    ...placed.keys(),
    ...split.flows.flatMap((f) => (f.entry.id ? [f.entry.id] : [])),
  ]);
  const flows: BuiltFlow[] = [];
  for (const { entry, index } of split.flows) {
    let id = entry.id;
    if (!id) {
      let n = index + 1;
      while (used.has(`flow-${n}`)) {
        n++;
      }
      id = `flow-${n}`;
      used.add(id);
    }
    const from = placed.get(entry.from)!;
    const to = placed.get(entry.to)!;
    flows.push({ id, entry, index, from, to, name: describeFlow(entry, index) });
    pieceOf.set(index, [
      link(
        entry.flow as LinkKind,
        { of: from.inst },
        { of: to.inst },
        { id, label: entry.label, variant: "hand" },
      ),
    ]);
  }

  let k = 0;
  const pieces: Piece[] = [];
  entries.forEach((entry, index) => {
    if (isShape(entry) || isFlow(entry)) {
      pieces.push(...pieceOf.get(index)!);
    } else {
      pieces.push({ skeleton: [prep.skeleton[k++]], meta: new Map() });
    }
  });
  return { pieces, placed, flows };
};

// ---------------------------------------------------------------- report --

type Box = {
  name: string;
  rect: Rect;
  /** shape entry id the box belongs to, if any */
  owner?: string;
  pool?: boolean;
  bpmn?: boolean;
  /** the name drawn beside a shape */
  note?: boolean;
};

const rectOfBox = (b: Placed["inst"]["box"]): Rect => ({ x: b.x, y: b.y, w: b.w, h: b.h });

/**
 * Layout report for diagrams with shapes: overlaps, labels that do not fit,
 * flows that cut through a shape, and the BPMN rules (message flows between
 * pools, sequence flows inside a pool, every element in a pool, nothing on a
 * lane boundary). Primitives get their own report in layoutReport.
 */
export const shapeReport = (args: {
  placed: Map<string, Placed>;
  flows: BuiltFlow[];
  converted: any[];
  /** ids of the primitive elements (their converted elements are skipped here) */
  primIds: Set<string>;
  primName: Namer;
}): Warning[] => {
  const { placed, flows, converted, primIds, primName } = args;
  const warnings: Warning[] = [];
  const all = [...placed.values()];
  const pools = all.filter((p) => p.isPool);
  const live = converted.filter((e) => !e.isDeleted);
  const isPrim = (e: any) => primIds.has(e.id) || primIds.has(e.containerId);

  // ---- labels inside fixed-size shapes: the converter grows a shape whose
  // label does not fit, which would silently break the layout
  for (const p of all) {
    if (p.inst.anchor === undefined) {
      continue;
    }
    const body = live.find((e) => e.id === p.inst.anchor);
    if (!body || p.isPool) {
      continue;
    }
    const { box } = p.inst;
    if (body.height > box.h + 1 || body.width > box.w + 1) {
      warnings.push({
        code: "label_too_tall",
        message: `Label of ${p.name} does not fit: the shape holds ${box.w}x${box.h}px and grew to ${Math.round(body.width)}x${Math.round(body.height)}px. Shorten the label (a few words).`,
      });
      box.w = body.width;
      box.h = body.height;
    }
  }

  // ---- overlaps
  const boxes: Box[] = [];
  for (const p of all) {
    boxes.push({
      name: p.name,
      rect: rectOfBox(p.inst.box),
      owner: p.entry.id,
      pool: p.isPool,
      bpmn: p.def.set === "bpmn",
    });
    if (p.noteRect) {
      boxes.push({ name: `the name of ${p.name}`, rect: p.noteRect, owner: p.entry.id, note: true });
    }
  }
  for (const e of live) {
    const top = !e.containerId && isPrim(e);
    if (top && ["rectangle", "ellipse", "diamond", "text"].includes(e.type)) {
      boxes.push({ name: primName(e.id), rect: rectOf(e) });
    }
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.owner && a.owner === b.owner) {
        continue;
      }
      // a BPMN element against a pool is judged below, with the pool rules
      if ((a.pool && b.bpmn && !b.pool) || (b.pool && a.bpmn && !a.pool)) {
        continue;
      }
      const hit = intersection(a.rect, b.rect);
      if (hit && hit.w * hit.h > 16 && !contains(a.rect, b.rect) && !contains(b.rect, a.rect)) {
        warnings.push({
          code: "overlap",
          message: `${a.name} overlaps ${b.name} by ${Math.round(hit.w)}x${Math.round(hit.h)}px. Move one so there is a gap of 20px or more.`,
        });
      }
    }
  }

  // ---- pools, lanes
  const bpmnNodes = all.filter(
    (p) => p.def.set === "bpmn" && !p.isPool && p.entry.shape !== "bpmn.text-annotation",
  );
  const poolOf = (p: Placed) => {
    const [cx, cy] = [p.inst.box.x + p.inst.box.w / 2, p.inst.box.y + p.inst.box.h / 2];
    return pools.find((q) => {
      const r = rectOfBox(q.inst.box);
      return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
    });
  };
  if (pools.length) {
    for (const p of bpmnNodes) {
      const r = rectOfBox(p.inst.box);
      const home = pools.find((q) => contains(rectOfBox(q.inst.box), r));
      if (!home) {
        const edge = pools.find((q) => intersection(rectOfBox(q.inst.box), r));
        warnings.push({
          code: "element_outside_pools",
          message: edge
            ? `${p.name} sticks out of ${edge.name}. Move it fully inside the pool.`
            : `${p.name} is not inside any pool. When a diagram has pools, every BPMN element belongs to one: move it inside ${pools.map((q) => q.name).join(" or ")}.`,
        });
        continue;
      }
      const pr = rectOfBox(home.inst.box);
      const left = pr.x + (home.lanes.length ? 2 : 1) * POOL_BAND;
      if (r.x < left - 1) {
        warnings.push({
          code: "element_outside_pools",
          message: `${p.name} sits on the name band of ${home.name}. Move it ${Math.ceil(left - r.x + 10)}px or more to the right.`,
        });
        continue;
      }
      if (home.lanes.length > 1) {
        const laneH = pr.h / home.lanes.length;
        const touched = home.lanes
          .map((name, i) => ({ name, top: pr.y + laneH * i, bottom: pr.y + laneH * (i + 1) }))
          .filter((l) => r.y < l.bottom - 1 && r.y + r.h > l.top + 1);
        if (touched.length > 1) {
          warnings.push({
            code: "lane_boundary",
            message: `${p.name} crosses the line between lanes ${touched.map((l) => `"${l.name}"`).join(" and ")} of ${home.name}. Move it fully inside one lane.`,
          });
        }
      }
    }
  }

  // ---- flows
  const hasPools = pools.length > 0;
  for (const f of flows) {
    const a = f.from;
    const b = f.to;
    if (a.def.set !== "bpmn" || b.def.set !== "bpmn") {
      continue;
    }
    const pa = poolOf(a);
    const pb = poolOf(b);
    if (f.entry.flow === "message") {
      if (!hasPools || (pa && pb && pa === pb)) {
        warnings.push({
          code: "message_flow_same_pool",
          message: hasPools
            ? `${f.name}: both ends are inside ${pa!.name}. Message flows go between two pools; inside one pool use {"flow":"sequence"}.`
            : `${f.name}: this diagram has no pools. Message flows go between elements of two pools; add pools, or use {"flow":"sequence"}.`,
        });
      }
    } else if (f.entry.flow === "sequence" && pa && pb && pa !== pb) {
      warnings.push({
        code: "sequence_flow_crosses_pools",
        message: `${f.name} goes from ${pa.name} to ${pb.name}. Sequence flows stay inside one pool; between pools use {"flow":"message"}.`,
      });
    }
  }

  // ---- flows through shapes
  const obstacles = boxes.filter((b) => b.owner && !b.pool);
  const prims = boxes.filter((b) => !b.owner);
  for (const f of flows) {
    const el = live.find((e) => e.id === f.id);
    if (!el || el.points?.length !== 2) {
      continue;
    }
    const p0: [number, number] = [el.x + el.points[0][0], el.y + el.points[0][1]];
    const p1: [number, number] = [el.x + el.points[1][0], el.y + el.points[1][1]];
    for (const o of [...obstacles, ...prims]) {
      // a flow ends on its own shapes, but runs through nobody's name
      if (!o.note && (o.owner === f.entry.from || o.owner === f.entry.to)) {
        continue;
      }
      const inner = { x: o.rect.x + 4, y: o.rect.y + 4, w: o.rect.w - 8, h: o.rect.h - 8 };
      if (inner.w > 0 && inner.h > 0 && segmentCrosses(p0, p1, inner)) {
        warnings.push({
          code: "arrow_crosses",
          message: o.note
            ? `${f.name} runs through ${o.name}. Put that name on another side of its shape with "labelSide" ("top", "right", "bottom" or "left").`
            : `${f.name} passes through ${o.name}. Move that shape aside or place the ends so the flow runs clear of it.`,
        });
      }
    }
  }
  return warnings;
};
