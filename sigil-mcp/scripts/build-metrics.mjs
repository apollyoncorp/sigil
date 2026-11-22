// Precomputes advance-width tables from the fork's woff2 files into
// src/metrics/widths.json, so the bundled server needs no font parser and
// no font files at runtime. Dev-only (fontkit is a devDependency).
//
//   node scripts/build-metrics.mjs
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";

const here = dirname(fileURLToPath(import.meta.url));
const fontsDir = join(here, "../../packages/excalidraw/fonts");
const outFile = join(here, "../src/metrics/widths.json");

// family id used by Excalidraw (FONT_FAMILY in packages/common) -> folder/files
const FONTS = {
  5: { name: "Excalifont", dir: "Excalifont" },
  6: { name: "Nunito", dir: "Nunito" },
  7: { name: "Lilita One", dir: "Lilita" },
  3: { name: "Cascadia", dir: "Cascadia" },
};

const KERN_MIN = 0x20;
const KERN_MAX = 0x7e;

const result = {};
for (const [id, { name, dir }] of Object.entries(FONTS)) {
  const files = readdirSync(join(fontsDir, dir))
    .filter((f) => f.endsWith(".woff2"))
    .sort();
  const widths = {};
  let unitsPerEm = 0;
  let basicLatinFont = null;
  for (const file of files) {
    const font = fontkit.create(readFileSync(join(fontsDir, dir, file)));
    unitsPerEm = unitsPerEm || font.unitsPerEm;
    if (font.unitsPerEm !== unitsPerEm) {
      throw new Error(`${file}: unitsPerEm differs inside ${name}`);
    }
    for (const cp of font.characterSet) {
      if (widths[cp] === undefined) {
        widths[cp] = font.glyphForCodePoint(cp).advanceWidth;
      }
    }
    if (font.characterSet.includes(0x41) && font.characterSet.includes(0x20)) {
      basicLatinFont = font;
    }
  }
  if (!basicLatinFont) {
    throw new Error(`${name}: no file covers Basic Latin`);
  }

  // kerning pairs for Basic Latin (what labels are written in), taken from
  // the font's own GPOS/kern via the shaper: pair advance minus the two
  // plain advances.
  const kern = {};
  for (let a = KERN_MIN; a <= KERN_MAX; a++) {
    for (let b = KERN_MIN; b <= KERN_MAX; b++) {
      const run = basicLatinFont.layout(
        String.fromCodePoint(a) + String.fromCodePoint(b),
        { kern: true, liga: false, clig: false },
      );
      const total = run.positions.reduce((s, p) => s + p.xAdvance, 0);
      const plain = widths[a] + widths[b];
      if (total !== plain) {
        kern[`${String.fromCodePoint(a)}${String.fromCodePoint(b)}`] =
          total - plain;
      }
    }
  }

  result[id] = {
    name,
    unitsPerEm,
    glyphs: Object.keys(widths).length,
    kernPairs: Object.keys(kern).length,
    widths,
    kern,
  };
  console.log(
    `${name}: ${files.length} files, ${Object.keys(widths).length} glyphs, ${
      Object.keys(kern).length
    } kern pairs, upm ${unitsPerEm}`,
  );
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(result));
console.log(`wrote ${outFile}`);
