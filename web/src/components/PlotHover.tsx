import { useEffect, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { HoverReadout } from "../board/plot-base";
import { hoverAt } from "../board/plots";

interface View {
  readout: HoverReadout;
  /** Scene -> screen: screen = (scene + scroll) * zoom + offset. */
  scrollX: number;
  scrollY: number;
  zoom: number;
  offsetLeft: number;
  offsetTop: number;
}

/** Tools that leave the pointer free for reading values (not while drawing or erasing). */
const READING_TOOLS = new Set(["selection", "hand", "laser"]);

/**
 * Hover readout for graphs and charts: a crosshair/dot or highlight over the plot plus a tooltip with the
 * values under the mouse. A passive layer (pointer-events: none) over the canvas: it listens to window
 * pointer moves and re-reads on scroll/zoom and board changes, so Excalidraw itself never re-renders for it.
 */
export function PlotHover({ api }: { api: ExcalidrawImperativeAPI | null }) {
  const [view, setView] = useState<View | null>(null);

  useEffect(() => {
    if (!api) return;
    let pointer: { x: number; y: number } | null = null; // client coords, null = not hovering the canvas
    let raf = 0;
    const update = () => {
      raf = 0;
      const st = api.getAppState();
      if (!pointer || !READING_TOOLS.has(st.activeTool.type) || st.editingTextElement || st.newElement) return setView(null);
      const zoom = st.zoom.value;
      const p = { x: (pointer.x - st.offsetLeft) / zoom - st.scrollX, y: (pointer.y - st.offsetTop) / zoom - st.scrollY };
      const readout = hoverAt(api.getSceneElements(), p);
      setView(readout && { readout, scrollX: st.scrollX, scrollY: st.scrollY, zoom, offsetLeft: st.offsetLeft, offsetTop: st.offsetTop });
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    const onMove = (e: PointerEvent) => {
      // Only a free (unpressed) mouse/pen over the canvas: hide while dragging, and over toolbars and panels.
      pointer = e.buttons === 0 && e.target instanceof HTMLCanvasElement ? { x: e.clientX, y: e.clientY } : null;
      schedule();
    };
    const hide = () => {
      pointer = null;
      schedule();
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", hide, { passive: true });
    document.documentElement.addEventListener("pointerleave", hide);
    window.addEventListener("blur", hide);
    const offScroll = api.onScrollChange(schedule);
    const offChange = api.onChange(schedule);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", hide);
      document.documentElement.removeEventListener("pointerleave", hide);
      window.removeEventListener("blur", hide);
      offScroll();
      offChange();
    };
  }, [api]);

  if (!view) return null;
  const { readout, zoom } = view;
  const toScreen = (p: { x: number; y: number }) => ({
    x: (p.x + view.scrollX) * zoom + view.offsetLeft,
    y: (p.y + view.scrollY) * zoom + view.offsetTop,
  });
  const anchor = toScreen(readout.anchor);
  const flip = anchor.x > window.innerWidth - 260;
  const below = anchor.y < 120;

  return (
    <div className="plot-hover" aria-hidden>
      <svg className="plot-hover-marks">
        <g transform={`translate(${view.offsetLeft + view.scrollX * zoom} ${view.offsetTop + view.scrollY * zoom}) scale(${zoom})`}>
          {readout.marks.map((m, i) => {
            switch (m.type) {
              case "vline":
                return (
                  <line key={i} x1={m.x} x2={m.x} y1={m.top} y2={m.bottom} className="plot-hover-guide" vectorEffect="non-scaling-stroke" />
                );
              case "dot":
                return (
                  <circle
                    key={i}
                    cx={m.x}
                    cy={m.y}
                    r={5.5 / zoom}
                    fill={m.color}
                    className="plot-hover-dot"
                    vectorEffect="non-scaling-stroke"
                  />
                );
              case "rect":
                return (
                  <rect key={i} x={m.x} y={m.y} width={m.w} height={m.h} className="plot-hover-shape" vectorEffect="non-scaling-stroke" />
                );
              case "path":
                return <path key={i} d={m.d} className="plot-hover-shape" fillRule="evenodd" vectorEffect="non-scaling-stroke" />;
            }
          })}
        </g>
      </svg>
      <div
        className="plot-tip"
        style={{
          left: anchor.x + (flip ? -14 : 14),
          top: anchor.y + (below ? 14 : -14),
          transform: `translate(${flip ? "-100%" : "0"}, ${below ? "0" : "-100%"})`,
        }}
      >
        <div className="plot-tip-heading">{readout.heading}</div>
        {readout.rows.map((r, i) => (
          <div key={i} className={`plot-tip-row${r.strong ? " is-strong" : ""}`}>
            <span className="plot-tip-swatch" style={{ background: r.color }} />
            {readout.rows.length > 1 || !r.value.startsWith("y =") ? <span className="plot-tip-label">{r.label}</span> : null}
            <span className="plot-tip-value">{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
