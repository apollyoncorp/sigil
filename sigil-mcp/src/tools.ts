import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  buildDataLink,
  MAX_DATA_LINK_LENGTH,
} from "../../excalidraw-app/data/dataLink";

import {
  buildFile,
  convert,
  explicitWidths,
  layoutReport,
  namerFor,
  prepare,
  requestedBindings,
  type ExcalidrawFile,
  type Warning,
} from "./convert";
import { mermaidToSkeleton } from "./mermaid";
import { MAX_ELEMENTS, type Skeleton } from "./schema";
import { validateElements } from "./validate";

export const DEFAULT_SIGIL_URL = "https://sigil.apollyoncorp.com";

/** Base URL of the Sigil editor; self-hosters point SIGIL_URL at theirs. */
export const sigilBaseUrl = () => {
  const fromEnv = process.env.SIGIL_URL?.trim();
  return fromEnv && /^https?:\/\//i.test(fromEnv) ? fromEnv : DEFAULT_SIGIL_URL;
};

/** A link that carries the whole diagram: open it and Sigil shows it. */
export const makeOpenUrl = (
  file: ExcalidrawFile,
  maxLength = MAX_DATA_LINK_LENGTH,
) => {
  const url = buildDataLink(sigilBaseUrl(), JSON.stringify(file));
  return url.length <= maxLength
    ? { openUrl: url as string | undefined, openUrlLength: url.length }
    : { openUrl: undefined, openUrlLength: url.length };
};

export type ToolOutcome =
  | {
      ok: true;
      file: ExcalidrawFile;
      path?: string;
      elementCount: number;
      warnings: Warning[];
      openUrl?: string;
      /** length the link would have had (set even when it was omitted) */
      openUrlLength: number;
    }
  | { ok: false; errors: string[] };

const resolveOutPath = (path: string): { path: string } | { error: string } => {
  if (!path.toLowerCase().endsWith(".excalidraw")) {
    return {
      error: `path '${path}' must end in .excalidraw (Sigil opens that extension).`,
    };
  }
  return { path: resolve(path) };
};

const writeOut = async (path: string, file: ExcalidrawFile) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(file, null, 2) + "\n", "utf8");
};

/** Silences upstream console noise: stdout belongs to the MCP protocol. */
const quiet = <T>(fn: () => T): T => {
  const original = console.log;
  console.log = (...a: unknown[]) => console.error(...a);
  try {
    return fn();
  } finally {
    console.log = original;
  }
};

export const createDiagram = async (input: {
  elements: Skeleton[];
  path?: string;
}): Promise<ToolOutcome> => {
  const { elements } = input;
  if (elements.length === 0) {
    return { ok: false, errors: ["elements is empty; add at least one element."] };
  }
  if (elements.length > MAX_ELEMENTS) {
    return {
      ok: false,
      errors: [`too many elements (${elements.length}); the limit is ${MAX_ELEMENTS}. Split the diagram.`],
    };
  }
  const errors = validateElements(elements);
  let outPath: string | undefined;
  if (input.path !== undefined) {
    const r = resolveOutPath(input.path);
    if ("error" in r) {
      errors.push(r.error);
    } else {
      outPath = r.path;
    }
  }
  if (errors.length) {
    return { ok: false, errors };
  }

  const prep = prepare(elements);
  let converted: any[];
  try {
    converted = quiet(() => convert(prep.skeleton));
  } catch (e) {
    return {
      ok: false,
      errors: [`conversion failed: ${(e as Error).message}. Check ids, coordinates and the children of frames.`],
    };
  }
  const warnings = layoutReport(
    converted,
    namerFor(prep),
    requestedBindings(prep),
    explicitWidths(prep),
  );
  const file = buildFile(converted);
  if (outPath) {
    await writeOut(outPath, file);
  }
  return {
    ok: true,
    file,
    path: outPath,
    elementCount: converted.length,
    warnings,
    ...makeOpenUrl(file),
  };
};

const nameFromElements = (elements: any[]) => {
  const labels = new Map<string, string>();
  for (const e of elements) {
    if (e.type === "text" && e.containerId) {
      labels.set(e.containerId, e.originalText ?? e.text);
    }
  }
  const byId = new Map(elements.map((e) => [e.id, e]));
  return (id: string) => {
    const e = byId.get(id);
    if (!e) {
      return id;
    }
    const text = e.type === "text" ? e.text : labels.get(id);
    return text ? `${e.type} "${text.replace(/\n/g, " ").slice(0, 28)}"` : `${e.type} ${id}`;
  };
};

export const mermaidToDiagram = async (input: {
  mermaid: string;
  path?: string;
}): Promise<ToolOutcome> => {
  const errors: string[] = [];
  if (!input.mermaid.trim()) {
    errors.push("mermaid is empty.");
  }
  let outPath: string | undefined;
  if (input.path !== undefined) {
    const r = resolveOutPath(input.path);
    if ("error" in r) {
      errors.push(r.error);
    } else {
      outPath = r.path;
    }
  }
  if (errors.length) {
    return { ok: false, errors };
  }

  let parsed: { elements: any[]; files?: Record<string, unknown> };
  try {
    parsed = await mermaidToSkeleton(input.mermaid);
  } catch (e) {
    return {
      ok: false,
      errors: [
        `Mermaid could not be parsed: ${(e as Error).message}. Check the syntax (first line must name the diagram, e.g. "flowchart TD").`,
      ],
    };
  }
  let converted: any[];
  try {
    converted = quiet(() => convert(parsed.elements));
  } catch (e) {
    return { ok: false, errors: [`conversion failed: ${(e as Error).message}`] };
  }
  const warnings = layoutReport(converted, nameFromElements(converted));
  if (converted.length > 0 && converted.every((e) => e.type === "image")) {
    warnings.push({
      code: "image_fallback",
      message:
        "This Mermaid diagram type is not converted to editable shapes, so it was added as a single image. Use flowchart, sequenceDiagram, classDiagram, erDiagram or stateDiagram for editable output.",
    });
  }
  const file = buildFile(converted, parsed.files ?? {});
  if (outPath) {
    await writeOut(outPath, file);
  }
  return {
    ok: true,
    file,
    path: outPath,
    elementCount: converted.length,
    warnings,
    ...makeOpenUrl(file),
  };
};

export const formatOutcome = (o: ToolOutcome) => {
  if (!o.ok) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Not drawn. ${o.errors.length} problem${o.errors.length > 1 ? "s" : ""}:\n${o.errors.map((e) => `- ${e}`).join("\n")}\nFix them and call again.`,
        },
      ],
    };
  }
  const where = o.path
    ? "Open the written file in Sigil"
    : "Save the JSON below as name.excalidraw and open it in Sigil";
  const link = o.openUrl
    ? "or give the user open_url (a link that opens the diagram directly)."
    : `open_url was left out because the link would be ${o.openUrlLength} characters; open the file instead.`;
  const summary = {
    ok: true,
    ...(o.path ? { written: o.path } : {}),
    ...(o.openUrl ? { open_url: o.openUrl } : {}),
    elements: o.elementCount,
    warnings: o.warnings.map((w) => `${w.code}: ${w.message}`),
    next: o.warnings.length
      ? "Fix the warnings and call again (same path overwrites the file)."
      : `No layout warnings. ${where}, ${link}`,
  };
  const content: { type: "text"; text: string }[] = [
    { type: "text", text: JSON.stringify(summary, null, 2) },
  ];
  if (!o.path) {
    content.push({ type: "text", text: JSON.stringify(o.file) });
  }
  return { content };
};
