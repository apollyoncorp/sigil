import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SHAPE_NAMES, entrySchema } from "../src/diagram";
import { FORMAT_SHEET } from "../src/format";
import { MAX_DATA_LINK_LENGTH } from "../../excalidraw-app/data/dataLink";
import { createDiagram, formatOutcome } from "../src/tools";

const draw = async (elements: unknown[]) => {
  const out = await createDiagram({ elements: elements as any });
  return out;
};
const warningCodes = async (elements: unknown[]) => {
  const out = await draw(elements);
  expect(out.ok, JSON.stringify(out)).toBe(true);
  return out.ok ? out.warnings.map((w) => w.code) : [];
};
const errorsOf = async (elements: unknown[]) => {
  const out = await draw(elements);
  expect(out.ok).toBe(false);
  return out.ok ? [] : out.errors;
};

const pool = (id: string, y: number, extra = {}) => ({
  shape: "bpmn.pool",
  id,
  x: 0,
  y,
  width: 600,
  height: 160,
  label: id,
  ...extra,
});
const task = (id: string, x: number, y: number, label = "Do it") => ({
  shape: "bpmn.task",
  id,
  x,
  y,
  label,
});

// ---------------------------------------------------------------- schema --

describe("describe_format", () => {
  it("its BPMN example draws with no warnings", async () => {
    const blocks = [...FORMAT_SHEET.matchAll(/\{ "elements": \[.*?\n\], "path"[^\n]*\}/gs)];
    const bpmn = blocks.map((m) => m[0]).find((b) => b.includes("bpmn.pool"))!;
    const input = JSON.parse(bpmn);
    delete input.path;
    const out = await createDiagram(input);
    expect(out.ok && out.warnings).toEqual([]);
  });
});

describe("shape and flow schema", () => {
  it("accepts shapes, flows and plain elements in one list", () => {
    const ok = [
      { shape: "bpmn.task", id: "t1", x: 0, y: 0, label: "Review request" },
      { flow: "sequence", from: "t1", to: "g1", label: "yes" },
      { type: "rectangle", x: 0, y: 0 },
    ];
    for (const e of ok) {
      expect(entrySchema.safeParse(e).success, JSON.stringify(e)).toBe(true);
    }
  });

  it("is strict", () => {
    const bad = [
      { shape: "bpmn.nope", id: "a", x: 0, y: 0 },
      { shape: "bpmn.task", id: "a", x: 0, y: 0, color: "red" },
      { shape: "bpmn.task", id: "has space", x: 0, y: 0 },
      { shape: "bpmn.task", id: "a.b", x: 0, y: 0 },
      { shape: "bpmn.task", id: "a", x: 0 },
      { shape: "bpmn.sequence-flow", id: "a", x: 0, y: 0 },
      { flow: "dotted", from: "a", to: "b" },
      { flow: "sequence", from: "a" },
      { shape: "bpmn.task", type: "rectangle", id: "a", x: 0, y: 0 },
    ];
    for (const e of bad) {
      expect(entrySchema.safeParse(e).success, JSON.stringify(e)).toBe(false);
    }
  });

  it("names every library shape except connectors", () => {
    expect(SHAPE_NAMES).toHaveLength(25);
    expect(SHAPE_NAMES).toContain("bpmn.task");
    expect(SHAPE_NAMES).toContain("flow.process");
    expect(SHAPE_NAMES).toContain("bpmn.pool");
    expect(SHAPE_NAMES).not.toContain("bpmn.pool-lanes");
    expect(SHAPE_NAMES.some((n) => /flow$/.test(n) && n.startsWith("bpmn."))).toBe(false);
  });

  it("describe_format lists every shape name", () => {
    for (const name of SHAPE_NAMES) {
      expect(FORMAT_SHEET, name).toContain(name);
    }
  });
});

// ------------------------------------------------------------ validation --

