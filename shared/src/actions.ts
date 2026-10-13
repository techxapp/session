import { z } from "zod";
import objects from "../objects.json";
import moreObjects from "../objects-more.json";
import { equationError } from "./math";

/**
 * Board actions are the typed "System 1" decisions: every voice/text command
 * becomes a short list of these, which the web client applies to the canvas.
 * The same schemas generate the LLM tool definitions and validate tool input.
 */

export const COLORS = ["black", "gray", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"] as const;
export const Color = z.enum(COLORS);
export type Color = z.infer<typeof Color>;

export const Side = z.enum(["right", "left", "above", "below"]);
export type Side = z.infer<typeof Side>;

export const Direction = z.enum(["left", "right", "up", "down"]);

const ElementId = z
  .string()
  .min(1)
  .max(40)
  .describe("Element id: an existing id from the scene, or an id you assigned earlier in this turn.");

const NewId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/)
  .describe("Short slug id for the new element (e.g. 'api', 'db'), so later calls in this turn can reference it.");

export const Placement = z
  .object({
    relative_to: ElementId.optional().describe("Place next to this element."),
    side: Side.optional().describe("Which side of relative_to. Default 'right'."),
    x: z.number().optional().describe("Absolute scene x (only when the user gives a position)."),
    y: z.number().optional().describe("Absolute scene y."),
    region: z
      .enum(["center", "top-left", "top", "top-right", "left", "right", "bottom-left", "bottom", "bottom-right"])
      .optional()
      .describe("Region of the visible board, e.g. 'top-right'."),
  })
  .describe("Where to put the element. Omit entirely to auto-place next to the last thing drawn.");
export type Placement = z.infer<typeof Placement>;

export const AddShape = z.object({
  id: NewId.optional(),
  kind: z.enum(["rectangle", "ellipse", "diamond", "sticky"]).describe("'sticky' is a yellow sticky note."),
  label: z.string().max(200).optional().describe("Text inside the shape."),
  color: Color.optional(),
  size: z.enum(["small", "medium", "large"]).optional(),
  placement: Placement.optional(),
});

/**
 * Clip-art the board can draw (images in web/public/objects, made by web/scripts/build-objects.mjs):
 * the hand-curated catalog (shared/objects.json, the OBJECT_MODE=enum list) plus the rest of the icon
 * library (shared/objects-more.json, generated, named after the icon), which OBJECT_MODE=text can also reach.
 */
export type ObjectName = keyof typeof objects;
export const OBJECT_NAMES = Object.keys(objects) as [ObjectName, ...ObjectName[]];
export const OBJECT_CATALOG: Record<ObjectName, { icon: string; aliases: string[] }> = objects;
export const MORE_OBJECT_NAMES: readonly string[] = moreObjects;
export const ALL_OBJECT_NAMES = [...OBJECT_NAMES, ...MORE_OBJECT_NAMES] as [string, ...string[]];

const ObjectFields = {
  id: NewId.optional(),
  size: z.enum(["small", "medium", "large"]).optional(),
  placement: Placement.optional(),
};

/** The add_object tool in OBJECT_MODE=enum: the model picks one curated name. */
export const AddObject = z.object({
  id: ObjectFields.id,
  object: z.enum(OBJECT_NAMES).describe("Which picture. Pick the closest one, e.g. 'kid' -> 'child', 'oak' -> 'tree'."),
  size: ObjectFields.size,
  placement: ObjectFields.placement,
});

/** What add_object validates as (ACTION_SCHEMAS): any curated or library name. */
export const AddObjectAny = z.object({ ...ObjectFields, object: z.enum(ALL_OBJECT_NAMES) });

/**
 * add_object with a free-text `object` (OBJECT_MODE=text): the catalog stays out of the prompt and the
 * server maps the word to a catalog or library name (server/src/objects.ts) before it is validated.
 */
export const AddObjectText = AddObject.extend({
  object: z
    .string()
    .min(1)
    .max(60)
    .describe(
      "The thing to draw as a plain common noun, e.g. 'dog', 'tree', 'laptop', 'old woman'. If no picture fits, a labelled box is drawn.",
    ),
});

