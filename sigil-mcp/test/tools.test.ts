import { mkdtemp, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { measureLine } from "../src/metrics";
import { elementSchema, type Skeleton } from "../src/schema";
import {
  createDiagram,
  formatOutcome,
  makeOpenUrl,
  mermaidToDiagram,
} from "../src/tools";
import { decodeSceneData } from "../../excalidraw-app/data/dataLink";
import { validateElements } from "../src/validate";

const el = (e: Skeleton): Skeleton => e;

const flow: Skeleton[] = [
  el({ type: "rectangle", id: "a", x: 0, y: 0, label: { text: "Start" } }),
  el({ type: "diamond", id: "b", x: 0, y: 200, label: { text: "OK?" } }),
  el({ type: "arrow", start: { id: "a" }, end: { id: "b" }, label: { text: "go" } }),
];

describe("metrics", () => {
  it("measures from real advance widths", () => {
    const w = measureLine("Hello", "20px Excalifont, Xiaolai, sans-serif");
    expect(w).toBeGreaterThan(40);
    expect(w).toBeLessThan(80);
    // monospace: every glyph has the same advance
    const m = (s: string) => measureLine(s, "20px Cascadia, monospace");
    expect(m("iiii")).toBeCloseTo(m("WWWW"), 5);
    // width scales with font size
    expect(measureLine("Hello", "40px Excalifont")).toBeCloseTo(w * 2, 5);
  });
});

describe("conversion", () => {
  it("creates shapes, bound labels and bound arrows", async () => {
    const out = await createDiagram({ elements: flow });
    expect(out.ok).toBe(true);
    if (!out.ok) {
      return;
    }
    const { elements } = out.file;
    // 2 shapes + 1 arrow + 3 bound labels
    expect(elements).toHaveLength(6);
    const a = elements.find((e) => e.id === "a");
    const b = elements.find((e) => e.id === "b");
    const arrow = elements.find((e) => e.type === "arrow");
    expect(a.width).toBeGreaterThanOrEqual(180);
    expect(a.height).toBeGreaterThanOrEqual(80);
    expect(b.height).toBeGreaterThanOrEqual(100);
    expect(arrow.startBinding.elementId).toBe("a");
    expect(arrow.endBinding.elementId).toBe("b");
    // ids given by the caller survive
    const label = elements.find((e) => e.type === "text" && e.containerId === "a");
    expect(label.text).toBe("Start");
    // label sits inside its box
    expect(label.x).toBeGreaterThanOrEqual(a.x);
    expect(label.x + label.width).toBeLessThanOrEqual(a.x + a.width);
    expect(label.y).toBeGreaterThanOrEqual(a.y);
    expect(label.y + label.height).toBeLessThanOrEqual(a.y + a.height);
  });

  it("writes a valid .excalidraw file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sigil-mcp-"));
    const path = join(dir, "nested", "d.excalidraw");
    const out = await createDiagram({ elements: flow, path });
    expect(out.ok).toBe(true);
    const file = JSON.parse(await readFile(path, "utf8"));
    expect(file).toMatchObject({
      type: "excalidraw",
      version: 2,
      source: "https://sigil.apollyoncorp.com",
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    });
    expect(file.elements.length).toBe(6);
  });

  it("returns the JSON when no path is given", async () => {
    const out = await createDiagram({ elements: flow });
    const reply = formatOutcome(out);
    expect(reply.isError).toBeUndefined();
    expect(reply.content).toHaveLength(2);
    expect(JSON.parse(reply.content[1].text).type).toBe("excalidraw");
  });

  it("auto-fits a long label by widening, then wrapping", async () => {
    const out = await createDiagram({
      elements: [
        el({ type: "rectangle", id: "r", x: 0, y: 0, label: { text: "Validate the request payload against the schema and reject unknown fields" } }),
      ],
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      const r = out.file.elements.find((e) => e.id === "r");
      expect(r.width).toBeLessThanOrEqual(320);
      expect(r.height).toBeGreaterThan(80);
      expect(out.warnings).toEqual([]);
    }
  });

  it("supports text, line, ellipse and frames", async () => {
    const out = await createDiagram({
      elements: [
        el({ type: "ellipse", id: "e", x: 0, y: 0, label: { text: "Cloud" } }),
        el({ type: "text", id: "t", x: 0, y: 150, text: "Note", fontFamily: "Nunito" }),
        el({ type: "line", x: 0, y: 220, width: 200, height: 0 }),
        el({ type: "frame", id: "f", children: ["e", "t"], name: "Group" }),
      ],
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      const types = out.file.elements.map((e) => e.type);
      expect(types).toContain("frame");
      const e = out.file.elements.find((x) => x.id === "e");
      expect(e.frameId).toBeTruthy();
    }
  });
});

