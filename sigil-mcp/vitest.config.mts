import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

const packages = resolve(__dirname, "../packages");

// Same @excalidraw/* aliases as the repo root (tsconfig paths), so tests run
// against the fork's source. Mode "production" makes import.meta.env.MODE
// match the bundle (the fork switches text measuring behavior in "test").
export default defineConfig({
  mode: "production",
  root: __dirname,
  resolve: {
    alias: [
      { find: /^@excalidraw\/common$/, replacement: resolve(packages, "common/src/index.ts") },
      { find: /^@excalidraw\/common\/(.*?)/, replacement: resolve(packages, "common/src/$1") },
      { find: /^@excalidraw\/element$/, replacement: resolve(packages, "element/src/index.ts") },
      { find: /^@excalidraw\/element\/(.*?)/, replacement: resolve(packages, "element/src/$1") },
      { find: /^@excalidraw\/math$/, replacement: resolve(packages, "math/src/index.ts") },
      { find: /^@excalidraw\/math\/(.*?)/, replacement: resolve(packages, "math/src/$1") },
      { find: /^@excalidraw\/utils$/, replacement: resolve(packages, "utils/src/index.ts") },
      { find: /^@excalidraw\/utils\/(.*?)/, replacement: resolve(packages, "utils/src/$1") },
      { find: /^@excalidraw\/fractional-indexing$/, replacement: resolve(packages, "fractional-indexing/src/index.ts") },
      { find: /^@excalidraw\/fractional-indexing\/(.*?)/, replacement: resolve(packages, "fractional-indexing/src/$1") },
      { find: /^@excalidraw\/laser-pointer$/, replacement: resolve(packages, "laser-pointer/src/index.ts") },
      { find: /^@excalidraw\/laser-pointer\/(.*?)/, replacement: resolve(packages, "laser-pointer/src/$1") },
      { find: /^@excalidraw\/excalidraw$/, replacement: resolve(packages, "excalidraw/index.tsx") },
      { find: /^@excalidraw\/excalidraw\/(.*?)/, replacement: resolve(packages, "excalidraw/$1") },
    ],
  },
  test: {
    environment: "node",
    globals: false,
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    testTimeout: 30000,
  },
});
