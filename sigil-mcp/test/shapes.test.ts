import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getBoundTextMaxHeight, getBoundTextMaxWidth } from "@excalidraw/element";
import { describe, expect, it } from "vitest";

import {
  ALL_SHAPES,
  BPMN_SHAPES,
  FLOWCHART_SHAPES,
  GRID,
  LIBRARY_FILES,
  VARIANTS,
  boundsOf,
  buildLibrary,
  compile,
  libraryText,
  link,
  placeShape,
  shapeById,
  toLibraryItem,
} from "../src/shapes";
import { sampleProcess } from "../src/shapes/sample";

import type { Variant } from "../src/shapes";

const variants = Object.keys(VARIANTS) as Variant[];
const onGrid = (n: number) => Math.abs(n / GRID - Math.round(n / GRID)) < 1e-6;

describe("shape definitions", () => {
  it("has the BPMN and flowchart sets", () => {
    expect(BPMN_SHAPES).toHaveLength(20);
    expect(FLOWCHART_SHAPES).toHaveLength(9);
    const ids = ALL_SHAPES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const names = ALL_SHAPES.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const s of BPMN_SHAPES) {
      expect(s.name.startsWith("BPMN: ")).toBe(true);
    }
    for (const s of FLOWCHART_SHAPES) {
      expect(s.name.startsWith("Flowchart: ")).toBe(true);
    }
  });

  it("uses default sizes on the grid", () => {
    for (const s of ALL_SHAPES) {
      expect(onGrid(s.w), `${s.id} width ${s.w}`).toBe(true);
      expect(onGrid(s.h), `${s.id} height ${s.h}`).toBe(true);
    }
    expect(shapeById("bpmn-task")).toMatchObject({ w: 160, h: 80 });
    expect(shapeById("bpmn-start-event")).toMatchObject({ w: 40, h: 40 });
    expect(shapeById("bpmn-exclusive-gateway")).toMatchObject({ w: 56, h: 56 });
  });
});