describe("validation", () => {
  it("names the arrow and the missing id", async () => {
    const out = await createDiagram({
      elements: [
        el({ type: "rectangle", id: "a", x: 0, y: 0 }),
        el({ type: "rectangle", id: "b", x: 300, y: 0 }),
        el({ type: "arrow", start: { id: "a" }, end: { id: "b2" } }),
      ],
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.errors).toEqual([
        "arrow #3: end.id 'b2' not found. Known ids: a, b.",
      ]);
    }
  });

  it("reports every problem, not just the first", () => {
    const errors = validateElements([
      el({ type: "rectangle", id: "a", y: 0 }),
      el({ type: "rectangle", id: "a", x: 0, y: 0, start: { id: "a" } }),
      el({ type: "text", x: 0, y: 0 }),
      el({ type: "arrow", x: 0, y: 0 }),
      el({ type: "frame", children: ["zzz"] }),
      el({ type: "rectangle", id: "c", x: 0, y: 0, strokeColor: "no way" }),
    ]);
    expect(errors.join("\n")).toMatch(/rectangle #1 \(id 'a'\): 'x' is required/);
    expect(errors.join("\n")).toMatch(/duplicate id 'a' \(already used by #1\)/);
    expect(errors.join("\n")).toMatch(/'start' is only for arrow/);
    expect(errors.join("\n")).toMatch(/text #3: 'text' is required/);
    expect(errors.join("\n")).toMatch(/arrow #4: give width\/height/);
    expect(errors.join("\n")).toMatch(/frame #5: children has id 'zzz' which was not found/);
    expect(errors.join("\n")).toMatch(/strokeColor 'no way' is not a CSS color/);
  });

  it("rejects arrows attached to arrows or frames", () => {
    const errors = validateElements([
      el({ type: "arrow", id: "x", x: 0, y: 0, width: 10, height: 10 }),
      el({ type: "rectangle", id: "r", x: 0, y: 0 }),
      el({ type: "arrow", start: { id: "x" }, end: { id: "r" } }),
    ]);
    expect(errors).toEqual([
      "arrow #3: start.id 'x' is an arrow; arrows attach to rectangle, ellipse, diamond or text.",
    ]);
  });

  it("only writes .excalidraw files", async () => {
    const out = await createDiagram({ elements: flow, path: "/tmp/not-sigil.sh" });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.errors[0]).toMatch(/must end in \.excalidraw/);
    }
  });

  it("the zod schema rejects unknown fields", () => {
    const r = elementSchema.safeParse({ type: "rectangle", x: 0, y: 0, colour: "red" });
    expect(r.success).toBe(false);
  });

  it("error replies are marked isError", async () => {
    const reply = formatOutcome(await createDiagram({ elements: [] }));
    expect(reply.isError).toBe(true);
  });
});

describe("layout warnings", () => {
  it("flags partially overlapping shapes", async () => {
    const out = await createDiagram({
      elements: [
        el({ type: "rectangle", id: "a", x: 0, y: 0, width: 200, height: 100 }),
        el({ type: "rectangle", id: "b", x: 150, y: 50, width: 200, height: 100 }),
      ],
    });
    expect(out.ok && out.warnings.map((w) => w.code)).toEqual(["overlap"]);
    if (out.ok) {
      expect(out.warnings[0].message).toContain("50x50px");
    }
  });

  it("does not flag a shape fully inside another (grouping)", async () => {
    const out = await createDiagram({
      elements: [
        el({ type: "rectangle", id: "a", x: 0, y: 0, width: 400, height: 300 }),
        el({ type: "rectangle", id: "b", x: 50, y: 50, width: 200, height: 100 }),
      ],
    });
    expect(out.ok && out.warnings).toEqual([]);
  });

  it("flags a label wider than its shape", async () => {
    const out = await createDiagram({
      elements: [
        el({
          type: "rectangle",
          id: "a",
          x: 0,
          y: 0,
          width: 120,
          height: 80,
          label: { text: "A very long label for a tiny box" },
        }),
      ],
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      const codes = out.warnings.map((w) => w.code);
      expect(codes).toContain("label_too_wide");
      expect(out.warnings.find((w) => w.code === "label_too_wide")!.message).toMatch(/Set width to \d+ or more/);
    }
  });

  it("flags arrows with free ends", async () => {
    const out = await createDiagram({
      elements: [
        el({ type: "rectangle", id: "a", x: 0, y: 0 }),
        el({ type: "arrow", start: { id: "a" }, x: 90, y: 40, width: 200, height: 0 }),
      ],
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      const msgs = out.warnings.map((w) => w.message);
      expect(msgs.some((m) => /arrow #2.*: end is not attached/.test(m))).toBe(true);
      expect(msgs.some((m) => /start is not attached/.test(m))).toBe(false);
    }
  });

  it("flags an arrow that cuts through another shape", async () => {
    const out = await createDiagram({
      elements: [
        el({ type: "rectangle", id: "a", x: 0, y: 0, width: 160, height: 80 }),
        el({ type: "rectangle", id: "mid", x: 300, y: 0, width: 160, height: 80 }),
        el({ type: "rectangle", id: "b", x: 600, y: 0, width: 160, height: 80 }),
        el({ type: "arrow", start: { id: "a" }, end: { id: "b" } }),
      ],
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.warnings.map((w) => w.code)).toContain("arrow_crosses");
    }
  });

  it("a clean 5-node flowchart has no warnings", async () => {
    const out = await createDiagram({
      elements: [
        el({ type: "rectangle", id: "s", x: 300, y: 0, label: { text: "Start" } }),
        el({ type: "rectangle", id: "p", x: 300, y: 160, label: { text: "Load configuration" } }),
        el({ type: "diamond", id: "d", x: 300, y: 320, label: { text: "Config valid?" } }),
        el({ type: "rectangle", id: "y", x: 40, y: 540, label: { text: "Run the job" } }),
        el({ type: "rectangle", id: "n", x: 560, y: 540, label: { text: "Report error" } }),
        el({ type: "arrow", start: { id: "s" }, end: { id: "p" } }),
        el({ type: "arrow", start: { id: "p" }, end: { id: "d" } }),
        el({ type: "arrow", start: { id: "d" }, end: { id: "y" }, label: { text: "yes" } }),
        el({ type: "arrow", start: { id: "d" }, end: { id: "n" }, label: { text: "no" } }),
      ],
    });
    expect(out.ok && out.warnings).toEqual([]);
  });
});

describe("mermaid_to_diagram", () => {
  it("converts a flowchart in plain Node", async () => {
    const out = await mermaidToDiagram({
      mermaid: "flowchart TD\n  A[Start] --> B{Ok?}\n  B -->|yes| C[Done]\n  B -->|no| A",
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      const types = new Set(out.file.elements.map((e) => e.type));
      expect(types.has("rectangle")).toBe(true);
      expect(types.has("diamond")).toBe(true);
      expect(types.has("arrow")).toBe(true);
      expect(types.has("image")).toBe(false);
      const arrows = out.file.elements.filter((e) => e.type === "arrow");
      expect(arrows).toHaveLength(3);
      expect(arrows.every((a) => a.startBinding && a.endBinding)).toBe(true);
    }
  });

  it("does not leave DOM globals behind", async () => {
    await mermaidToDiagram({ mermaid: "flowchart TD\n  A --> B" });
    expect((globalThis as any).document).toBeUndefined();
    expect((globalThis as any).DOMParser).toBeUndefined();
  });

  it("turns bad syntax into an error, not a picture", async () => {
    const out = await mermaidToDiagram({ mermaid: "flowchart TD\n  A --> --> ((" });
    expect(out.ok).toBe(false);
  });
});

describe("open_url", () => {
  it("carries the whole diagram in the link", async () => {
    const out = await createDiagram({ elements: flow });
    expect(out.ok).toBe(true);
    if (!out.ok) {
      return;
    }
    expect(out.openUrl).toMatch(/^https:\/\/sigil\.apollyoncorp\.com\/#data=[A-Za-z0-9_-]+$/);
    const payload = out.openUrl!.split("#data=")[1];
    // what the editor decodes is the file
    expect(JSON.parse(decodeSceneData(payload))).toEqual(out.file);
    const reply = formatOutcome(out);
    expect(JSON.parse(reply.content[0].text).open_url).toBe(out.openUrl);
  });

  it("honours SIGIL_URL for self-hosters", async () => {
    process.env.SIGIL_URL = "https://draw.example.org/";
    try {
      const out = await createDiagram({ elements: flow });
      expect(out.ok && out.openUrl!.startsWith("https://draw.example.org/#data=")).toBe(true);
    } finally {
      delete process.env.SIGIL_URL;
    }
  });

  it("ignores a SIGIL_URL that is not http(s)", async () => {
    process.env.SIGIL_URL = "javascript:alert(1)";
    try {
      const out = await createDiagram({ elements: flow });
      expect(out.ok && out.openUrl!.startsWith("https://sigil.apollyoncorp.com/#data=")).toBe(true);
    } finally {
      delete process.env.SIGIL_URL;
    }
  });

  it("omits the link when it would be too long, and says so", async () => {
    const out = await createDiagram({ elements: flow });
    if (!out.ok) {
      throw new Error("expected ok");
    }
    const tooLong = makeOpenUrl(out.file, 100);
    expect(tooLong.openUrl).toBeUndefined();
    expect(tooLong.openUrlLength).toBeGreaterThan(100);
    const reply = formatOutcome({ ...out, ...tooLong });
    const summary = JSON.parse(reply.content[0].text);
    expect(summary.open_url).toBeUndefined();
    expect(summary.next).toMatch(/open_url was left out/);
  });

  it("mermaid_to_diagram returns it too", async () => {
    const out = await mermaidToDiagram({ mermaid: "flowchart TD\n  A --> B" });
    expect(out.ok && out.openUrl).toBeTruthy();
  });
});

describe("skill", () => {
  const skill = readFileSync(
    join(__dirname, "../skill/sigil-diagrams/SKILL.md"),
    "utf8",
  );

  it("has name and description frontmatter", () => {
    const front = /^---\nname: sigil-diagrams\ndescription: .+\n---\n/.exec(skill);
    expect(front).not.toBeNull();
  });

  it("its worked example draws with no warnings", async () => {
    const json = /```json\n(\{"elements".*?)\n```/s.exec(skill)![1];
    const input = JSON.parse(json);
    delete input.path;
    const out = await createDiagram(input);
    expect(out.ok && out.warnings).toEqual([]);
  });
});