describe("shape validation", () => {
  it("rejects bad references and misuse, all at once", async () => {
    const errors = await errorsOf([
      { type: "rectangle", id: "box", x: 0, y: 0 },
      task("t1", 0, 0),
      { shape: "bpmn.end-event", id: "t1", x: 300, y: 0 },
      { shape: "bpmn.task", id: "t2", x: 300, y: 0, lanes: ["a"], width: 100 },
      { shape: "bpmn.data-store", id: "ds", x: 600, y: 0 },
      pool("p", 300),
      { flow: "sequence", from: "t1", to: "nowhere" },
      { flow: "sequence", from: "t1", to: "box" },
      { flow: "sequence", from: "t1", to: "t1" },
      { flow: "sequence", from: "t1", to: "ds" },
      { flow: "message", from: "t1", to: "p" },
      { type: "arrow", start: { id: "t1" }, end: { id: "box" } },
    ]);
    const text = errors.join("\n");
    expect(text).toMatch(/duplicate id 't1'/);
    expect(text).toMatch(/'lanes' is only for bpmn.pool/);
    expect(text).toMatch(/'width' is only for bpmn.pool and bpmn.text-annotation/);
    expect(text).toMatch(/to 'nowhere' not found. Shape ids: /);
    expect(text).toMatch(/to 'box' is a rectangle; flows connect shape entries/);
    expect(text).toMatch(/from and to are the same id/);
    expect(text).toMatch(/'ds' is bpmn.data-store; use an association/);
    expect(text).toMatch(/'p' is a pool/);
    expect(text).toMatch(/start.id 't1' is a BPMN\/flowchart shape/);
  });

  it("numbers entries by their position in the whole list", async () => {
    const errors = await errorsOf([
      task("a", 0, 0),
      { type: "rectangle", x: 0 },
    ]);
    expect(errors.join("\n")).toMatch(/rectangle #2: 'y' is required/);
  });

  it("flags a plain element whose id clashes with a shape's parts", async () => {
    const errors = await errorsOf([
      task("a", 0, 0),
      { type: "rectangle", id: "a.0", x: 400, y: 0 },
    ]);
    expect(errors.join("\n")).toMatch(/clashes with the shape's own parts/);
  });
});

// ------------------------------------------------------------- the rules --

describe("BPMN layout warnings", () => {
  const base = (...rest: unknown[]) => [pool("A", 0), pool("B", 240), ...rest];

  it("a clean two-pool diagram has none", async () => {
    expect(
      await warningCodes(
        base(
          task("a1", 100, 40),
          task("b1", 100, 280),
          { flow: "message", from: "a1", to: "b1" },
        ),
      ),
    ).toEqual([]);
  });

  it("message flow inside one pool", async () => {
    const out = await draw(
      base(task("a1", 100, 40), task("a2", 360, 40), {
        flow: "message",
        from: "a1",
        to: "a2",
      }),
    );
    expect(out.ok && out.warnings.map((w) => w.code)).toEqual(["message_flow_same_pool"]);
    expect(out.ok && out.warnings[0].message).toMatch(/both ends are inside bpmn.pool 'A'/);
  });

  it("message flow in a diagram without pools", async () => {
    expect(
      await warningCodes([
        task("a1", 100, 40),
        task("a2", 360, 40),
        { flow: "message", from: "a1", to: "a2" },
      ]),
    ).toEqual(["message_flow_same_pool"]);
  });

  it("sequence flow across pools", async () => {
    const out = await draw(
      base(task("a1", 100, 40), task("b1", 100, 280), {
        flow: "sequence",
        from: "a1",
        to: "b1",
      }),
    );
    expect(out.ok && out.warnings.map((w) => w.code)).toEqual(["sequence_flow_crosses_pools"]);
    expect(out.ok && out.warnings[0].message).toMatch(/use \{"flow":"message"\}/);
  });

  it("element outside every pool, or sticking out of one", async () => {
    expect(await warningCodes(base(task("a1", 100, 40), task("lost", 100, 480)))).toEqual([
      "element_outside_pools",
    ]);
    const out = await draw(base(task("edge", 500, 40)));
    expect(out.ok && out.warnings.map((w) => w.code)).toEqual(["element_outside_pools"]);
    expect(out.ok && out.warnings[0].message).toMatch(/sticks out of bpmn.pool 'A'/);
  });

  it("annotations may sit outside the pools", async () => {
    expect(
      await warningCodes([
        pool("A", 0),
        task("a1", 100, 40),
        { shape: "bpmn.text-annotation", id: "n", x: 700, y: 40, label: "Note" },
      ]),
    ).toEqual([]);
  });

  it("element on the pool's name band", async () => {
    const out = await draw([pool("A", 0), task("a1", 10, 40)]);
    expect(out.ok && out.warnings.map((w) => w.code)).toEqual(["element_outside_pools"]);
    expect(out.ok && out.warnings[0].message).toMatch(/name band/);
  });

  it("element on a lane boundary", async () => {
    const lanes = pool("A", 0, { height: 320, lanes: ["Agent", "Specialist"] });
    const out = await draw([lanes, task("a1", 120, 120)]);
    expect(out.ok && out.warnings.map((w) => w.code)).toEqual(["lane_boundary"]);
    expect(out.ok && out.warnings[0].message).toMatch(/lanes "Agent" and "Specialist"/);
    expect(await warningCodes([lanes, task("a1", 120, 40), task("a2", 120, 200)])).toEqual([]);
  });

  it("element on the name bands of a pool with lanes", async () => {
    const lanes = pool("A", 0, { height: 320, lanes: ["Agent", "Specialist"] });
    const out = await draw([lanes, task("a1", 40, 40)]);
    expect(out.ok && out.warnings.map((w) => w.code)).toEqual(["element_outside_pools"]);
  });

  it("overlaps, also with plain elements", async () => {
    expect(await warningCodes([task("a", 0, 0), task("b", 100, 40)])).toEqual(["overlap"]);
    expect(
      await warningCodes([
        task("a", 0, 0),
        { type: "rectangle", id: "r", x: 100, y: 40, width: 200, height: 100 },
      ]),
    ).toEqual(["overlap"]);
    // a shape inside a plain frame-like rectangle is grouping, not an overlap
    expect(
      await warningCodes([
        { type: "rectangle", id: "r", x: -40, y: -40, width: 300, height: 200 },
        task("a", 0, 0),
      ]),
    ).toEqual([]);
  });

  it("a name that sits under an event counts as part of the layout", async () => {
    const codes = await warningCodes([
      { shape: "bpmn.start-event", id: "s", x: 0, y: 0, label: "A long event name here" },
      task("t", 0, 50),
    ]);
    expect(codes).toEqual(["overlap"]);
  });

  it("a flow through another shape", async () => {
    const out = await draw([
      task("a", 0, 0),
      task("mid", 300, 0),
      task("b", 600, 0),
      { flow: "sequence", from: "a", to: "b" },
    ]);
    expect(out.ok && out.warnings.map((w) => w.code)).toEqual(["arrow_crosses"]);
    expect(out.ok && out.warnings[0].message).toMatch(/passes through bpmn.task 'mid'/);
  });

  it("a flow through the name of an event, and labelSide to fix it", async () => {
    const ev = (extra = {}) => ({
      shape: "bpmn.message-start-event",
      id: "ev",
      x: 200,
      y: 40,
      label: "Request in",
      ...extra,
    });
    const msg = { flow: "message", from: "sub", to: "ev" };
    const sub = task("sub", 120, 280);
    const input = (e: object) => [pool("A", 0, { height: 200 }), pool("B", 240, { height: 200 }), e, sub, msg];
    const out = await draw(input(ev()));
    expect(out.ok && out.warnings.map((w) => w.code)).toEqual(["arrow_crosses"]);
    expect(out.ok && out.warnings[0].message).toMatch(/runs through the name of .*labelSide/);
    expect(await warningCodes(input(ev({ labelSide: "top" })))).toEqual([]);
  });

  it("labelSide places the name and is only for shapes without an inner label", async () => {
    const out = await draw([
      { shape: "bpmn.end-event", id: "e", x: 100, y: 100, label: "Done", labelSide: "right" },
    ]);
    expect(out.ok).toBe(true);
    if (out.ok) {
      const n: any = out.file.elements.find((e: any) => e.id === "e.name");
      expect(n.x).toBeGreaterThan(100 + 40);
      expect(n.y + n.height / 2).toBeCloseTo(120, 0);
    }
    const errors = await errorsOf([{ ...task("t", 0, 0), labelSide: "top" }]);
    expect(errors.join("\n")).toMatch(/'labelSide' is only for events, gateways and data/);
  });

  it("a label that does not fit a fixed-size shape", async () => {
    const out = await draw([
      task("a", 0, 0, "Check the customer's request against every open ticket in the queue"),
    ]);
    expect(out.ok && out.warnings.map((w) => w.code)).toEqual(["label_too_tall"]);
  });

  it("the warnings reach the reply", async () => {
    const out = await draw(
      base(task("a1", 100, 40), task("a2", 360, 40), {
        flow: "message",
        from: "a1",
        to: "a2",
      }),
    );
    const reply = formatOutcome(out);
    const summary = JSON.parse(reply.content[0].text);
    expect(summary.warnings[0]).toMatch(/^message_flow_same_pool: /);
    expect(summary.next).toMatch(/Fix the warnings/);
  });
});

// -------------------------------------------------------------- the file --

describe("drawing shapes", () => {
  it("draws in the order given, with plain elements mixed in", async () => {
    const out = await draw([
      { type: "text", id: "title", x: 0, y: -60, text: "Process" },
      pool("A", 0),
      task("t", 100, 40),
      { type: "rectangle", id: "box", x: 700, y: 40, label: { text: "Note" } },
    ]);
    expect(out.ok).toBe(true);
    if (!out.ok) {
      return;
    }
    const ids = out.file.elements.map((e: any) => e.id);
    expect(ids[0]).toBe("title");
    expect(ids.indexOf("A.0")).toBeLessThan(ids.indexOf("t.0"));
    expect(ids.indexOf("t.0")).toBeLessThan(ids.indexOf("box"));
    expect(out.file.elements.find((e: any) => e.id === "t.0.label")?.text).toBe("Do it");
  });

  it("attaches flows to the shapes they join, in the library's look", async () => {
    const out = await draw([
      task("a", 0, 0),
      task("b", 300, 0),
      { flow: "sequence", from: "a", to: "b", label: "ok", id: "f" },
    ]);
    expect(out.ok).toBe(true);
    if (!out.ok) {
      return;
    }
    const f: any = out.file.elements.find((e: any) => e.id === "f");
    expect(f.type).toBe("arrow");
    expect(f.startBinding.elementId).toBe("a.0");
    expect(f.endBinding.elementId).toBe("b.0");
    expect(f.endArrowhead).toBe("triangle");
    expect(f.roughness).toBe(1);
    const a: any = out.file.elements.find((e: any) => e.id === "a.0");
    expect(a.fontFamily ?? null).toBeNull();
    const label: any = out.file.elements.find((e: any) => e.id === "a.0.label");
    expect(label.fontFamily).toBe(5);
  });

  it("names an event under it and a gateway above it, and they move together", async () => {
    const out = await draw([
      { shape: "bpmn.end-event", id: "e", x: 0, y: 100, label: "Done" },
      { shape: "bpmn.exclusive-gateway", id: "g", x: 200, y: 100, label: "Valid?" },
    ]);
    expect(out.ok).toBe(true);
    if (!out.ok) {
      return;
    }
    const byId = (id: string): any => out.file.elements.find((e: any) => e.id === id);
    expect(byId("e.name").y).toBeGreaterThan(byId("e.0").y + byId("e.0").height);
    expect(byId("g.name").y + byId("g.name").height).toBeLessThan(byId("g.0").y);
    expect(byId("e.name").groupIds).toEqual(byId("e.0").groupIds);
    expect(byId("e.name").groupIds).toHaveLength(1);
  });

  it("a pool without lanes, a pool with lanes, default sizes", async () => {
    const out = await draw([
      { shape: "bpmn.pool", id: "p", x: 0, y: 0 },
      { shape: "bpmn.pool", id: "q", x: 0, y: 300, lanes: ["a", "b", "c"] },
    ]);
    expect(out.ok).toBe(true);
    if (!out.ok) {
      return;
    }
    const byId = (id: string): any => out.file.elements.find((e: any) => e.id === id);
    expect([byId("p.0").width, byId("p.0").height]).toEqual([800, 160]);
    expect([byId("q.0").width, byId("q.0").height]).toEqual([800, 480]);
  });

  it("is deterministic", async () => {
    const input = JSON.parse(skillExamples().find((s) => s.includes('"bpmn.pool"'))!);
    delete input.path;
    const a = await createDiagram(input);
    const b = await createDiagram(input);
    expect(a.ok && JSON.stringify(a.file)).toBe(b.ok && JSON.stringify(b.file));
  });

  it("writes the file when asked", async () => {
    const out = await createDiagram({
      elements: [task("a", 0, 0)] as any,
      path: "/tmp/sigil-mcp-test/shape.excalidraw",
    });
    expect(out.ok && out.path).toBe("/tmp/sigil-mcp-test/shape.excalidraw");
    const file = JSON.parse(readFileSync("/tmp/sigil-mcp-test/shape.excalidraw", "utf8"));
    expect(file.type).toBe("excalidraw");
  });
});

// ------------------------------------------------------------ the sample --

const skillExamples = () => {
  const skill = readFileSync(
    join(__dirname, "../skill/sigil-diagrams/SKILL.md"),
    "utf8",
  );
  return [...skill.matchAll(/```json\n(\{"elements".*?)\n```/gs)].map((m) => m[1]);
};

describe("two-pool support process (the skill's BPMN example)", () => {
  const input = () => {
    const bpmn = skillExamples().find((s) => s.includes('"bpmn.pool"'))!;
    const parsed = JSON.parse(bpmn);
    delete parsed.path;
    return parsed;
  };

  it("passes the schema, draws with no warnings and keeps its rules", async () => {
    const parsed = input();
    for (const e of parsed.elements) {
      expect(entrySchema.safeParse(e).success, JSON.stringify(e)).toBe(true);
    }
    const out = await createDiagram(parsed);
    expect(out.ok && out.warnings).toEqual([]);
    const flows = parsed.elements.filter((e: any) => e.flow);
    expect(flows.filter((f: any) => f.flow === "message")).toHaveLength(2);
  });

  it("opens through a link well under the 200k limit", async () => {
    const out = await createDiagram(input());
    expect(out.ok && out.openUrl).toBeTruthy();
    expect(out.ok && out.openUrlLength).toBeLessThan(MAX_DATA_LINK_LENGTH / 10);
  });

  it("goes wrong in the ways the rules name", async () => {
    const parsed = input();
    const wrong = {
      elements: parsed.elements.map((e: any) =>
        e.flow === "message" && e.from === "submit" ? { ...e, to: "answer" } : e,
      ),
    };
    const out = await createDiagram(wrong);
    expect(out.ok && out.warnings.map((w) => w.code)).toContain("message_flow_same_pool");
  });
});
