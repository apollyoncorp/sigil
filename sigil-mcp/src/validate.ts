import type { Skeleton } from "./schema";

// Semantic validation of the element list. Returns every problem found (not
// just the first) as an actionable sentence the model can act on. Elements
// are referred to as "<type> #<1-based position>" (plus the id when set).

const SHAPES = new Set(["rectangle", "ellipse", "diamond"]);
const BINDABLE = new Set(["rectangle", "ellipse", "diamond", "text"]);

const ONLY_FOR: Record<string, string[]> = {
  label: ["rectangle", "ellipse", "diamond", "arrow"],
  text: ["text"],
  textAlign: ["text"],
  fontSize: ["text"],
  fontFamily: ["text"],
  start: ["arrow"],
  end: ["arrow"],
  startArrowhead: ["arrow", "line"],
  endArrowhead: ["arrow", "line"],
  children: ["frame"],
  name: ["frame"],
  rounded: ["rectangle", "diamond"],
  backgroundColor: ["rectangle", "ellipse", "diamond", "text"],
};

const HINT: Record<string, string> = {
  fontSize: "for text inside a shape use label.fontSize",
  fontFamily: "for text inside a shape use label.fontFamily",
  label: 'for a free-standing caption use {"type":"text","text":"..."}',
  text: 'for text inside a shape use label.text',
};

const COLOR =
  /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|transparent|[a-z]+|(rgb|rgba|hsl|hsla)\([^)]*\))$/i;

export const describeElement = (el: Skeleton, index: number): string => {
  const name =
    el.label?.text ?? (el.type === "text" ? el.text : undefined) ?? el.name;
  const bits = [`${el.type} #${index + 1}`];
  const extra = [el.id ? `id '${el.id}'` : "", name ? `"${truncate(name)}"` : ""]
    .filter(Boolean)
    .join(", ");
  return extra ? `${bits[0]} (${extra})` : bits[0];
};

const article = (w: string) => (/^[aeiou]/.test(w) ? "an" : "a");

const truncate = (s: string, n = 28) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s.replace(/\n/g, " ");

export type ValidateOptions = {
  /**
   * Position of each element in the list the caller received, when `elements`
   * is only part of it (the rest being shapes and flows). Default: its own index.
   */
  positions?: number[];
  /** ids taken by shape and flow entries (id -> what it is): they share one id space */
  external?: Map<string, "shape" | "flow">;
};

