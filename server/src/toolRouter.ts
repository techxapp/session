import type { ActionName, SceneSummary, ToolRouterMode } from "@board/shared";
import { mentionsObject } from "./objects";

/**
 * Tool router: a cloud request carries the core tools plus only the groups a command needs, picked here in
 * plain code (keywords + the scene), so requests stay small (free tiers with small per-request limits answer
 * 413 to the full ~21k-character tool list). Misses degrade gracefully: the core tools can still draw a
 * labelled box. Each group also brings its own system-prompt bullets (prompt.ts#promptFor), and chart
 * `data` lines are only sent with the chart group. Over-including a group only costs a few k characters.
 */
export type ToolGroup = "diagram" | "object" | "dimension" | "motion" | "graph" | "chart" | "scroll";
/** In system-prompt order. */
export const TOOL_GROUPS: ToolGroup[] = ["diagram", "object", "dimension", "motion", "graph", "chart", "scroll"];

export const CORE_TOOLS: ActionName[] = [
  "add_shape",
  "add_text",
  "add_arrow",
  "move_element",
  "update_element",
  "delete_elements",
  "undo_last_command",
  "clear_board",
];
export const GROUP_TOOLS: Record<ToolGroup, ActionName[]> = {
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

/** The groups a request gets: every group for "all", else what the command's words and the scene call for. */
export function groupsFor(mode: ToolRouterMode, text: string, scene: SceneSummary): ToolGroup[] {
  return mode === "all" ? TOOL_GROUPS : selectGroups(text, scene);
}

/** Label for the done event and the activity log: ["all"] or ["core", ...extras]. */
export function groupsLabel(groups: ToolGroup[]): string[] {
  return groups.length === TOOL_GROUPS.length ? ["all"] : ["core", ...groups];
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

/** The extra tool groups a command needs, in TOOL_GROUPS order. Plain code: keywords plus the scene. */
export function selectGroups(text: string, scene: SceneSummary): ToolGroup[] {
  const t = text.toLowerCase();
  const hasChart = scene.elements.some((e) => e.type === "chart");
  const on: Record<ToolGroup, boolean> = {
    diagram: DIAGRAM.test(t) || MANY_BOXES.test(t),
    object: mentionsObject(t),
    dimension: MEASUREMENT.test(t) || DIMENSION.test(t),
    motion: MOTION_VERB.test(t) || (/\b(move|bring|go(es)?|went|come(s)?)\b/.test(t) && TOWARD.test(t)),
    graph: GRAPH.test(t) || EQUATION.test(t),
    chart: CHART.test(t) || (hasChart && (CHART_ON_BOARD.test(t) || editsChart(t, scene))),
    scroll: SCROLL.test(t),
  };
  return TOOL_GROUPS.filter((g) => on[g]);
}
