// Writes the shape libraries as .excalidrawlib files.
//   node scripts/build-libraries.mjs [--variant hand|clean] [--out <dir>] [--sample]
// --sample also writes sample-process.excalidraw (a diagram made of the shapes)
// and gallery.excalidraw (every shape on a grid).
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { buildLibrary } from "./build";
import { BPMN_SHAPES, FLOWCHART_SHAPES } from "./defs";
import { gallery, sampleProcessFile } from "./sample";

import type { Variant } from "./types";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const variant = arg("variant", "hand") as Variant;
if (variant !== "hand" && variant !== "clean") {
  throw new Error(`--variant must be "hand" or "clean", got "${variant}"`);
}
const out = resolve(arg("out", "public/libraries"));
mkdirSync(out, { recursive: true });

const sets = [
  { file: "sigil-bpmn.excalidrawlib", defs: BPMN_SHAPES },
  { file: "sigil-flowchart.excalidrawlib", defs: FLOWCHART_SHAPES },
];
for (const { file, defs } of sets) {
  const lib = buildLibrary(defs, variant);
  writeFileSync(join(out, file), JSON.stringify(lib) + "\n", "utf8");
  console.log(`${join(out, file)}: ${lib.libraryItems.length} items (${variant})`);
}

if (process.argv.includes("--sample")) {
  const file = join(out, "sample-process.excalidraw");
  writeFileSync(file, JSON.stringify(sampleProcessFile(variant)) + "\n", "utf8");
  console.log(file);
  const g = join(out, "gallery.excalidraw");
  writeFileSync(g, JSON.stringify(gallery(variant)) + "\n", "utf8");
  console.log(g);
}

// the converter leaves timers behind that would keep the process alive
process.exit(0);
