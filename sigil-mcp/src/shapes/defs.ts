import type { BodyPart, Drawing, LinePart, Part, Pt, ShapeDef } from "./types";

// Sizes sit on an 8px grid: events 40, gateways 56, tasks 160x80.
export const GRID = 8;

const THIN = 1;
const NORMAL = 2;
const THICK = 4;

// ------------------------------------------------------------- geometry --

/** Points on an ellipse arc; angles in radians, y grows downwards. */
const arc = (
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  from: number,
  to: number,
  steps: number,
): Pt[] =>
  Array.from({ length: steps + 1 }, (_, i) => {
    const a = from + ((to - from) * i) / steps;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)] as Pt;
  });

const body = (
  kind: BodyPart["kind"],
  x: number,
  y: number,
  w: number,
  h: number,
  extra: Partial<BodyPart> = {},
): BodyPart => ({ kind, x, y, w, h, ...extra });

const line = (
  points: readonly Pt[],
  extra: Partial<LinePart> = {},
): LinePart => ({ kind: "line", points, ...extra });

/** A circle of diameter d centered on (cx, cy). */
const circle = (cx: number, cy: number, d: number, extra: Partial<BodyPart> = {}) =>
  body("ellipse", cx - d / 2, cy - d / 2, d, d, extra);

const center = (w: number, h: number): Pt => [w / 2, h / 2];

const cross = (cx: number, cy: number, r: number, strokeWidth: number): Part[] => [
  line([[cx - r, cy], [cx + r, cy]], { strokeWidth }),
  line([[cx, cy - r], [cx, cy + r]], { strokeWidth }),
];

const times = (cx: number, cy: number, r: number, strokeWidth: number): Part[] => [
  line([[cx - r, cy - r], [cx + r, cy + r]], { strokeWidth }),
  line([[cx - r, cy + r], [cx + r, cy - r]], { strokeWidth }),
];

// ----------------------------------------------------------------- BPMN --

const EVENT = 40;
const GATEWAY = 56;

const event = (extra: Partial<BodyPart> = {}) =>
  body("ellipse", 0, 0, EVENT, EVENT, { strokeWidth: THIN, ...extra });

const gateway = () =>
  body("diamond", 0, 0, GATEWAY, GATEWAY, { strokeWidth: NORMAL });

const gatewayShape = (
  id: string,
  name: string,
  marker: () => Part[],
): ShapeDef => ({
  id,
  set: "bpmn",
  name,
  w: GATEWAY,
  h: GATEWAY,
  draw: () => ({ parts: [gateway(), ...marker()], anchor: 0 }),
});

const cylinder = (
  w: number,
  h: number,
  r: number,
  doubleTop: boolean,
): Part[] => {
  const outline: Pt[] = [
    [0, r],
    [0, h - r],
    ...arc(w / 2, h - r, w / 2, r, Math.PI, 0, 16).slice(1, -1),
    [w, h - r],
    [w, r],
  ];
  const parts: Part[] = [
    body("ellipse", 0, 0, w, 2 * r, { strokeWidth: NORMAL }),
    line(outline, { strokeWidth: NORMAL }),
  ];
  if (doubleTop) {
    parts.push(
      line(arc(w / 2, r + 8, w / 2, r, Math.PI, 0, 16), {
        strokeWidth: THIN,
      }),
    );
  }
  return parts;
};

// A pool has a header band on the left with its name; with lanes, each lane
// has a second band next to it with the lane name. Names read bottom to top
// and shrink to fit their band.
export const POOL_BAND = 32;

