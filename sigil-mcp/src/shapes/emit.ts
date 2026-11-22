// Writes the shape libraries as .excalidrawlib files.
//   node scripts/build-libraries.mjs [--variant hand|clean] [--out <dir>] [--sample] [--check]
// --check writes nothing: it exits 1 when the files in <dir> are not what the
// definitions produce (stale libraries).
// --sample also writes sample-process.excalidraw (a diagram made of the shapes)
// and gallery.excalidraw (every shape on a grid).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { buildLibrary, LIBRARY_FILES, libraryText } from "./build";
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
const check = process.argv.includes("--check");
if (!check) {
  mkdirSync(out, { recursive: true });
}

let stale = 0;
for (const { file, defs } of LIBRARY_FILES) {
  const lib = buildLibrary(defs, variant);
  const text = libraryText(lib);
  const path = join(out, file);
  if (check) {
    const same = existsSync(path) && readFileSync(path, "utf8") === text;
    console.log(`${path}: ${same ? "up to date" : "STALE"}`);
    stale += same ? 0 : 1;
  } else {
    writeFileSync(path, text, "utf8");
    console.log(`${path}: ${lib.libraryItems.length} items (${variant})`);
  }
}
if (check) {
  process.exit(stale ? 1 : 0);
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
