import { buildFile, type ExcalidrawFile } from "../convert";

import {
  compile,
  link,
  note,
  placeShape,
  type Instance,
  type Piece,
} from "./build";
import { ALL_SHAPES, shapeById } from "./defs";

import type { Variant } from "./types";

/**
 * A small support process drawn only with library shapes, in two pools.
 * Support has two lanes (Agent, Specialist): the hand-off between lanes is a
 * sequence flow. Message flows only cross between the pools (the request goes
 * in, the answer comes back out). It proves the shapes work together (arrows
 * attached, labels inside, no crossing lines) and serves as the screenshot.
 *
 * Support sits on top so that the request climbs through the empty left part
 * of the Specialist lane and the answer drops straight into the Customer pool.
 */
export const sampleProcess = (variant: Variant, ox = 40, oy = 40) => {
  const shape = (id: string, def: string, x: number, y: number, rest = {}) =>
    placeShape(shapeById(def)!, { id, x: x + ox, y: y + oy, variant, ...rest });
  const pt = (x: number, y: number) => [x + ox, y + oy] as [number, number];

  // Support pool, two lanes of 240
  const support = shape("support", "bpmn-pool-lanes", 0, 0, {
    w: 880,
    h: 480,
    label: "Support",
    labels: ["Agent", "Specialist"],
  });
  const request = shape("request", "bpmn-message-start-event", 210, 130);
  const review = shape("review", "bpmn-task", 290, 110, {
    label: "Review request",
  });
  const valid = shape("valid", "bpmn-exclusive-gateway", 502, 122);
  const reject = shape("reject", "bpmn-task", 610, 110, {
    label: "Reject request",
  });
  const rejected = shape("rejected", "bpmn-end-event", 810, 130);
  const resolve = shape("resolve", "bpmn-task", 450, 320, {
    label: "Resolve issue",
  });
  const resolved = shape("resolved", "bpmn-end-event", 670, 340);
  const tickets = shape("tickets", "bpmn-data-store", 346, 24);

  // Customer pool, one band
  const customer = shape("customer", "bpmn-pool", 0, 560, {
    w: 880,
    h: 160,
    label: "Customer",
  });
  const start = shape("start", "bpmn-start-event", 80, 620);
  const submit = shape("submit", "bpmn-task", 150, 600, {
    label: "Submit request",
  });
  const answer = shape("answer", "bpmn-intermediate-message-event", 510, 620);
  const done = shape("done", "bpmn-end-event", 680, 620);

  const flow = (
    kind: "sequence" | "message" | "association",
    id: string,
    from: Instance,
    to: Instance,
  ) => link(kind, { of: from }, { of: to }, { id, variant });
  const text = (
    id: string,
    label: string,
    x: number,
    y: number,
    align: "center" | "left" = "center",
  ) => note(id, label, pt(x, y), { variant, align });

  const pieces: Piece[] = [
    support,
    customer,
    request,
    review,
    valid,
    reject,
    rejected,
    resolve,
    resolved,
    tickets,
    start,
    submit,
    answer,
    done,
    // inside Customer
    flow("sequence", "f1", start, submit),
    flow("sequence", "f2", submit, answer),
    flow("sequence", "f3", answer, done),
    // inside Support, across both lanes
    flow("sequence", "f4", request, review),
    flow("sequence", "f5", review, valid),
    flow("sequence", "f6", valid, reject),
    flow("sequence", "f7", reject, rejected),
    flow("sequence", "f8", valid, resolve),
    flow("sequence", "f9", resolve, resolved),
    flow("association", "a1", review, tickets),
    // between the pools only
    flow("message", "m1", submit, request),
    flow("message", "m2", resolve, answer),
    // names
    text("n-start", "Need help", 100, 672),
    text("n-answer", "Answer received", 530, 672),
    text("n-done", "Done", 700, 672),
    text("n-request", "Request in", 230, 108),
    text("n-valid", "Valid?", 530, 100),
    text("n-yes", "yes", 546, 262, "left"),
    text("n-no", "no", 584, 132),
    text("n-rejected", "Rejected", 830, 188),
    text("n-resolved", "Resolved", 690, 398),
    text("n-tickets", "Tickets", 402, 52, "left"),
  ];
  return compile(pieces);
};

export const sampleProcessFile = (variant: Variant): ExcalidrawFile =>
  buildFile(sampleProcess(variant));

/** Every shape at its default size, in rows, to look at them all at once. */
export const gallery = (variant: Variant) => {
  const maxWidth = 1560;
  const gap = 50;
  const pieces: Piece[] = [];
  let x = 40;
  let y = 40;
  let rowH = 0;
  for (const def of ALL_SHAPES) {
    if (x + def.w > maxWidth && x > 40) {
      x = 40;
      y += rowH + gap + 24;
      rowH = 0;
    }
    pieces.push(
      placeShape(def, { id: def.id, x, y: y + 24, variant }),
      note(`${def.id}-name`, def.name.replace(/^\w+: /, ""), [x, y], {
        variant,
        align: "left",
        fontSize: 12,
      }),
    );
    x += Math.max(def.w, 170) + gap;
    rowH = Math.max(rowH, def.h);
  }
  return buildFile(compile(pieces));
};