describe.each(variants)("library items (%s)", (variant) => {
  const lib = buildLibrary(ALL_SHAPES, variant);

  it("is a version 2 library with one item per shape", () => {
    expect(lib.type).toBe("excalidrawlib");
    expect(lib.version).toBe(2);
    expect(lib.libraryItems.map((i) => i.id)).toEqual(ALL_SHAPES.map((s) => s.id));
    for (const item of lib.libraryItems) {
      expect(item.status).toBe("published");
      expect(item.elements.length).toBeGreaterThan(0);
    }
  });

  it.each(ALL_SHAPES.map((s) => [s.id, s] as const))(
    "%s is valid, native and on the grid",
    (_id, def) => {
      const { elements } = lib.libraryItems.find((i) => i.id === def.id)!;
      const ids = elements.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);

      const native = ["rectangle", "ellipse", "diamond", "line", "arrow", "text"];
      for (const el of elements) {
        expect(native, `${def.id}: ${el.type}`).toContain(el.type);
        expect(el.isDeleted).toBe(false);
        expect(Number.isFinite(el.x) && Number.isFinite(el.y)).toBe(true);
        expect(el.width).toBeGreaterThanOrEqual(0);
        expect(el.height).toBeGreaterThanOrEqual(0);
        if (el.type !== "text") {
          expect(el.roughness).toBe(VARIANTS[variant].roughness);
        } else {
          expect(el.fontFamily).toBe(VARIANTS[variant].fontFamily);
        }
      }

      // the item is as big as the shape says, and sits on the 8px grid
      const box = boundsOf(elements);
      expect(box.w).toBeCloseTo(def.w, 1);
      expect(box.h).toBeCloseTo(def.h, 1);
      expect(onGrid(Math.round(box.w * 100) / 100)).toBe(true);
      expect(onGrid(Math.round(box.h * 100) / 100)).toBe(true);
      expect(box.x).toBeCloseTo(0, 1);
      expect(box.y).toBeCloseTo(0, 1);

      // lines close exactly: a polygon ends where it starts
      for (const el of elements.filter((e) => e.type === "line")) {
        if (el.polygon) {
          const first = el.points[0];
          const last = el.points[el.points.length - 1];
          expect(last[0]).toBeCloseTo(first[0], 6);
          expect(last[1]).toBeCloseTo(first[1], 6);
        }
        // the stored size is the real extent of the points
        const xs = el.points.map((p: number[]) => p[0]);
        const ys = el.points.map((p: number[]) => p[1]);
        expect(el.width).toBeCloseTo(Math.max(...xs) - Math.min(...xs), 4);
        expect(el.height).toBeCloseTo(Math.max(...ys) - Math.min(...ys), 4);
      }

      // multi-part shapes move as one
      if (def.draw({ w: def.w, h: def.h }).parts.length > 1) {
        const groups = new Set(elements.map((e) => (e.groupIds ?? []).join()));
        expect(groups.size).toBe(1);
        expect([...groups][0]).not.toBe("");
      }
    },
  );

  it("binds every label to its container and fits it", () => {
    const labelled = lib.libraryItems.flatMap((i) => i.elements).filter((e) => e.type === "text" && e.containerId);
    // task, sub-process, process, decision, predefined process, connector
    expect(labelled.length).toBe(6);
    for (const item of lib.libraryItems) {
      const byId = new Map(item.elements.map((e) => [e.id, e]));
      for (const text of item.elements.filter((e) => e.type === "text" && e.containerId)) {
        const container = byId.get(text.containerId);
        expect(container, `${item.id}: container of ${text.id}`).toBeDefined();
        expect(container.boundElements).toEqual(
          expect.arrayContaining([{ type: "text", id: text.id }]),
        );
        // centered, and inside the room the container leaves for text
        expect(text.textAlign).toBe("center");
        expect(text.verticalAlign).toBe("middle");
        expect(text.width).toBeLessThanOrEqual(getBoundTextMaxWidth(container, text) + 1);
        expect(text.height).toBeLessThanOrEqual(getBoundTextMaxHeight(container, text) + 1);
        const cx = text.x + text.width / 2;
        const cy = text.y + text.height / 2;
        expect(cx).toBeCloseTo(container.x + container.width / 2, 0);
        expect(cy).toBeCloseTo(container.y + container.height / 2, 0);
      }
    }
  });

  it("keeps free labels inside the shape", () => {
    for (const item of lib.libraryItems) {
      const box = boundsOf(item.elements);
      for (const text of item.elements.filter((e) => e.type === "text" && !e.containerId)) {
        const cx = text.x + text.width / 2;
        const cy = text.y + text.height / 2;
        expect(cx, `${item.id} ${text.text}`).toBeGreaterThan(box.x);
        expect(cx).toBeLessThan(box.x + box.w);
        expect(cy).toBeGreaterThan(box.y);
        expect(cy).toBeLessThan(box.y + box.h);
        // never wider than the shape it sits in
        expect(text.width, `${item.id} ${text.text}`).toBeLessThanOrEqual(box.w);
      }
    }
  });

  it("draws the flows the BPMN way", () => {
    const get = (id: string) => lib.libraryItems.find((i) => i.id === id)!.elements[0];
    expect(get("bpmn-sequence-flow")).toMatchObject({
      type: "arrow",
      strokeStyle: "solid",
      endArrowhead: "triangle",
    });
    expect(get("bpmn-message-flow")).toMatchObject({
      type: "arrow",
      strokeStyle: "dashed",
      startArrowhead: "circle_outline",
      endArrowhead: "triangle_outline",
    });
    expect(get("bpmn-association")).toMatchObject({ type: "line", strokeStyle: "dotted" });
    // start thin, end thick
    expect(get("bpmn-start-event").strokeWidth).toBeLessThan(get("bpmn-end-event").strokeWidth);
  });
});

describe("variants", () => {
  it("differ only in line style and font", () => {
    const hand = buildLibrary(ALL_SHAPES, "hand");
    const clean = buildLibrary(ALL_SHAPES, "clean");
    expect(VARIANTS.hand).toMatchObject({ roughness: 1, fontFamily: 5 });
    expect(VARIANTS.clean).toMatchObject({ roughness: 0, fontFamily: 6 });
    hand.libraryItems.forEach((item, i) => {
      const other = clean.libraryItems[i];
      expect(other.id).toBe(item.id);
      expect(other.elements.map((e) => [e.type, e.x === undefined])).toEqual(
        item.elements.map((e) => [e.type, e.x === undefined]),
      );
      // the same boxes (labels may measure a little differently per font)
      const a = boundsOf(item.elements);
      const b = boundsOf(other.elements);
      expect(b.w).toBeCloseTo(a.w, 0);
      expect(b.h).toBeCloseTo(a.h, 0);
    });
  });
});