export const validateElements = (
  elements: Skeleton[],
  options: ValidateOptions = {},
): string[] => {
  const errors: string[] = [];
  const byId = new Map<string, number>();
  const at = (i: number) => options.positions?.[i] ?? i;
  const external = options.external ?? new Map();

  elements.forEach((el, i) => {
    if (el.id) {
      const first = byId.get(el.id);
      if (first !== undefined) {
        errors.push(
          `${describeElement(el, at(i))}: duplicate id '${el.id}' (already used by #${at(first) + 1}). Ids must be unique.`,
        );
      } else if (external.has(el.id)) {
        errors.push(
          `${describeElement(el, at(i))}: duplicate id '${el.id}' (already used by a ${external.get(el.id)} entry). Ids must be unique.`,
        );
      } else {
        byId.set(el.id, i);
      }
    }
  });
  const known = () =>
    byId.size ? `Known ids: ${[...byId.keys()].join(", ")}.` : "No element has an id yet; add \"id\" to the shapes arrows connect.";
  const isShapeId = (id: string) => external.get(id) === "shape";

  elements.forEach((el, i) => {
    const who = describeElement(el, at(i));

    // fields that make no sense for this type
    for (const [field, types] of Object.entries(ONLY_FOR)) {
      if ((el as Record<string, unknown>)[field] !== undefined && !types.includes(el.type)) {
        const hint = HINT[field] ? ` (${HINT[field]})` : "";
        errors.push(
          `${who}: '${field}' is only for ${types.join("/")}${hint}.`,
        );
      }
    }

    for (const field of ["strokeColor", "backgroundColor"] as const) {
      const v = el[field];
      if (v !== undefined && !COLOR.test(v.trim())) {
        errors.push(
          `${who}: ${field} '${v}' is not a CSS color. Use "#rrggbb", "transparent" or a color name.`,
        );
      }
    }

    if (SHAPES.has(el.type)) {
      for (const f of ["x", "y"] as const) {
        if (el[f] === undefined) {
          errors.push(`${who}: '${f}' is required.`);
        }
      }
      for (const f of ["width", "height"] as const) {
        if (el[f] !== undefined && el[f]! <= 0) {
          errors.push(`${who}: '${f}' must be > 0 (omit it to auto-fit the label).`);
        }
      }
      if (el.width === undefined && el.height === undefined && !el.label) {
        // fine: defaults to 180x80
      }
    }

    if (el.type === "text") {
      if (!el.text) {
        errors.push(`${who}: 'text' is required (the string to draw).`);
      }
      for (const f of ["x", "y"] as const) {
        if (el[f] === undefined) {
          errors.push(`${who}: '${f}' is required.`);
        }
      }
      if (el.width !== undefined || el.height !== undefined) {
        errors.push(`${who}: text size is computed from the content; remove width/height (use fontSize to scale).`);
      }
    }

    if (el.type === "line") {
      for (const f of ["x", "y"] as const) {
        if (el[f] === undefined) {
          errors.push(`${who}: '${f}' is required.`);
        }
      }
      if (!el.width && !el.height) {
        errors.push(`${who}: give width and/or height (the line goes from x,y to x+width,y+height).`);
      }
    }

    if (el.type === "arrow") {
      const bothBound = !!(el.start && el.end);
      if (!bothBound) {
        for (const f of ["x", "y"] as const) {
          if (el[f] === undefined) {
            errors.push(
              `${who}: '${f}' is required unless both start and end ids are given.`,
            );
          }
        }
        if (!el.width && !el.height) {
          errors.push(
            `${who}: give width/height (arrow goes from x,y to x+width,y+height) or attach both ends with start/end ids.`,
          );
        }
      }
      for (const side of ["start", "end"] as const) {
        const ref = el[side];
        if (!ref) {
          continue;
        }
        const idx = byId.get(ref.id);
        if (idx === undefined && isShapeId(ref.id)) {
          errors.push(
            `${who}: ${side}.id '${ref.id}' is a BPMN/flowchart shape; connect shapes with {"flow":"sequence","from":"...","to":"..."} instead of an arrow.`,
          );
        } else if (idx === undefined) {
          errors.push(`${who}: ${side}.id '${ref.id}' not found. ${known()}`);
        } else if (!BINDABLE.has(elements[idx].type)) {
          errors.push(
            `${who}: ${side}.id '${ref.id}' is ${article(elements[idx].type)} ${elements[idx].type}; arrows attach to rectangle, ellipse, diamond or text.`,
          );
        }
      }
      if (el.start && el.end && el.start.id === el.end.id) {
        errors.push(`${who}: start and end point at the same id '${el.start.id}'; an arrow needs two different shapes.`);
      }
    }

    if (el.type === "frame") {
      if (!el.children || el.children.length === 0) {
        errors.push(`${who}: 'children' is required (ids of the elements to wrap).`);
      } else {
        for (const child of el.children) {
          const idx = byId.get(child);
          if (idx === undefined && isShapeId(child)) {
            errors.push(`${who}: children id '${child}' is a BPMN/flowchart shape; frames wrap rectangle, ellipse, diamond, text or arrow elements.`);
          } else if (idx === undefined) {
            errors.push(`${who}: children has id '${child}' which was not found. ${known()}`);
          } else if (elements[idx].type === "frame") {
            errors.push(`${who}: children id '${child}' is a frame; frames cannot be nested here.`);
          }
        }
      }
    }
  });

  return errors;
};