export const AddText = z.object({
  id: NewId.optional(),
  text: z.string().min(1).max(1000),
  style: z.enum(["title", "heading", "body", "caption"]).optional().describe("Default 'body'."),
  color: Color.optional(),
  placement: Placement.optional(),
});

export const AddArrow = z.object({
  id: NewId.optional(),
  from: ElementId,
  to: ElementId,
  label: z.string().max(100).optional(),
  style: z.enum(["solid", "dashed", "dotted"]).optional(),
  color: Color.optional(),
  bidirectional: z.boolean().optional(),
});

const DiagramNode = z.object({
  id: NewId,
  label: z.string().min(1).max(200),
  kind: z
    .enum(["rectangle", "ellipse", "diamond", "sticky"])
    .optional()
    .describe("Default 'rectangle'. 'diamond' for a decision, 'ellipse' for start/end."),
  color: Color.optional(),
});

const DiagramEdge = z.object({
  from: ElementId.describe("A node id of this diagram, or an existing element."),
  to: ElementId,
  label: z.string().max(100).optional().describe("e.g. 'yes' / 'no' out of a decision."),
  style: z.enum(["solid", "dashed", "dotted"]).optional(),
});

export const GenerateDiagram = z
  .object({
    nodes: z.array(DiagramNode).min(2).max(30),
    edges: z.array(DiagramEdge).max(60).optional().describe("Arrows, in any order. The layout is computed from them."),
    direction: z
      .enum(["down", "right", "up", "left"])
      .optional()
      .describe("Which way the flow runs. Default 'down'; 'right' for pipelines and timelines."),
    size: z.enum(["small", "medium", "large"]).optional().describe("Box size. Default 'small'."),
    placement: Placement.optional().describe("Where to put the whole diagram."),
  })
  .refine((v) => new Set(v.nodes.map((n) => n.id)).size === v.nodes.length, { message: "Node ids must be unique." });

export const AddDimension = z
  .object({
    id: NewId.optional(),
    label: z.string().min(1).max(100).describe("The measurement as the user said it, e.g. '10 ft'."),
    target: ElementId.optional().describe("Measure this element: a vertical line along its height (or its width)."),
    axis: z.enum(["height", "width"]).optional().describe("With target. Default 'height'."),
    from: ElementId.optional().describe("With 'to': measure the gap between these two elements."),
    to: ElementId.optional(),
    color: Color.optional(),
  })
  .refine((v) => (v.target !== undefined) !== (v.from !== undefined && v.to !== undefined), {
    message: "Give either target, or both from and to.",
  });

const EquationText = z
  .string()
  .min(1)
  .max(200)
  .superRefine((v, ctx) => {
    const err = equationError(v);
    if (err) ctx.addIssue({ code: "custom", message: `"${v}": ${err}` });
  });

export const PlotGraph = z
  .object({
    id: NewId.optional(),
    equations: z
      .array(EquationText)
      .min(1)
      .max(6)
      .describe(
        "Functions of x, one curve each: 'y = x^2', 'y = 2x + 1', 'sin(x)'. Use ^ for powers, * or juxtaposition for products, and sin cos tan sqrt abs ln log exp (with brackets: sin(2x)).",
      ),
    add_to: ElementId.optional().describe("An existing graph: add these curves to it instead of drawing a new graph."),
    x_min: z.number().optional().describe("Left end of the x axis. Default -10 (with add_to: the graph's current range)."),
    x_max: z.number().optional(),
    y_min: z.number().optional().describe("Omit y_min/y_max to fit the curves."),
    y_max: z.number().optional(),
    title: z.string().max(100).optional(),
    colors: z.array(Color).max(6).optional().describe("One per equation, in order. Default blue, red, green, purple, orange, teal."),
    size: z.enum(["small", "medium", "large"]).optional().describe("Default 'medium'."),
    placement: Placement.optional(),
  })
  .refine((v) => v.x_min === undefined || v.x_max === undefined || v.x_min < v.x_max, { message: "x_min must be below x_max." })
  .refine((v) => v.y_min === undefined || v.y_max === undefined || v.y_min < v.y_max, { message: "y_min must be below y_max." });

