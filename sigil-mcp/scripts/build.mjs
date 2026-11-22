// Bundles the server and the fork's element code into one file.
//   node scripts/build.mjs
// Uses the repo-root esbuild binary (the one in node_modules/.bin is broken
// in this checkout) and the repo tsconfig so @excalidraw/* resolve to
// packages/*/src.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const root = join(pkgRoot, "..");
const out = join(pkgRoot, "dist/sigil-mcp.mjs");
mkdirSync(dirname(out), { recursive: true });

execFileSync(
  join(root, "node_modules/esbuild/bin/esbuild"),
  [
    join(pkgRoot, "src/index.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node20",
    "--minify",
    `--tsconfig=${join(root, "tsconfig.json")}`,
    '--define:import.meta.env={"MODE":"production","DEV":false,"PROD":true}',
    "--define:process.env.NODE_ENV=\"production\"",
    "--banner:js=#!/usr/bin/env node\nglobalThis.window ??= globalThis;\nimport {createRequire as __sigilCreateRequire} from \"node:module\";const require=__sigilCreateRequire(import.meta.url);",
    // remote mode only: loaded at runtime with createRequire (src/store.ts),
    // never bundled and never opened in stdio mode
    "--external:node:sqlite",
    "--legal-comments=none",
    "--log-level=warning",
    `--outfile=${out}`,
  ],
  { stdio: "inherit", cwd: pkgRoot },
);
chmodSync(out, 0o755);
const kb = (statSync(out).size / 1024).toFixed(0);
console.log(`built ${out} (${kb} KB)`);
// sanity: shebang once
const head = readFileSync(out, "utf8").slice(0, 2);
if (head !== "#!") {
  writeFileSync(out, "#!/usr/bin/env node\n" + readFileSync(out, "utf8"));
}
