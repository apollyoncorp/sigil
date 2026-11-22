// Compares src/metrics against canvas measureText in headless Chromium,
// loading the very same woff2 files. Dev-only; needs playwright-core and a
// Chromium binary (CHROMIUM_PATH or the default below).
//
//   node scripts/compare-metrics.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const fonts = join(root, "packages/excalidraw/fonts");
const esbuildBin = join(root, "node_modules/esbuild/bin/esbuild");
const chromium =
  process.env.CHROMIUM_PATH ??
  "/Users/morette/Library/Caches/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-mac-arm64/chrome-headless-shell";

const work = mkdtempSync(join(tmpdir(), "sigil-metrics-"));
const bundled = join(work, "metrics.mjs");
execFileSync(esbuildBin, [
  join(here, "../src/metrics/index.ts"),
  "--bundle",
  "--format=esm",
  `--outfile=${bundled}`,
  "--log-level=error",
]);
const { measureLine } = await import(pathToFileURL(bundled).href);
const { chromium: pw } = await import(
  pathToFileURL(join(root, "node_modules/playwright-core/index.mjs")).href
);

const b64 = (p) => readFileSync(p).toString("base64");
const face = (family, file, range) =>
  `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${b64(
    join(fonts, file),
  )}) format("woff2");${range ? `unicode-range:${range};` : ""}}`;

const LATIN = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const css = [
  face("Excalifont", "Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2", "U+20-7e,U+a0-a3,U+a5-a6,U+a8-ab,U+ad-b1,U+b4,U+b6-b8,U+ba-ff,U+131,U+152-153,U+2bc,U+2c6,U+2da,U+2dc,U+304,U+308,U+2013-2014,U+2018-201a,U+201c-201e,U+2020,U+2022,U+2024-2026,U+2030,U+2039-203a,U+20ac,U+2122,U+2212"),
  face("Nunito", "Nunito/Nunito-Regular-XRXI3I6Li01BKofiOc5wtlZ2di8HDIkhdTQ3j6zbXWjgeg.woff2", LATIN),
  face("Lilita One", "Lilita/Lilita-Regular-i7dPIFZ9Zz-WBtRtedDbYEF8RXi4EwQ.woff2", LATIN),
  face("Cascadia", "Cascadia/CascadiaCode-Regular.woff2"),
].join("\n");

const FAMILIES = [
  ["Excalifont", "Excalifont, Xiaolai, sans-serif, Segoe UI Emoji"],
  ["Nunito", "Nunito, sans-serif, Segoe UI Emoji"],
  ["Lilita One", '"Lilita One", sans-serif, Segoe UI Emoji'],
  ["Cascadia", "Cascadia, monospace, Segoe UI Emoji"],
];
const SIZES = [16, 20, 28];
const STRINGS = [
  "Start",
  "Process request",
  "Is the user authenticated?",
  "Validate input and return errors",
  "Database",
  "API Gateway -> Auth Service",
  "WAVE To AVA Typography 1990",
  "The quick brown fox jumps over the lazy dog",
  "0123456789 (a+b)*c=[d]/e",
  "Order #42 shipped: yes/no?",
  "Fill me in, Willy! fi fl ffi",
  "Cache hit ratio 99.5%",
];

const browser = await pw.launch({ executablePath: chromium });
const page = await browser.newPage();
await page.setContent(`<style>${css}</style><body>x</body>`);
const rows = await page.evaluate(
  async ({ families, sizes, strings }) => {
    const out = [];
    const ctx = document.createElement("canvas").getContext("2d");
    for (const [name, stack] of families) {
      for (const size of sizes) {
        const font = `${size}px ${stack}`;
        await document.fonts.load(font, "A");
        for (const text of strings) {
          ctx.font = font;
          out.push({ name, size, text, font, browser: ctx.measureText(text).width });
        }
      }
    }
    const loaded = [...document.fonts].map((f) => `${f.family}:${f.status}`);
    return { out, loaded };
  },
  { families: FAMILIES, sizes: SIZES, strings: STRINGS },
);
await browser.close();

const perFont = {};
let worst = { err: 0 };
for (const r of rows.out) {
  const mine = measureLine(r.text, r.font);
  const err = ((mine - r.browser) / r.browser) * 100;
  (perFont[r.name] ??= []).push(Math.abs(err));
  if (Math.abs(err) > Math.abs(worst.err)) {
    worst = { err, ...r, mine };
  }
}
console.log("fonts loaded:", rows.loaded.join(", "));
let all = [];
for (const [name, errs] of Object.entries(perFont)) {
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
  console.log(
    `${name.padEnd(11)} n=${errs.length}  mean |err| ${mean.toFixed(3)}%  max |err| ${Math.max(...errs).toFixed(3)}%`,
  );
  all = all.concat(errs);
}
console.log(
  `ALL         n=${all.length}  mean |err| ${(all.reduce((a, b) => a + b, 0) / all.length).toFixed(3)}%  max |err| ${Math.max(...all).toFixed(3)}%`,
);
console.log(
  `worst: ${worst.name} ${worst.size}px "${worst.text}" browser=${worst.browser.toFixed(2)} mine=${worst.mine.toFixed(2)} (${worst.err.toFixed(2)}%)`,
);
writeFileSync(join(work, "rows.json"), JSON.stringify(rows.out));