export const CHART_KINDS = ["column", "bar", "line", "area", "pie", "donut"] as const;

export const AddChart = z
  .object({
    id: NewId.optional(),
    kind: z
      .enum(CHART_KINDS)
      .describe("'column' = vertical bars, 'bar' = horizontal bars, 'line', 'area', 'pie', 'donut' (pie with a hole)."),
    labels: z
      .array(z.string().min(1).max(40))
      .min(1)
      .max(24)
      .describe("Category names: the x axis of column/line/area, the rows of bar, the slices of pie/donut."),
    series: z
      .array(
        z.object({
          name: z.string().max(40).optional().describe("Shown in the legend when there are several series."),
          values: z.array(z.number()).min(1).max(24).describe("One number per label, in the same order."),
        }),
      )
      .min(1)
      .max(6)
      .describe("Data series. pie/donut take exactly one."),
    title: z.string().max(100).optional(),
    unit: z.string().max(12).optional().describe("Shown after values, e.g. '%', 'k', ' kg'. Use prefix '$' as unit '$'."),
    colors: z.array(Color).max(24).optional().describe("Per series (per slice for pie/donut), in order. Omit for the default palette."),
    size: z.enum(["small", "medium", "large"]).optional().describe("Default 'medium'."),
    placement: Placement.optional(),
  })
  .refine((v) => v.series.every((s) => s.values.length === v.labels.length), { message: "Each series needs one value per label." })
  .refine((v) => !["pie", "donut"].includes(v.kind) || v.series.length === 1, { message: "A pie/donut chart takes one series." })
  .refine((v) => !["pie", "donut"].includes(v.kind) || (v.series[0].values.every((x) => x >= 0) && v.series[0].values.some((x) => x > 0)), {
    message: "Pie/donut values must be zero or more, and not all zero.",
  });

export const MoveElement = z.object({
  target: ElementId,
  direction: Direction.optional().describe("Nudge in a direction."),
  distance: z.enum(["little", "some", "far"]).optional().describe("How far to nudge. Default 'some'."),
  placement: Placement.optional().describe("Or move to a placement (next to another element, region, or x/y)."),
});

export const AnimateElement = z
  .object({
    target: ElementId,
    toward: ElementId.optional().describe("Move until next to this element (stops beside it, on the side facing the mover)."),
    away_from: ElementId.optional().describe("Move straight away from this element."),
    direction: Direction.optional().describe("Or move in a direction."),
    distance: z.enum(["little", "some", "far"]).optional().describe("With direction or away_from. Default 'some'."),
    placement: Placement.optional().describe("Or move to a place (region, next to something, or x/y)."),
    speed: z.enum(["slow", "normal", "fast"]).optional().describe("walk/move/go = normal, run/drive/fly/rush = fast, stroll/creep = slow."),
    style: z.enum(["walk", "slide"]).optional().describe("'walk' bobs as it goes. Default 'walk' for pictures, 'slide' for shapes/text."),
  })
  .refine((v) => [v.toward, v.away_from, v.direction, v.placement].filter((x) => x !== undefined).length === 1, {
    message: "Give exactly one of toward, away_from, direction or placement.",
  });

export const UpdateElement = z.object({
  target: ElementId,
  label: z.string().max(1000).optional().describe("New text / label."),
  color: Color.optional(),
  size: z.enum(["small", "medium", "large"]).optional(),
  scale: z.number().min(0.2).max(5).optional().describe("Relative resize, e.g. 1.5 = 50% bigger."),
});

export const DeleteElements = z.object({
  targets: z.array(ElementId).min(1),
});

