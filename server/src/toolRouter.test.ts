import { describe, expect, it } from "vitest";
import type { SceneSummary } from "@board/shared";
import { GROUP_PROMPT, SYSTEM_PROMPT, buildUserMessage, promptFor } from "./prompt";
import { TOOLS_BY_MODE, toolsFor } from "./system1";
import { openaiToolsFor } from "./system1-openai";
import { TOOL_GROUPS, groupsFor, groupsLabel, selectGroups, type ToolGroup } from "./toolRouter";

const empty: SceneSummary = { elements: [], selectedIds: [], recentIds: [], viewport: { x: 0, y: 0, width: 1200, height: 800 } };
const withChart: SceneSummary = {
  ...empty,
  elements: [
    { id: "box", type: "rectangle", label: "Notes", x: 0, y: 0, w: 100, h: 60 },
    {
      id: "sales",
      type: "chart",
      label: "Sales",
      x: 300,
      y: 0,
      w: 480,
      h: 360,
      data: 'column; labels ["Q1","Q2","Q3"]; series "2024" [10,15,12]',
    },
  ],
};

const CASES: [string, ToolGroup[], SceneSummary?][] = [
  // core only
  ["add a red box next to the api", []],
  ["connect api to db", []],
  ["make it bigger", []],
  ["undo", []],
  ["delete the blue note", []],
  ["add a box labelled checkout", []],
  ["write the title Roadmap", []],
  ["move the box down a bit", []],
  ["rename the box to Payments", []],
  ["clear the board", []],
  // one group each
  ["draw a login flowchart", ["diagram", "object"]],
  ["draw the architecture of a web app", ["diagram"]],
  ["add five steps for onboarding", ["diagram"]],
  ["draw a cat", ["object"]],
  ["put two trees here", ["object"]],
  ["draw a picture of a rocket", ["object"]],
  ["add a kangaroo", ["object"]],
  ["a tree 10 ft tall", ["object", "dimension"]],
  ["the distance between them is 20 meters", ["dimension"]],
  ["the boy walks towards the girl", ["object", "motion"]],
  ["the car drives to the top right", ["object", "motion"]],
  ["move the box towards the circle", ["motion"]],
  ["plot y = x^2", ["graph"]],
  ["graph sin x and cos x", ["graph"]],
  ["f(x) = 2x + 1", ["graph"]],
  ["a pie chart of 40% rent, 30% food, 30% other", ["object", "chart"]],
  ["column chart of sales: Q1 10, Q2 15", ["chart"]],
  ["scroll down", ["scroll"]],
  ["pan left a bit", ["scroll"]],
  ["go to the database", ["scroll"]],
  ["show everything", ["scroll"]],
  ["zoom out", ["scroll"]],
  ["zoom to 150%", ["chart", "scroll"]], // "%" is a chart word; a harmless extra group
  ["reset the zoom", ["scroll"]],
  // scene-dependent chart edits
  ["set Q2 to 20", ["chart"], withChart],
  ["make it a pie", ["object", "chart"], withChart],
  ["set it to 20", [], empty],
  ["set it to 20", ["chart"], withChart],
  ["add a box labelled payments", []],
  ["make the notes box red", [], withChart],
];

describe("selectGroups", () => {
  it.each(CASES)("%s", (text, groups, scene = empty) => {
    expect(selectGroups(text, scene)).toEqual(groups);
  });

  it("gives every group in all mode", () => {
    expect(groupsFor("all", "add a box", empty)).toBe(TOOL_GROUPS);
    expect(groupsLabel(TOOL_GROUPS)).toEqual(["all"]);
    expect(groupsLabel(["chart"])).toEqual(["core", "chart"]);
  });
});

describe("routed tools and prompt", () => {
  it("keeps the core set small and every set byte-stable", () => {
    const core = toolsFor([]);
    expect(JSON.stringify(core).length).toBeLessThan(8000);
    expect(toolsFor([])).toBe(core);
    expect(toolsFor(["chart", "scroll"])).toBe(toolsFor(["chart", "scroll"]));
    expect(core.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    expect(core.slice(0, -1).every((t) => !t.cache_control)).toBe(true);
    expect(toolsFor(TOOL_GROUPS, "text")).toBe(TOOLS_BY_MODE.text);
    expect(openaiToolsFor(["graph"])).toBe(openaiToolsFor(["graph"]));
    expect(openaiToolsFor(["graph"]).map((t) => t.function.name)).toEqual(toolsFor(["graph"]).map((t) => t.name));
  });

  it("sends a group's guidance only with its tools", () => {
    const core = promptFor([]);
    for (const g of TOOL_GROUPS) expect(core).not.toContain(GROUP_PROMPT[g]);
    expect(promptFor(["chart"])).toContain(GROUP_PROMPT.chart);
    expect(promptFor(["chart"])).not.toContain(GROUP_PROMPT.graph);
    expect(core).toContain("approximate it with shapes and text");
    expect(SYSTEM_PROMPT).not.toContain("approximate it with shapes and text");
    expect(promptFor([])).toBe(core);
  });

  it("drops chart data lines without the chart group", () => {
    expect(buildUserMessage("x", withChart)).toContain("data: column");
    expect(buildUserMessage("x", withChart, { chartData: false })).not.toContain("data:");
  });
});
