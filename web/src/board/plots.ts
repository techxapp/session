import type { ExcalidrawElement, FileId } from "@excalidraw/excalidraw/element/types";
import type { BinaryFileData, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { type ChartSpec, chartFileId, chartHover, chartOf, renderChartSvg } from "./chart";
import { type GraphSpec, graphFileId, graphHover, graphOf, renderGraphSvg } from "./graph";
import { rasterize } from "./objects";
import type { HoverReadout } from "./plot-base";

/**
 * Plots = equation graphs (graph.ts) + data charts (chart.ts). Both are single image elements drawn from the
 * spec in their customData; this module draws their PNGs on demand and finds the one under the pointer.
 */
export type PlotSpec = GraphSpec | ChartSpec;

export function plotOf(el: ExcalidrawElement): PlotSpec | undefined {
  return graphOf(el) ?? chartOf(el);
}

export function plotLabel(spec: PlotSpec): string {
  if (spec.title) return spec.title;
  return spec.kind === "graph" ? spec.equations.join("; ") : `${spec.chart} chart`;
}

export const plotFileId = (spec: PlotSpec): FileId => (spec.kind === "graph" ? graphFileId(spec) : chartFileId(spec));
export const renderPlotSvg = (spec: PlotSpec) => (spec.kind === "graph" ? renderGraphSvg(spec) : renderChartSvg(spec));

/** Raster width cap: sharp at 2.5x the design size without huge data URLs. */
const RASTER_MAX = 1600;
const rendering = new Map<string, Promise<BinaryFileData | null>>();

function renderFile(fileId: FileId, spec: PlotSpec): Promise<BinaryFileData | null> {
  let p = rendering.get(fileId);
  if (!p) {
    p = rasterize(renderPlotSvg(spec), Math.min(RASTER_MAX, Math.round(spec.w * 2.5)))
      .then((dataURL) => ({ id: fileId, mimeType: "image/png" as const, dataURL, created: Date.now() }))
      .catch((err) => {
        console.warn(`couldn't draw ${fileId}`, err);
        rendering.delete(fileId); // allow a retry later
        return null;
      });
    rendering.set(fileId, p);
  }
  return p;
}

/** Draw the PNG for any graph/chart on the board that Excalidraw has no file for yet (new, changed, reloaded or undone). */
export async function loadPlotFiles(api: ExcalidrawImperativeAPI) {
  const have = api.getFiles();
  const missing = new Map<FileId, PlotSpec>();
  for (const el of api.getSceneElements()) {
    const spec = plotOf(el);
    if (spec && el.type === "image" && el.fileId && !have[el.fileId]) missing.set(el.fileId, spec);
  }
  if (!missing.size) return;
  const files = (await Promise.all([...missing].map(([id, spec]) => renderFile(id, spec)))).filter((f): f is BinaryFileData => f !== null);
  if (files.length) api.addFiles(files);
}

/**
 * The readout for scene point p: only the topmost element under the pointer counts (a shape over a chart
 * hides it), and rotated plots are skipped.
 */
export function hoverAt(elements: readonly ExcalidrawElement[], p: { x: number; y: number }): HoverReadout | null {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (el.isDeleted || el.type === "arrow" || el.type === "line" || el.type === "freedraw" || (el.type === "text" && el.containerId))
      continue;
    if (p.x < el.x || p.x > el.x + el.width || p.y < el.y || p.y > el.y + el.height) continue;
    const spec = plotOf(el);
    if (!spec || el.angle) return null;
    return spec.kind === "graph" ? graphHover(el, spec, p) : chartHover(el, spec, p);
  }
  return null;
}
