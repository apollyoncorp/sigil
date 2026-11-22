import widthsJson from "./widths.json";

// Text metrics from the real advance widths of the fonts Sigil ships
// (Excalifont, Nunito, Lilita One, Cascadia), precomputed from the woff2
// files by scripts/build-metrics.mjs. Replaces the canvas measureText that
// the editor uses, so labels are sized as the browser will draw them.

type FontTable = {
  name: string;
  unitsPerEm: number;
  widths: Record<string, number>;
  kern: Record<string, number>;
};

const TABLES = widthsJson as unknown as Record<string, FontTable>;

const BY_NAME: Record<string, FontTable> = {};
for (const table of Object.values(TABLES)) {
  BY_NAME[table.name.toLowerCase()] = table;
}

const FALLBACK = TABLES["5"]; // Excalifont, the default

/** "20px Excalifont, Xiaolai, sans-serif" -> { size: 20, table } */
export const parseFontString = (font: string) => {
  const m = /^\s*(?:[a-z-]+\s+)*?([\d.]+)px\s+(.+)$/i.exec(font);
  const size = m ? parseFloat(m[1]) : 20;
  const first = m ? m[2].split(",")[0].trim().replace(/^["']|["']$/g, "") : "";
  return { size, table: BY_NAME[first.toLowerCase()] ?? FALLBACK };
};

const isWide = (cp: number) =>
  (cp >= 0x1100 && cp <= 0x11ff) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7af) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe6f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6);

const isZeroWidth = (cp: number) =>
  (cp >= 0x300 && cp <= 0x36f) ||
  (cp >= 0x200b && cp <= 0x200f) ||
  cp === 0xfe0f ||
  cp === 0x200d;

/** Width of one line of text in px (no kerning across line breaks). */
export const measureLine = (text: string, font: string): number => {
  const { size, table } = parseFontString(font);
  let units = 0;
  let prev = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const w = table.widths[cp];
    if (w !== undefined) {
      units += w;
      if (prev) {
        units += table.kern[prev + ch] ?? 0;
      }
    } else if (isZeroWidth(cp)) {
      // combining marks / joiners
    } else if (isWide(cp)) {
      units += table.unitsPerEm; // CJK falls back to a 1em-wide font
    } else if (cp >= 0x1f000) {
      units += table.unitsPerEm * 1.2; // emoji, approximate
    } else {
      units += table.widths[0x6e] ?? table.unitsPerEm * 0.5; // unknown: "n"
    }
    prev = ch;
  }
  return (units / table.unitsPerEm) * size;
};

export const textMetricsProvider = {
  getLineWidth: (text: string, fontString: string) =>
    measureLine(text, fontString),
};