const pool = (
  w: number,
  h: number,
  name: string,
  lanes: string[] = [],
): Drawing => {
  const bands = lanes.length ? 2 : 1;
  const laneH = lanes.length ? h / lanes.length : h;
  const parts: Part[] = [
    body("rectangle", 0, 0, w, h, { strokeWidth: NORMAL }),
    line([[POOL_BAND, 0], [POOL_BAND, h]], { strokeWidth: NORMAL }),
    {
      kind: "text",
      at: [POOL_BAND / 2, h / 2],
      text: name,
      rotate: true,
      fit: h - 16,
    },
  ];
  if (bands === 2) {
    parts.push(
      line([[POOL_BAND * 2, 0], [POOL_BAND * 2, h]], { strokeWidth: NORMAL }),
    );
  }
  lanes.forEach((text, i) => {
    if (i > 0) {
      parts.push(
        line([[POOL_BAND, laneH * i], [w, laneH * i]], {
          strokeWidth: NORMAL,
        }),
      );
    }
    parts.push({
      kind: "text",
      at: [POOL_BAND * 1.5, laneH * i + laneH / 2],
      text,
      rotate: true,
      fit: laneH - 16,
    });
  });
  return { parts, anchor: 0 };
};

export const BPMN_SHAPES: ShapeDef[] = [
  {
    id: "bpmn-start-event",
    set: "bpmn",
    name: "BPMN: Start event",
    w: EVENT,
    h: EVENT,
    draw: () => ({ parts: [event()], anchor: 0 }),
  },
  {
    id: "bpmn-timer-start-event",
    set: "bpmn",
    name: "BPMN: Timer start event",
    w: EVENT,
    h: EVENT,
    draw: () => ({
      parts: [
        event(),
        circle(20, 20, 24, { strokeWidth: THIN }),
        line([[20, 20], [20, 11]], { strokeWidth: THIN }),
        line([[20, 20], [26, 20]], { strokeWidth: THIN }),
      ],
      anchor: 0,
    }),
  },
  {
    id: "bpmn-message-start-event",
    set: "bpmn",
    name: "BPMN: Message start event",
    w: EVENT,
    h: EVENT,
    draw: () => ({
      parts: [
        event(),
        body("rectangle", 10, 13, 20, 14, { strokeWidth: THIN }),
        line([[10, 13], [20, 21], [30, 13]], { strokeWidth: THIN }),
      ],
      anchor: 0,
    }),
  },
  {
    id: "bpmn-intermediate-event",
    set: "bpmn",
    name: "BPMN: Intermediate event",
    w: EVENT,
    h: EVENT,
    draw: () => ({
      parts: [event(), circle(20, 20, 32, { strokeWidth: THIN })],
      anchor: 0,
    }),
  },
  {
    id: "bpmn-intermediate-message-event",
    set: "bpmn",
    name: "BPMN: Intermediate message event",
    w: EVENT,
    h: EVENT,
    draw: () => ({
      parts: [
        event(),
        circle(20, 20, 32, { strokeWidth: THIN }),
        body("rectangle", 10, 13, 20, 14, { strokeWidth: THIN }),
        line([[10, 13], [20, 21], [30, 13]], { strokeWidth: THIN }),
      ],
      anchor: 0,
    }),
  },
  {
    id: "bpmn-end-event",
    set: "bpmn",
    name: "BPMN: End event",
    w: EVENT,
    h: EVENT,
    draw: () => ({ parts: [event({ strokeWidth: THICK })], anchor: 0 }),
  },
  {
    id: "bpmn-task",
    set: "bpmn",
    name: "BPMN: Task",
    w: 160,
    h: 80,
    label: "Task",
    draw: ({ w, h, label }) => ({
      parts: [
        body("rectangle", 0, 0, w, h, {
          round: true,
          strokeWidth: NORMAL,
          label: { text: label ?? "Task" },
        }),
      ],
      anchor: 0,
    }),
  },
  {
    id: "bpmn-sub-process",
    set: "bpmn",
    name: "BPMN: Sub-process",
    w: 160,
    h: 80,
    label: "Sub-process",
    draw: ({ w, h, label }) => ({
      parts: [
        body("rectangle", 0, 0, w, h, {
          round: true,
          strokeWidth: NORMAL,
          label: { text: label ?? "Sub-process" },
        }),
        body("rectangle", w / 2 - 8, h - 24, 16, 16, { strokeWidth: THIN }),
        ...cross(w / 2, h - 16, 5, THIN),
      ],
      anchor: 0,
    }),
  },
  gatewayShape("bpmn-exclusive-gateway", "BPMN: Exclusive gateway", () =>
    times(28, 28, 9, NORMAL),
  ),
  gatewayShape("bpmn-parallel-gateway", "BPMN: Parallel gateway", () =>
    cross(28, 28, 13, NORMAL),
  ),
  gatewayShape("bpmn-inclusive-gateway", "BPMN: Inclusive gateway", () => [
    circle(28, 28, 28, { strokeWidth: NORMAL }),
  ]),
  gatewayShape("bpmn-event-gateway", "BPMN: Event-based gateway", () => [
    circle(28, 28, 32, { strokeWidth: THIN }),
    circle(28, 28, 26, { strokeWidth: THIN }),
    line(arc(28, 28.5, 8, 8, -Math.PI / 2, (3 * Math.PI) / 2, 5).slice(0, 5), {
      closed: true,
      strokeWidth: THIN,
    }),
  ]),
  {
    id: "bpmn-sequence-flow",
    set: "bpmn",
    name: "BPMN: Sequence flow",
    w: 120,
    h: 0,
    draw: ({ w }) => ({
      parts: [
        {
          kind: "arrow",
          points: [[0, 0], [w, 0]],
          end: "triangle",
          strokeWidth: NORMAL,
        },
      ],
    }),
  },
  {
    id: "bpmn-message-flow",
    set: "bpmn",
    name: "BPMN: Message flow",
    w: 120,
    h: 0,
    draw: ({ w }) => ({
      parts: [
        {
          kind: "arrow",
          points: [[0, 0], [w, 0]],
          start: "circle_outline",
          end: "triangle_outline",
          strokeStyle: "dashed",
          strokeWidth: NORMAL,
        },
      ],
    }),
  },
  {
    id: "bpmn-association",
    set: "bpmn",
    name: "BPMN: Association",
    w: 120,
    h: 0,
    draw: ({ w }) => ({
      parts: [
        line([[0, 0], [w, 0]], { strokeStyle: "dotted", strokeWidth: NORMAL }),
      ],
    }),
  },
  {
    id: "bpmn-data-object",
    set: "bpmn",
    name: "BPMN: Data object",
    w: 40,
    h: 56,
    draw: ({ w, h }) => {
      const fold = 12;
      return {
        parts: [
          line(
            [[0, 0], [w - fold, 0], [w, fold], [w, h], [0, h]],
            { closed: true, strokeWidth: NORMAL },
          ),
          line([[w - fold, 0], [w - fold, fold], [w, fold]], {
            strokeWidth: THIN,
          }),
        ],
      };
    },
  },
  {
    id: "bpmn-data-store",
    set: "bpmn",
    name: "BPMN: Data store",
    w: 48,
    h: 56,
    draw: ({ w, h }) => ({ parts: cylinder(w, h, 8, true) }),
  },
  {
    id: "bpmn-pool",
    set: "bpmn",
    name: "BPMN: Pool",
    w: 480,
    h: 160,
    label: "Pool",
    resizable: true,
    draw: ({ w, h, label }) => pool(w, h, label ?? "Pool"),
  },
  {
    id: "bpmn-pool-lanes",
    set: "bpmn",
    name: "BPMN: Pool with 2 lanes",
    w: 480,
    h: 240,
    label: "Pool",
    resizable: true,
    draw: ({ w, h, label, labels }) =>
      pool(w, h, label ?? "Pool", labels ?? ["Lane 1", "Lane 2"]),
  },
  {
    id: "bpmn-text-annotation",
    set: "bpmn",
    name: "BPMN: Text annotation",
    w: 160,
    h: 48,
    label: "Annotation",
    resizable: true,
    draw: ({ w, h, label }) => ({
      parts: [
        line([[12, 0], [0, 0], [0, h], [12, h]], { strokeWidth: NORMAL }),
        {
          kind: "text",
          at: [22, h / 2],
          text: label ?? "Annotation",
          align: "left",
          width: w - 22,
        },
      ],
    }),
  },
];

