import { DOMParser, parseHTML } from "linkedom";
import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";

import { measureLine } from "./metrics";

// @excalidraw/mermaid-to-excalidraw 3.x lays diagrams out with Pele, a
// DOM-free Mermaid renderer. In Node it needs three browser APIs:
//   - DOMParser, to read the SVG that Pele returns          (linkedom)
//   - document.createElement("textarea"), to decode entities (linkedom)
//   - OffscreenCanvas#measureText, to size labels            (our font metrics)
// linkedom is ~150 KB of pure JS. No jsdom, no mermaid runtime.
//
// The shims exist only while a Mermaid call is running, so the rest of the
// bundle (which sniffs for `document`) keeps seeing a plain Node process.

class MetricsCanvas {
  getContext() {
    return {
      font: "",
      measureText(this: { font: string }, text: string) {
        return { width: measureLine(text, this.font) };
      },
    };
  }
}

const KEYS = ["DOMParser", "document", "OffscreenCanvas"] as const;

let active = 0;
let saved: Record<string, { had: boolean; value: unknown }> = {};

const install = () => {
  if (active++ > 0) {
    return;
  }
  const g = globalThis as any;
  saved = {};
  for (const k of KEYS) {
    saved[k] = { had: k in g, value: g[k] };
  }
  g.DOMParser = DOMParser;
  g.document = parseHTML("<!doctype html><html><body></body></html>").document;
  g.OffscreenCanvas = MetricsCanvas;
};

const uninstall = () => {
  if (--active > 0) {
    return;
  }
  const g = globalThis as any;
  for (const k of KEYS) {
    if (saved[k].had) {
      g[k] = saved[k].value;
    } else {
      delete g[k];
    }
  }
};

export const mermaidToSkeleton = async (definition: string) => {
  install();
  // Pele reports failures with console.error and then falls back to drawing
  // an image; catch that so a bad diagram is an error, not a silent picture.
  const originalError = console.error;
  const problems: string[] = [];
  console.error = (...args: unknown[]) => {
    const first = String(args[0] ?? "");
    if (first.startsWith("Error processing Pele diagram")) {
      problems.push(
        String((args[1] as Error | undefined)?.message ?? first.split("\n")[0]),
      );
      // captured into `problems`; never forwarded, the raw arguments may
      // quote the diagram text
      return;
    }
    originalError(...args);
  };
  try {
    const result = (await parseMermaidToExcalidraw(definition)) as {
      elements: any[];
      files?: Record<string, unknown>;
    };
    if (problems.length) {
      throw new Error(problems[0]);
    }
    return result;
  } finally {
    console.error = originalError;
    uninstall();
  }
};
