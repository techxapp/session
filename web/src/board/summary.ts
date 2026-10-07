import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";
import type { SceneElementSummary, SceneSummary } from "@board/shared";
import type { Box } from "./geometry";
import { isTopLevel, labelOf } from "./executor";
import { colorName } from "./style";

const KNOWN = new Set(["rectangle", "ellipse", "diamond", "text", "arrow", "image"]);

export function visibleArea(appState: Pick<AppState, "scrollX" | "scrollY" | "zoom" | "width" | "height">): Box {
  const z = appState.zoom.value;
  return { x: -appState.scrollX, y: -appState.scrollY, w: appState.width / z, h: appState.height / z };
}

/** Compact, model-friendly view of the board. */
export function summarize(elements: readonly ExcalidrawElement[], selectedIds: string[], recentIds: string[], viewport: Box): SceneSummary {
  const live = elements.filter(isTopLevel);
  const liveIds = new Set(live.map((e) => e.id));
  const summary: SceneElementSummary[] = live.map((e) => {
    const kind = (e.customData?.kind as string | undefined) ?? e.type;
    const item: SceneElementSummary = {
      id: e.id,
      type: (kind === "sticky" ? "sticky" : KNOWN.has(kind) ? kind : "other") as SceneElementSummary["type"],
      x: Math.round(e.x),
      y: Math.round(e.y),
      w: Math.round(e.width),
      h: Math.round(e.height),
    };
    const label = labelOf(elements, e);
    if (label) item.label = label;
    const color = colorName(e.strokeColor);
    if (color) item.color = color;
    if (e.type === "arrow") {
      if (e.startBinding) item.from = e.startBinding.elementId;
      if (e.endBinding) item.to = e.endBinding.elementId;
    }
    return item;
  });
  return {
    elements: summary,
    selectedIds: selectedIds.filter((id) => liveIds.has(id)),
    recentIds: recentIds.filter((id) => liveIds.has(id)).slice(0, 8),
    viewport: { x: viewport.x, y: viewport.y, width: viewport.w, height: viewport.h },
  };
}
