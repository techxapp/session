import { z } from "zod";
import objects from "../objects.json";

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

/** Clip-art the board can draw (shared/objects.json; images in web/public/objects, made by web/scripts/build-objects.mjs). */
export type ObjectName = keyof typeof objects;
export const OBJECT_NAMES = Object.keys(objects) as [ObjectName, ...ObjectName[]];

export const AddObject = z.object({
  id: NewId.optional(),
  object: z.enum(OBJECT_NAMES).describe("Which picture. Pick the closest one, e.g. 'kid' -> 'child', 'oak' -> 'tree'."),
  size: z.enum(["small", "medium", "large"]).optional(),
  placement: Placement.optional(),
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

export const UndoLastCommand = z.object({});

export const ClearBoard = z.object({
  confirm: z.literal(true).describe("Only when the user explicitly asks to clear/erase everything."),
});

export const ACTION_SCHEMAS = {
  add_shape: AddShape,
  add_object: AddObject,
  add_text: AddText,
  add_arrow: AddArrow,
  add_dimension: AddDimension,
  move_element: MoveElement,
  animate_element: AnimateElement,
  update_element: UpdateElement,
  delete_elements: DeleteElements,
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
  add_dimension:
    "Draw a measurement line with a label like '10 ft': along one element's height/width (target), or across the gap between two elements (from + to).",
  move_element: "Move an existing element: nudge it in a direction or place it next to something / in a region.",
  animate_element:
    "Animate an existing element moving (walk, run, drive, fly) towards or away from another element, in a direction, or to a place. Use instead of move_element when the user describes motion ('moves towards', 'walks to', 'runs away from').",
  update_element: "Change an existing element's text, color or size.",
  delete_elements: "Remove elements (connected arrows are removed too).",
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
