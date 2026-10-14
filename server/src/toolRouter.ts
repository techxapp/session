import type { ActionName, SceneSummary, ToolRouterMode } from "@board/shared";
import { mentionsObject } from "./objects";

/**
 * Tool router: a cloud request carries the base tools plus only the groups a command needs, so requests stay
 * small (free tiers with small per-request limits answer 413 to the full ~21k-character tool list).
 * - Extra groups (diagram, object, ...) are picked in plain code (keywords + the scene), erring towards including.
 * - The core groups (draw, edit, arrow) are all sent unless the local decision model (fastpath/, when running) is
 *   confident which ones the command needs (`ToolHint.core`); keywords never split them, but an extra group adds
 *   the core groups its guidance relies on (NEEDS).
 * Misses degrade gracefully: the prompt tells the model to approximate and say so. Each extra group also brings
 * its own system-prompt bullets (prompt.ts#promptFor), and chart `data` lines are only sent with the chart group.
 */
export type CoreGroup = "draw" | "edit" | "arrow";
export type ExtraGroup = "diagram" | "object" | "dimension" | "motion" | "graph" | "chart" | "scroll";
export type ToolGroup = CoreGroup | ExtraGroup;
export const CORE_GROUPS: CoreGroup[] = ["draw", "edit", "arrow"];
/** In system-prompt order. */
export const EXTRA_GROUPS: ExtraGroup[] = ["diagram", "object", "dimension", "motion", "graph", "chart", "scroll"];
export const TOOL_GROUPS: ToolGroup[] = [...CORE_GROUPS, ...EXTRA_GROUPS];

/** Always sent: tiny, and "undo" can follow any command. */
export const BASE_TOOLS: ActionName[] = ["undo_last_command", "clear_board"];
export const GROUP_TOOLS: Record<ToolGroup, ActionName[]> = {
  draw: ["add_shape", "add_text"],
  edit: ["move_element", "update_element", "delete_elements"],
  arrow: ["add_arrow"],
  diagram: ["generate_diagram"],
  object: ["add_object"],
  dimension: ["add_dimension"],
  motion: ["animate_element"],
  graph: ["plot_graph"],
  chart: ["add_chart"],
  scroll: ["scroll_view", "zoom_view"],
};

export const DEFAULT_TOOL_ROUTER: ToolRouterMode = "auto";

export function toolRouterFromEnv(env: NodeJS.ProcessEnv = process.env): ToolRouterMode {
  const v = env.TOOL_ROUTER?.trim().toLowerCase();
  if (!v) return DEFAULT_TOOL_ROUTER;
  if (v !== "auto" && v !== "all") throw new Error(`TOOL_ROUTER must be "auto" or "all" (got "${env.TOOL_ROUTER}")`);
  return v;
}

/** The local decision model's tool answer (fastpath/decide.py tool_hint); null/absent = not confident. */
export interface ToolHint {
  core?: CoreGroup[] | null;
}

/** Core groups an extra group's guidance relies on: diagrams are extended with shapes and arrows, pictures get captions. */
const NEEDS: Partial<Record<ExtraGroup, CoreGroup[]>> = { diagram: ["draw", "arrow"], object: ["draw"], dimension: ["draw"] };

/**
 * The groups a request gets, in TOOL_GROUPS order: every group for "all"; else the keyword extras, the core
 * groups the local model's hint names (all three without one) and those the extras rely on.
 */
export function groupsFor(mode: ToolRouterMode, text: string, scene: SceneSummary, hint?: ToolHint): ToolGroup[] {
  if (mode === "all") return TOOL_GROUPS;
  const extras = selectGroups(text, scene);
  const core = new Set<ToolGroup>(hint?.core ?? CORE_GROUPS);
  for (const g of extras) for (const c of NEEDS[g] ?? []) core.add(c);
  return TOOL_GROUPS.filter((g) => core.has(g) || (extras as ToolGroup[]).includes(g));
}

/** Label for the done event and the activity log: ["all"], ["core", ...extras], or the groups ("base" if none). */
export function groupsLabel(groups: ToolGroup[]): string[] {
  if (groups.length === TOOL_GROUPS.length) return ["all"];
  if (CORE_GROUPS.every((g) => groups.includes(g))) return ["core", ...groups.filter((g) => !CORE_GROUPS.includes(g as CoreGroup))];
  return groups.length ? groups : ["base"];
}

