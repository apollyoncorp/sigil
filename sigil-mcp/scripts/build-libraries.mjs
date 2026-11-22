// Generates public/libraries/*.excalidrawlib from the shape definitions in
// src/shapes. Same bundling as scripts/build.mjs (repo-root esbuild binary and
// tsconfig so @excalidraw/* resolve to packages/*/src), then runs the result.
//   node scripts/build-libraries.mjs [--variant hand|clean] [--out <dir>]
// --out is relative to the repo root (default public/libraries).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const root = join(pkgRoot, "..");
const tmp = mkdtempSync(join(tmpdir(), "sigil-libs-"));
const bundle = join(tmp, "emit.mjs");

try {
  execFileSync(
    join(root, "node_modules/esbuild/bin/esbuild"),
    [
      join(pkgRoot, "src/shapes/emit.ts"),
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node20",
      `--tsconfig=${join(root, "tsconfig.json")}`,
      '--define:import.meta.env={"MODE":"production","DEV":false,"PROD":true}',
      '--define:process.env.NODE_ENV="production"',
      '--banner:js=globalThis.window ??= globalThis;\nimport {createRequire as __sigilCreateRequire} from "node:module";const require=__sigilCreateRequire(import.meta.url);',
      "--log-level=warning",
      `--outfile=${bundle}`,
    ],
    { stdio: "inherit", cwd: pkgRoot },
  );
  execFileSync("node", [bundle, ...process.argv.slice(2)], {
    stdio: "inherit",
    cwd: root,
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
