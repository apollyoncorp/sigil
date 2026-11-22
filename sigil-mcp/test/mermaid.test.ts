import { describe, expect, it, vi } from "vitest";

// Pele reports a failed render with console.error and its raw arguments (the
// error may quote the diagram). The real library only does that for some
// diagram types, so it is replaced by a stand-in that does the same.
vi.mock("@excalidraw/mermaid-to-excalidraw", () => ({
  parseMermaidToExcalidraw: async (definition: string) => {
    console.error("Error processing Pele diagram:", new Error(`bad: ${definition}`));
    console.error("something else");
    return { elements: [] };
  },
}));

import { mermaidToSkeleton } from "../src/mermaid";

describe("mermaidToSkeleton and console.error", () => {
  it("captures Pele's error without forwarding its raw output, and forwards the rest", async () => {
    const seen: string[] = [];
    const saved = console.error;
    console.error = (...args: unknown[]) => {
      seen.push(args.map(String).join(" "));
    };
    try {
      await expect(mermaidToSkeleton("SECRETLABEL")).rejects.toThrow("bad: SECRETLABEL");
    } finally {
      console.error = saved;
    }
    expect(seen).toEqual(["something else"]);
  });
});