const DIAGRAM =
  /\b(diagrams?|flow ?charts?|architecture|workflows?|pipelines?|hierarch(y|ies)|org chart|mind ?maps?|process(es)?|steps|stages|timelines?|sequence|lifecycle|funnel)\b/;
const MANY_BOXES = /\b([3-9]|three|four|five|six|seven|eight|nine|ten) (connected )?(boxes|steps|nodes|stages)\b/;

const MEASUREMENT = /\b\d+(\.\d+)?\s*(ft|feet|foot|m|meters?|metres?|cm|mm|km|in|inch(es)?|miles?|yards?|yd|px|kg)\b/;
const DIMENSION = /\b(tall|wide|height|width|distance|apart|measure(ment)?s?|dimensions?|length)\b/;

// Mirrors fastpath/rules.py has_motion (minus "go", which is mostly scrolling: "go to the top").
const MOTION_VERB =
  /\b(walk|head|travel|march|follow|rush|race|dash|drive|chase|stroll|creep|crawl|wander|tiptoe)(s|es|ed|ing)?\b|\b(zooms|zoomed|zooming|run|runs|running|ran|fly|flies|flying|flew|moves|moving|animate[sd]?|animation)\b/;
const TOWARD = /\b(towards?|away from)\b/;

const SCROLL =
  /\b(scroll(s|ed|ing)?|pan(s|ned|ning)?|camera|viewport|canvas|view|screen|zoom|magnif(y|ied)|actual size|fit|show (me|everything|all|the whole)|go (back )?to|jump to|take me|focus on|back to the|all the way|top of|bottom of)\b/;

const GRAPH =
  /\b(graphs?|plot(s|ted|ting)?|equations?|functions?|parabola|hyperbola|sine|cosine|tangent|curves?|axis|axes|sin|cos|tan|sqrt|log|ln|exp)\b/;
const EQUATION = /\b(y|f\s*\(\s*x\s*\))\s*=|=\s*y\b|\bx\s*(\^|\*\*)|\bx\s*squared\b/;

const CHART =
  /\b(charts?|histograms?|pie chart|donuts? chart|doughnut|bar graph|columns?|series|percent(age)?s?|data|dataset|sales|revenue|budget|statistics|stats|q[1-4])\b|%/;
/** With a chart on the board these also mean the chart ("make it a pie", "add a 2025 series"). */
const CHART_ON_BOARD = /\b(pie|donut|line|bars?|area|slices?|values?|numbers?)\b|\d/;

const words = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** Names a category or series of a chart on the board ("set Q2 to 20", "remove food"); as fastpath/rules.py edits_chart. */
export function editsChart(text: string, scene: SceneSummary): boolean {
  const cmd = words(text);
  for (const el of scene.elements) {
    if (el.type !== "chart" || !el.data) continue;
    for (const [, name] of el.data.split("; unit ")[0].matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
      const w = words(name);
      if (w.length && cmd.some((_, i) => w.every((x, j) => cmd[i + j] === x))) return true;
    }
  }
  return false;
}

/** The extra tool groups a command needs, in EXTRA_GROUPS order. Plain code: keywords plus the scene. */
export function selectGroups(text: string, scene: SceneSummary): ExtraGroup[] {
  const t = text.toLowerCase();
  const hasChart = scene.elements.some((e) => e.type === "chart");
  const on: Record<ExtraGroup, boolean> = {
    diagram: DIAGRAM.test(t) || MANY_BOXES.test(t),
    object: mentionsObject(t),
    dimension: MEASUREMENT.test(t) || DIMENSION.test(t),
    motion: MOTION_VERB.test(t) || (/\b(move|bring|go(es)?|went|come(s)?)\b/.test(t) && TOWARD.test(t)),
    graph: GRAPH.test(t) || EQUATION.test(t),
    chart: CHART.test(t) || (hasChart && (CHART_ON_BOARD.test(t) || editsChart(t, scene))),
    scroll: SCROLL.test(t),
  };
  return EXTRA_GROUPS.filter((g) => on[g]);
}