describe("determinism", () => {
  it("builds the same library every time", () => {
    for (const variant of variants) {
      const a = JSON.stringify(buildLibrary(ALL_SHAPES, variant));
      const b = JSON.stringify(buildLibrary(ALL_SHAPES, variant));
      expect(a).toBe(b);
    }
  });

  it("is not stale: public/libraries matches what the definitions produce", () => {
    // fails after a shape change until `node sigil-mcp/scripts/build-libraries.mjs` is rerun
    for (const { file, defs } of LIBRARY_FILES) {
      const committed = readFileSync(
        join(__dirname, "../../public/libraries", file),
        "utf8",
      );
      expect(committed, file).toBe(libraryText(buildLibrary(defs, "hand")));
    }
  });

  it("adding a library twice would not duplicate (ids and nonces are stable)", () => {
    const a = toLibraryItem(shapeById("bpmn-task")!, "hand");
    const b = toLibraryItem(shapeById("bpmn-task")!, "hand");
    expect(a.elements.map((e) => [e.id, e.versionNonce])).toEqual(
      b.elements.map((e) => [e.id, e.versionNonce]),
    );
  });
});

describe("placing shapes", () => {
  it("moves a shape and keeps its ports on its outline", () => {
    const task = placeShape(shapeById("bpmn-task")!, { id: "t", x: 100, y: 50, label: "Pay" });
    expect(task.box).toEqual({ x: 100, y: 50, w: 160, h: 80 });
    expect(task.ports.top).toEqual([180, 50]);
    expect(task.ports.right).toEqual([260, 90]);
    expect(task.anchor).toBe("t.0");
    const els = compile([task]);
    expect(els.find((e) => e.id === "t.0")).toMatchObject({ x: 100, y: 50 });
    expect(els.find((e) => e.type === "text").text).toBe("Pay");
  });

  it("resizes only the shapes that allow it", () => {
    const pool = placeShape(shapeById("bpmn-pool-lanes")!, {
      id: "p",
      w: 800,
      h: 300,
      label: "Shop",
      labels: ["A", "B", "C"],
    });
    expect(pool.box).toMatchObject({ w: 800, h: 300 });
    const els = compile([pool]);
    expect(els.filter((e) => e.type === "text").map((e) => e.text)).toEqual([
      "Shop",
      "A",
      "B",
      "C",
    ]);
    // pool band + lane band + 2 separators between 3 lanes
    expect(els.filter((e) => e.type === "line")).toHaveLength(4);
    const task = placeShape(shapeById("bpmn-task")!, { id: "t", w: 999, h: 999 });
    expect(task.box).toMatchObject({ w: 160, h: 80 });
  });

  it("attaches arrows between shapes that have an anchor", () => {
    const a = placeShape(shapeById("bpmn-task")!, { id: "a", x: 0, y: 0 });
    const b = placeShape(shapeById("bpmn-task")!, { id: "b", x: 300, y: 0 });
    const store = placeShape(shapeById("bpmn-data-store")!, { id: "s", x: 0, y: 200 });
    const els = compile([
      a,
      b,
      store,
      link("sequence", { of: a }, { of: b }, { id: "f" }),
      link("message", { of: a }, { of: store }, { id: "m" }),
    ]);
    const f = els.find((e) => e.id === "f");
    expect(f.startBinding.elementId).toBe("a.0");
    expect(f.endBinding.elementId).toBe("b.0");
    // a data store is an outline: the arrow ends on its top port instead
    const m = els.find((e) => e.id === "m");
    expect(m.endBinding).toBeNull();
    expect(m.x + m.points[1][0]).toBeCloseTo(store.ports.top[0], 1);
    expect(m.y + m.points[1][1]).toBeCloseTo(store.ports.top[1], 1);
  });
});

type Band = { x0: number; x1: number; y0: number; y1: number };