export const ScrollView = z
  .object({
    direction: Direction.optional().describe("Scroll the view this way ('scroll down' shows what is further down)."),
    distance: z.enum(["little", "some", "far"]).optional().describe("With direction: a quarter, half or a whole screen. Default 'some'."),
    to: ElementId.optional().describe("Or bring this element to the middle of the screen."),
    edge: z.enum(["top", "bottom", "left", "right"]).optional().describe("Or go to this edge of everything on the board."),
    fit: z.literal("all").optional().describe("Or show everything on the board at once."),
  })
  .refine((v) => [v.direction, v.to, v.edge, v.fit].filter((x) => x !== undefined).length === 1, {
    message: "Give exactly one of direction, to, edge or fit.",
  });

export const UndoLastCommand = z.object({});

export const ClearBoard = z.object({
  confirm: z.literal(true).describe("Only when the user explicitly asks to clear/erase everything."),
});

export const ACTION_SCHEMAS = {
  add_shape: AddShape,
  add_object: AddObjectAny,
  add_text: AddText,
  add_arrow: AddArrow,
  generate_diagram: GenerateDiagram,
  add_dimension: AddDimension,
  plot_graph: PlotGraph,
  add_chart: AddChart,
  move_element: MoveElement,
  animate_element: AnimateElement,
  update_element: UpdateElement,
  delete_elements: DeleteElements,
  scroll_view: ScrollView,
  undo_last_command: UndoLastCommand,
  clear_board: ClearBoard,
} as const;

export type ActionName = keyof typeof ACTION_SCHEMAS;
export const ACTION_NAMES = Object.keys(ACTION_SCHEMAS) as ActionName[];

export const ACTION_DESCRIPTIONS: Record<ActionName, string> = {
  add_shape: "Draw a shape (box, circle, diamond, sticky note), optionally with a label inside.",
  add_object:
    "Draw a picture of a real-world thing: a person, animal, plant, weather, food, building, vehicle or everyday object. Not for diagram boxes.",
  add_text: "Write free-standing text on the board (titles, notes, bullet lists).",
  add_arrow: "Connect two elements with an arrow, optionally labelled.",
  generate_diagram:
    "Draw a whole diagram at once (flowchart, architecture, pipeline, org chart, mind map, process steps): boxes plus the arrows between them, laid out automatically.",
  add_dimension:
    "Draw a measurement line with a label like '10 ft': along one element's height/width (target), or across the gap between two elements (from + to).",
  plot_graph:
    "Plot a graph of one or more equations y = f(x) (e.g. 'y = x^2', 'sin(x)') on labelled axes; hovering it shows the coordinates. Or add curves to an existing graph (add_to).",
  add_chart:
    "Draw a data chart from numbers: column, bar, line, area, pie or donut, with labels and one or more series; hovering it shows the values.",
  move_element: "Move an existing element: nudge it in a direction or place it next to something / in a region.",
  animate_element:
    "Animate an existing element moving (walk, run, drive, fly) towards or away from another element, in a direction, or to a place. Use instead of move_element when the user describes motion ('moves towards', 'walks to', 'runs away from').",
  update_element: "Change an existing element's text, color or size.",
  delete_elements: "Remove elements (connected arrows are removed too).",
  scroll_view:
    "Scroll the view (the camera), never the board: in a direction, to an element, to an edge of the content, or to show everything.",
  undo_last_command: "Undo everything the previous command did.",
  clear_board: "Erase the entire board.",
};

export type BoardAction = {
  [K in ActionName]: { name: K; input: z.infer<(typeof ACTION_SCHEMAS)[K]> };
}[ActionName];

/** Validate an untrusted tool call (name + input) into a BoardAction. */
export function parseAction(name: string, input: unknown): { ok: true; action: BoardAction } | { ok: false; error: string } {
  if (!(name in ACTION_SCHEMAS)) return { ok: false, error: `unknown action '${name}'` };
  const schema = ACTION_SCHEMAS[name as ActionName];
  const result = schema.safeParse(input);
  if (!result.success) return { ok: false, error: z.prettifyError(result.error) };
  return { ok: true, action: { name, input: result.data } as BoardAction };
}