// ------------------------------------------------------------ flowchart --

const flow = (
  id: string,
  name: string,
  w: number,
  h: number,
  label: string,
  draw: (a: { w: number; h: number; label: string }) => Drawing,
): ShapeDef => ({
  id,
  set: "flowchart",
  name,
  w,
  h,
  label,
  draw: (a) => draw({ w: a.w, h: a.h, label: a.label ?? label }),
});

/** An outline drawn as one closed line, with its label centered on top. */
const outlined = (
  points: readonly Pt[],
  w: number,
  h: number,
  label: string,
  textAt: Pt = center(w, h),
): Drawing => ({
  parts: [
    line(points, { closed: true, strokeWidth: NORMAL }),
    { kind: "text", at: textAt, text: label },
  ],
});

export const FLOWCHART_SHAPES: ShapeDef[] = [
  flow("flow-terminator", "Flowchart: Terminator", 160, 64, "Start", ({ w, h, label }) => {
    const r = h / 2;
    const points: Pt[] = [
      ...arc(w - r, r, r, r, -Math.PI / 2, Math.PI / 2, 16),
      ...arc(r, r, r, r, Math.PI / 2, (3 * Math.PI) / 2, 16),
    ];
    return outlined(points, w, h, label);
  }),
  flow("flow-process", "Flowchart: Process", 160, 80, "Process", ({ w, h, label }) => ({
    parts: [
      body("rectangle", 0, 0, w, h, {
        strokeWidth: NORMAL,
        label: { text: label },
      }),
    ],
    anchor: 0,
  })),
  flow("flow-decision", "Flowchart: Decision", 160, 96, "OK?", ({ w, h, label }) => ({
    parts: [
      body("diamond", 0, 0, w, h, {
        strokeWidth: NORMAL,
        label: { text: label },
      }),
    ],
    anchor: 0,
  })),
  flow("flow-input-output", "Flowchart: Input/output", 176, 80, "Data", ({ w, h, label }) => {
    const skew = 24;
    return outlined(
      [[skew, 0], [w, 0], [w - skew, h], [0, h]],
      w,
      h,
      label,
    );
  }),
  flow("flow-document", "Flowchart: Document", 160, 80, "Document", ({ w, h, label }) => {
    const amp = 8;
    const wave = Array.from({ length: 25 }, (_, i) => {
      const x = w - (w * i) / 24;
      return [x, h - amp + amp * Math.sin((2 * Math.PI * (w - x)) / w)] as Pt;
    });
    return outlined(
      [[0, 0], [w, 0], ...wave],
      w,
      h,
      label,
      [w / 2, (h - amp) / 2],
    );
  }),
  flow("flow-predefined-process", "Flowchart: Predefined process", 160, 80, "Predefined", ({ w, h, label }) => ({
    parts: [
      body("rectangle", 0, 0, w, h, {
        strokeWidth: NORMAL,
        label: { text: label },
      }),
      line([[16, 0], [16, h]], { strokeWidth: NORMAL }),
      line([[w - 16, 0], [w - 16, h]], { strokeWidth: NORMAL }),
    ],
    anchor: 0,
  })),
  flow("flow-database", "Flowchart: Database", 128, 96, "Database", ({ w, h, label }) => {
    const r = 12;
    return {
      parts: [
        ...cylinder(w, h, r, false),
        { kind: "text", at: [w / 2, h / 2 + r / 2], text: label },
      ],
    };
  }),
  flow("flow-manual-input", "Flowchart: Manual input", 160, 80, "Manual input", ({ w, h, label }) =>
    outlined([[0, 16], [w, 0], [w, h], [0, h]], w, h, label, [w / 2, h / 2 + 8]),
  ),
  flow("flow-connector", "Flowchart: Connector", 48, 48, "A", ({ w, h, label }) => ({
    parts: [
      body("ellipse", 0, 0, w, h, {
        strokeWidth: NORMAL,
        label: { text: label, fontSize: 16 },
      }),
    ],
    anchor: 0,
  })),
];

export const ALL_SHAPES: ShapeDef[] = [...BPMN_SHAPES, ...FLOWCHART_SHAPES];

export const shapeById = (id: string) => ALL_SHAPES.find((s) => s.id === id);