/** The rotated name texts, as the rectangle they cover on the canvas. */
const turnedBox = (el: any) => {
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;
  return { x0: cx - el.height / 2, x1: cx + el.height / 2, y0: cy - el.width / 2, y1: cy + el.width / 2 };
};
const inside = (b: Band, band: Band) =>
  b.x0 >= band.x0 - 0.5 && b.x1 <= band.x1 + 0.5 && b.y0 >= band.y0 - 0.5 && b.y1 <= band.y1 + 0.5;

describe.each(variants)("pools (%s)", (variant) => {
  const place = (id: string, opts: object = {}) => {
    const els = compile([placeShape(shapeById(id)!, { id: "p", x: 100, y: 60, variant, ...opts })]);
    return { els, byText: (t: string) => els.find((e) => e.type === "text" && e.text === t) };
  };

  it("pool: one header band with its name inside", () => {
    const { els, byText } = place("bpmn-pool");
    const lines = els.filter((e) => e.type === "line");
    expect(lines).toHaveLength(1);
    expect(lines[0].x).toBe(132);
    const name = byText("Pool");
    expect(name.angle).toBeCloseTo(Math.PI * 1.5, 5);
    expect(inside(turnedBox(name), { x0: 100, x1: 132, y0: 60, y1: 220 })).toBe(true);
  });

  it("pool with 2 lanes: header band, a band per lane, names inside", () => {
    const { els, byText } = place("bpmn-pool-lanes", { labels: ["Agent", "Specialist"] });
    const rect = els.find((e) => e.type === "rectangle");
    expect(rect).toMatchObject({ x: 100, y: 60, width: 480, height: 240 });
    const vertical = els.filter((e) => e.type === "line" && e.height > 0 && e.width === 0);
    const horizontal = els.filter((e) => e.type === "line" && e.width > 0 && e.height === 0);
    // the pool band edge and the lane band edge
    expect(vertical.map((l) => l.x).sort((a, b) => a - b)).toEqual([132, 164]);
    // one separator between the lanes, starting at the pool band edge
    expect(horizontal).toHaveLength(1);
    expect(horizontal[0]).toMatchObject({ x: 132, y: 180, width: 448 });
    const pool = inside(turnedBox(byText("Pool")), { x0: 100, x1: 132, y0: 60, y1: 300 });
    const agent = inside(turnedBox(byText("Agent")), { x0: 132, x1: 164, y0: 60, y1: 180 });
    const specialist = inside(turnedBox(byText("Specialist")), { x0: 132, x1: 164, y0: 180, y1: 300 });
    expect([pool, agent, specialist]).toEqual([true, true, true]);
  });

  it("shrinks a long name to fit its band", () => {
    const { els, byText } = place("bpmn-pool-lanes", {
      label: "A very long pool name for this band",
      labels: ["Customer success", "B"],
    });
    expect(els.find((e) => e.type === "text" && e.text === "Customer success")!.fontSize).toBeLessThan(20);
    const lane = byText("Customer success");
    expect(inside(turnedBox(lane), { x0: 132, x1: 164, y0: 60, y1: 180 })).toBe(true);
    const name = els.find((e) => e.type === "text" && e.text.startsWith("A very long"));
    expect(inside(turnedBox(name), { x0: 100, x1: 132, y0: 60, y1: 300 })).toBe(true);
  });
});

