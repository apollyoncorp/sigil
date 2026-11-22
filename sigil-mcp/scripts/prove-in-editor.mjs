// Opens .excalidraw files in the real Sigil editor (a static build served
// locally) with Playwright, through the Open dialog's file input, takes a
// screenshot and checks that labels sit inside their boxes and arrows are
// attached. Dev-only.
//
//   node scripts/prove-in-editor.mjs <http://localhost:PORT> <chromium> <file.excalidraw> <out.png> [...pairs]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const { chromium } = await import(
  pathToFileURL(join(root, "node_modules/playwright-core/index.mjs")).href
);

const [base, exe, ...rest] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: exe });
let failed = false;

for (let i = 0; i < rest.length; i += 2) {
  const [file, png] = [rest[i], rest[i + 1]];
  const source = JSON.parse(readFileSync(file, "utf8"));
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // force browser-fs-access onto its plain <input type=file> path
  await page.addInitScript(() => {
    delete window.showOpenFilePicker;
  });
  await page.goto(base, { waitUntil: "load" });
  await page.waitForSelector(".excalidraw", { timeout: 30000 });

  // the Open command (Ctrl/Cmd+O) creates the app's file input and clicks it
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".excalidraw").first().click({ position: { x: 600, y: 450 } });
  await page.keyboard.press("ControlOrMeta+o");
  await (await chooser).setFiles(file);
  await page.waitForFunction(
    (n) => {
      try {
        const els = JSON.parse(localStorage.getItem("excalidraw") || "[]");
        return els.length >= n;
      } catch {
        return false;
      }
    },
    source.elements.length,
    { timeout: 20000 },
  ).catch(() => {});
  await page.waitForTimeout(1500);
  // fit everything in view
  await page.keyboard.press("Shift+1");
  await page.waitForTimeout(800);
  await page.screenshot({ path: png });

  // read back what the editor holds (it persists scene elements to localStorage)
  const els = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("excalidraw") || "[]"),
  );
  const byId = new Map(els.map((e) => [e.id, e]));
  const live = els.filter((e) => !e.isDeleted);
  const texts = live.filter((e) => e.type === "text" && e.containerId);
  let inside = 0;
  const bad = [];
  for (const t of texts) {
    const c = byId.get(t.containerId);
    if (c.type === "arrow") {
      inside++;
      continue;
    }
    const ok =
      t.x >= c.x - 1 &&
      t.y >= c.y - 1 &&
      t.x + t.width <= c.x + c.width + 1 &&
      t.y + t.height <= c.y + c.height + 1;
    ok ? inside++ : bad.push(t.text);
  }
  const arrows = live.filter((e) => e.type === "arrow");
  const attached = arrows.filter((a) => a.startBinding && a.endBinding).length;
  console.log(
    JSON.stringify({
      file,
      screenshot: png,
      elementsInFile: source.elements.length,
      elementsInEditor: live.length,
      labels: texts.length,
      labelsInsideContainers: inside,
      misplacedLabels: bad,
      arrows: arrows.length,
      arrowsAttachedBothEnds: attached,
      pageErrors: errors,
    }),
  );
  if (bad.length || attached !== arrows.length || live.length < source.elements.length || errors.length) {
    failed = true;
  }
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