describe.each(variants)("sample process (%s)", (variant) => {
  const els = sampleProcess(variant);
  const byId = new Map(els.map((e) => [e.id, e]));
  const pools = ["support.0", "customer.0"].map((id) => byId.get(id));
  const poolOf = (id: string) =>
    pools.find((p) => {
      const e = byId.get(id);
      return e.x >= p.x && e.x + e.width <= p.x + p.width && e.y >= p.y && e.y + e.height <= p.y + p.height;
    });

  it("attaches every flow between tasks, events and gateways", () => {
    const arrows = els.filter((e) => e.type === "arrow");
    expect(arrows.length).toBe(11);
    for (const arrow of arrows) {
      expect(arrow.startBinding, arrow.id).not.toBeNull();
      expect(arrow.endBinding, arrow.id).not.toBeNull();
      const from = byId.get(arrow.startBinding.elementId);
      const to = byId.get(arrow.endBinding.elementId);
      expect(from.boundElements.some((b: any) => b.id === arrow.id)).toBe(true);
      expect(to.boundElements.some((b: any) => b.id === arrow.id)).toBe(true);
    }
  });

  it("uses message flows only between pools and sequence flows only inside one", () => {
    const arrows = els.filter((e) => e.type === "arrow");
    const messages = arrows.filter((a) => a.strokeStyle === "dashed");
    const sequences = arrows.filter((a) => a.strokeStyle === "solid");
    expect(messages).toHaveLength(2);
    expect(sequences).toHaveLength(9);
    for (const a of messages) {
      expect(poolOf(a.startBinding.elementId), a.id).not.toBe(poolOf(a.endBinding.elementId));
    }
    for (const a of sequences) {
      expect(poolOf(a.startBinding.elementId), a.id).toBe(poolOf(a.endBinding.elementId));
    }
    // a hand-off between lanes is a sequence flow
    const yes = arrows.find((a) => a.id === "f8");
    expect(yes.strokeStyle).toBe("solid");
    expect(byId.get(yes.startBinding.elementId).y).toBeLessThan(byId.get("support.0").y + 240);
    expect(byId.get(yes.endBinding.elementId).y).toBeGreaterThan(byId.get("support.0").y + 240);
  });

  it("keeps every shape inside its pool and every label inside its shape", () => {
    for (const el of els) {
      if (el.id.startsWith("support") || el.id.startsWith("customer") || el.type === "arrow") {
        continue;
      }
      const pool = poolOf(el.id);
      expect(pool, el.id).toBeDefined();
      // clear of the bands on the left
      expect(el.x, el.id).toBeGreaterThan(pool.x + (pool.id === "support.0" ? 64 : 32));
    }
    for (const text of els.filter((e) => e.type === "text" && e.containerId)) {
      const c = byId.get(text.containerId);
      expect(text.x).toBeGreaterThanOrEqual(c.x);
      expect(text.x + text.width).toBeLessThanOrEqual(c.x + c.width);
      expect(text.height).toBeLessThanOrEqual(getBoundTextMaxHeight(c, text) + 1);
    }
  });

  it("does not overlap shapes and no line passes through a shape", () => {
    const shapes = els.filter(
      (e) =>
        ["rectangle", "ellipse", "diamond"].includes(e.type) &&
        !e.id.startsWith("support.0") &&
        !e.id.startsWith("customer.0"),
    );
    for (let i = 0; i < shapes.length; i++) {
      for (let j = i + 1; j < shapes.length; j++) {
        const a = shapes[i];
        const b = shapes[j];
        if (a.id.split(".")[0] === b.id.split(".")[0]) {
          continue; // parts of one shape
        }
        const hit =
          Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0 &&
          Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0;
        expect(hit, `${a.id} / ${b.id}`).toBe(false);
      }
    }
    // arrows are straight: they must not cross a shape that is not an end
    const boxes = [...shapes, ...els.filter((e) => e.type === "text" && !e.containerId && e.id.startsWith("n-"))];
    for (const arrow of els.filter((e) => e.type === "arrow")) {
      const ends = new Set([arrow.startBinding.elementId, arrow.endBinding.elementId]);
      const [p0, p1] = arrow.points.map((p: number[]) => [arrow.x + p[0], arrow.y + p[1]]);
      for (const box of boxes) {
        if (ends.has(box.id)) {
          continue;
        }
        let tmin = 0;
        let tmax = 1;
        const d = [p1[0] - p0[0], p1[1] - p0[1]];
        const lo = [box.x + 1, box.y + 1];
        const hi = [box.x + box.width - 1, box.y + box.height - 1];
        let hit = true;
        for (let k = 0; k < 2 && hit; k++) {
          if (Math.abs(d[k]) < 1e-9) {
            hit = p0[k] >= lo[k] && p0[k] <= hi[k];
          } else {
            const t1 = (lo[k] - p0[k]) / d[k];
            const t2 = (hi[k] - p0[k]) / d[k];
            tmin = Math.max(tmin, Math.min(t1, t2));
            tmax = Math.min(tmax, Math.max(t1, t2));
            hit = tmin <= tmax;
          }
        }
        expect(hit, `${arrow.id} through ${box.id}`).toBe(false);
      }
    }
  });
});
