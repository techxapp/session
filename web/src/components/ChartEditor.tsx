import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { Plus, Table2, X } from "lucide-react";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { CHART_KINDS, type BoardAction, type Color } from "@board/shared";
import { type ChartSpec, chartOf, renderChartSvg } from "../board/chart";
import {
  type ChartDraft,
  MAX_LABELS,
  MAX_SERIES,
  addRow,
  addSeries,
  draftFromSpec,
  draftToAction,
  isPie,
  parseValue,
  pasteCells,
  previewSpec,
  removeRow,
  removeSeries,
  shownSeries,
} from "../board/chartDraft";
import { PALETTE } from "../board/style";

interface Props {
  api: ExcalidrawImperativeAPI | null;
  /** Runs the edit as a command (one undo step, one activity entry). */
  onApply: (text: string, actions: BoardAction[]) => unknown;
}

interface Editing {
  id: string;
  /** The chart's file when the draft was taken; a change means the chart was edited elsewhere (e.g. by voice). */
  fileId: string | null;
  base: ChartSpec;
  draft: ChartDraft;
  dirty: boolean;
}

const KIND_LABELS: Record<ChartDraft["kind"], string> = {
  column: "Column",
  bar: "Bar",
  line: "Line",
  area: "Area",
  pie: "Pie",
  donut: "Donut",
};
const COLORS = Object.keys(PALETTE) as Color[];

/** The one selected chart, unless Excalidraw is busy with it (dragging, resizing, cropping...). */
function selectedChart(elements: readonly ExcalidrawElement[], st: AppState) {
  const ids = Object.keys(st.selectedElementIds).filter((id) => st.selectedElementIds[id]);
  if (ids.length !== 1 || st.selectedElementsAreBeingDragged || st.isResizing || st.isRotating || st.isCropping) return undefined;
  if (st.newElement || st.editingTextElement) return undefined;
  const el = elements.find((e) => e.id === ids[0]);
  return el && chartOf(el) ? el : undefined;
}

const toScene = (st: AppState, clientX: number, clientY: number) => ({
  x: (clientX - st.offsetLeft) / st.zoom.value - st.scrollX,
  y: (clientY - st.offsetTop) / st.zoom.value - st.scrollY,
});

/**
 * Edit a chart's data by hand: an "Edit data" button over the selected chart (or double-click it, or Enter,
 * which would otherwise start Excalidraw's image cropping) opens a table of labels x series with kind, title,
 * unit and colours, and a live preview. Apply sends the same `add_chart` + `replace` action the model uses.
 */
export function ChartEditor({ api, onApply }: Props) {
  const [anchor, setAnchor] = useState<{ id: string; left: number; top: number } | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [picking, setPicking] = useState<{ type: "series" | "label"; i: number; x: number; y: number } | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const lastPreview = useRef<string | undefined>(undefined);

  const open = (el: ExcalidrawElement) => {
    const spec = chartOf(el);
    if (!spec) return;
    setPicking(null);
    lastPreview.current = undefined;
    setEditing({ id: el.id, fileId: fileIdOf(el), base: spec, draft: draftFromSpec(spec), dirty: false });
  };
  const openRef = useRef(open);
  openRef.current = open;

  // Follow the selection (for the button) and the chart being edited (deleted -> close; changed elsewhere -> reload a clean draft).
  useEffect(() => {
    if (!api) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const st = api.getAppState();
      const elements = api.getSceneElements();
      const el = selectedChart(elements, st);
      if (!el) setAnchor((a) => (a ? null : a));
      else {
        const zoom = st.zoom.value;
        const left = Math.round((el.x + st.scrollX) * zoom + st.offsetLeft);
        const top = Math.round((el.y + st.scrollY) * zoom + st.offsetTop);
        setAnchor((a) => (a && a.id === el.id && a.left === left && a.top === top ? a : { id: el.id, left, top }));
      }
      setEditing((ed) => {
        if (!ed) return ed;
        const cur = elements.find((e) => e.id === ed.id);
        const spec = cur && chartOf(cur);
        if (!cur || !spec) return null;
        const fileId = fileIdOf(cur);
        if (fileId === ed.fileId) return ed;
        return ed.dirty ? { ...ed, fileId, base: spec } : { ...ed, fileId, base: spec, draft: draftFromSpec(spec) };
      });
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    // Double-click / Enter on a selected chart opens the editor instead of Excalidraw's image cropping.
    const onDblClick = (e: MouseEvent) => {
      if (!(e.target instanceof HTMLCanvasElement)) return;
      const st = api.getAppState();
      const el = selectedChart(api.getSceneElements(), st);
      if (!el) return;
      const p = toScene(st, e.clientX, e.clientY);
      if (p.x < el.x || p.y < el.y || p.x > el.x + el.width || p.y > el.y + el.height) return;
      e.stopPropagation();
      openRef.current(el);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Enter" || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, select, button, [contenteditable], .chart-editor")) return;
      const el = selectedChart(api.getSceneElements(), api.getAppState());
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      openRef.current(el);
    };
    window.addEventListener("dblclick", onDblClick, true);
    window.addEventListener("keydown", onKey, true);
    const offChange = api.onChange(schedule);
    const offScroll = api.onScrollChange(schedule);
    schedule();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("dblclick", onDblClick, true);
      window.removeEventListener("keydown", onKey, true);
      offChange();
      offScroll();
    };
  }, [api]);

  // Move focus where an action asked for it, once the new row/cell exists.
  useEffect(() => {
    if (!pendingFocus.current) return;
    panel.current?.querySelector<HTMLInputElement>(pendingFocus.current)?.focus();
    pendingFocus.current = null;
  });

  const result = useMemo(() => editing && draftToAction(editing.draft, editing.id), [editing]);
  const preview = useMemo(() => {
    const spec = editing && previewSpec(editing.draft, editing.base);
    return spec ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderChartSvg(spec))}` : undefined;
  }, [editing]);
  if (preview) lastPreview.current = preview;

  // Excalidraw's hint for a selected image offers double-click/Enter to crop, which here open the editor.
  const hideCropHint = anchor && <style>{".excalidraw .HintViewer { visibility: hidden; }"}</style>;
  const editButton = anchor && editing?.id !== anchor.id && (
    <div className="chart-edit-layer">
      <button
        className="chart-edit-btn"
        style={{ left: Math.max(8, anchor.left), top: anchor.top > 110 ? anchor.top - 10 : anchor.top + 10 }}
        data-below={anchor.top > 110 ? undefined : ""}
        onClick={() => {
          const el = api?.getSceneElements().find((e) => e.id === anchor.id);
          if (el) open(el);
        }}
        title="Edit this chart's data (or double-click the chart)"
      >
        <Table2 size={14} /> Edit data
      </button>
    </div>
  );
  if (!editing)
    return (
      <>
        {hideCropHint}
        {editButton}
      </>
    );

  const { draft } = editing;
  const pie = isPie(draft.kind);
  const series = shownSeries(draft);
  const change = (fn: (d: ChartDraft) => ChartDraft) => setEditing((ed) => ed && { ...ed, draft: fn(ed.draft), dirty: true });
  const close = () => {
    setEditing(null);
    setPicking(null);
  };
  const apply = () => {
    if (!result?.ok || !editing.dirty) return;
    const name = draft.title.trim();
    onApply(name ? `Edit chart "${name}"` : "Edit chart", [result.action]);
    close();
  };
  const cell = (row: number, col: number) => `[data-cell="${row}:${col}"]`;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation(); // keep Excalidraw's shortcuts (Delete, arrows, letters) off the board while typing here
    if (e.key === "Escape") {
      if (picking) setPicking(null);
      else close();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      apply();
    } else if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      // Spreadsheet-style: Enter goes down a row, adding one at the bottom.
      const at = (e.target as HTMLElement).dataset?.cell?.split(":").map(Number);
      if (!at) return;
      e.preventDefault();
      const [row, col] = at;
      if (row + 1 < draft.labels.length) panel.current?.querySelector<HTMLInputElement>(cell(row + 1, col))?.focus();
      else if (draft.labels.length < MAX_LABELS) {
        pendingFocus.current = cell(row + 1, col);
        change(addRow);
      }
    }
  };
  const onPaste = (row: number, col: number) => (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text/plain");
    if (!/[\t\n]/.test(text.replace(/\s+$/, ""))) return; // a single value: let the input take it
    e.preventDefault();
    change((d) => pasteCells(d, row, col, text));
  };

  // The colour menu is placed on the panel itself (the grid scrolls sideways and would clip it).
  const swatch = (type: "series" | "label", i: number, color: Color) => (
    <button
      className="swatch"
      style={{ background: PALETTE[color].stroke }}
      onClick={(e) => {
        const b = e.currentTarget.getBoundingClientRect();
        const p = panel.current!.getBoundingClientRect();
        setPicking((cur) => (cur?.type === type && cur.i === i ? null : { type, i, x: b.left - p.left - 6, y: b.bottom - p.top + 6 }));
      }}
      aria-label={`Colour: ${color}`}
      aria-expanded={picking?.type === type && picking.i === i}
      title={`Colour: ${color}`}
    />
  );
  const pickedColor = picking && (picking.type === "label" ? draft.labelColors[picking.i] : draft.series[picking.i]?.color);
  const colorMenu = picking && pickedColor && (
    <div className="swatch-menu" role="menu" style={{ left: picking.x, top: picking.y }}>
      {COLORS.map((c) => (
        <button
          key={c}
          role="menuitemradio"
          aria-checked={c === pickedColor}
          className={`swatch${c === pickedColor ? " is-checked" : ""}`}
          style={{ background: PALETTE[c].stroke }}
          onClick={() => {
            const { type, i } = picking;
            setPicking(null);
            change((d) =>
              type === "label"
                ? { ...d, labelColors: d.labelColors.map((x, j) => (j === i ? c : x)) }
                : { ...d, series: d.series.map((x, j) => (j === i ? { ...x, color: c } : x)) },
            );
          }}
          aria-label={c}
          title={c}
        />
      ))}
    </div>
  );
  const closePicker = () => picking && setPicking(null);

  return (
    <>
      {hideCropHint}
      {editButton}
      <div
        className="chart-editor"
        ref={panel}
        onKeyDown={onKeyDown}
        onPaste={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Edit chart"
      >
        <div className="settings-head">
          <Table2 size={14} />
          <span>Edit chart</span>
          <button className="icon-btn" onClick={close} aria-label="Close" title="Close (Esc)">
            <X size={15} />
          </button>
        </div>

        <div className="settings-body" onScroll={closePicker}>
          <div className="segmented" role="radiogroup" aria-label="Chart kind">
            {CHART_KINDS.map((k) => (
              <button
                key={k}
                role="radio"
                aria-checked={draft.kind === k}
                className={draft.kind === k ? "is-checked" : ""}
                onClick={() => change((d) => ({ ...d, kind: k }))}
              >
                {KIND_LABELS[k]}
              </button>
            ))}
          </div>

          <div className="chart-meta">
            <label className="field">
              <span className="field-label">Title</span>
              <input
                value={draft.title}
                maxLength={100}
                placeholder="No title"
                onChange={(e) => change((d) => ({ ...d, title: e.target.value }))}
              />
            </label>
            <label className="field chart-unit">
              <span className="field-label">Unit</span>
              <input
                value={draft.unit}
                maxLength={12}
                placeholder="e.g. % or $"
                onChange={(e) => change((d) => ({ ...d, unit: e.target.value }))}
              />
            </label>
          </div>

          <div className="chart-grid-wrap" onScroll={closePicker}>
            <table className="chart-grid">
              <thead>
                <tr>
                  <th>Label</th>
                  {series.map((s, si) => (
                    <th key={si}>
                      <div className="chart-cell">
                        {!pie && swatch("series", si, s.color)}
                        <input
                          value={s.name}
                          maxLength={40}
                          placeholder={series.length > 1 ? `Series ${si + 1}` : "Value"}
                          aria-label={`Series ${si + 1} name`}
                          onChange={(e) =>
                            change((d) => ({ ...d, series: d.series.map((x, j) => (j === si ? { ...x, name: e.target.value } : x)) }))
                          }
                        />
                        {series.length > 1 && (
                          <button
                            className="grid-remove"
                            onClick={() => change((d) => removeSeries(d, si))}
                            aria-label="Remove series"
                            title="Remove series"
                          >
                            <X size={12} />
                          </button>
                        )}
                      </div>
                    </th>
                  ))}
                  <th aria-hidden />
                </tr>
              </thead>
              <tbody>
                {draft.labels.map((label, ri) => (
                  <tr key={ri}>
                    <td>
                      <div className="chart-cell">
                        {pie && swatch("label", ri, draft.labelColors[ri])}
                        <input
                          value={label}
                          maxLength={40}
                          placeholder="Label"
                          aria-label={`Row ${ri + 1} label`}
                          data-cell={`${ri}:-1`}
                          onPaste={onPaste(ri, -1)}
                          onChange={(e) => change((d) => ({ ...d, labels: d.labels.map((l, j) => (j === ri ? e.target.value : l)) }))}
                        />
                      </div>
                    </td>
                    {series.map((s, si) => {
                      const v = s.values[ri];
                      return (
                        <td key={si}>
                          <input
                            className={`num${v.trim() && parseValue(v) === undefined ? " is-bad" : ""}`}
                            value={v}
                            inputMode="decimal"
                            placeholder="0"
                            aria-label={`${label || `Row ${ri + 1}`}, ${s.name || `series ${si + 1}`}`}
                            data-cell={`${ri}:${si}`}
                            onPaste={onPaste(ri, si)}
                            onChange={(e) =>
                              change((d) => ({
                                ...d,
                                series: d.series.map((x, j) =>
                                  j === si ? { ...x, values: x.values.map((y, k) => (k === ri ? e.target.value : y)) } : x,
                                ),
                              }))
                            }
                          />
                        </td>
                      );
                    })}
                    <td>
                      <button
                        className="grid-remove"
                        disabled={draft.labels.length <= 1}
                        onClick={() => change((d) => removeRow(d, ri))}
                        aria-label="Remove row"
                        title="Remove row"
                      >
                        <X size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="chart-grid-actions">
            <button
              className="choice choice-add"
              disabled={draft.labels.length >= MAX_LABELS}
              onClick={() => {
                pendingFocus.current = cell(draft.labels.length, -1);
                change(addRow);
              }}
            >
              <Plus size={13} /> Row
            </button>
            {!pie && (
              <button className="choice choice-add" disabled={draft.series.length >= MAX_SERIES} onClick={() => change(addSeries)}>
                <Plus size={13} /> Series
              </button>
            )}
          </div>
          {pie && draft.series.length > 1 && (
            <p className="chart-note">
              A {draft.kind} chart shows only the first series; the others come back if you switch to another kind.
            </p>
          )}

          {lastPreview.current && (
            <img className={`chart-preview${preview ? "" : " is-stale"}`} src={lastPreview.current} alt="Preview of the edited chart" />
          )}
          {result && !result.ok && editing.dirty && <div className="field-error">{result.error}</div>}
        </div>

        {colorMenu}

        <div className="chart-editor-foot">
          <span>Paste cells from a spreadsheet · Ctrl+Enter applies</span>
          <button className="icon-btn text-btn" onClick={close}>
            Cancel
          </button>
          <button className="small-btn" onClick={apply} disabled={!result?.ok || !editing.dirty}>
            Apply
          </button>
        </div>
      </div>
    </>
  );
}

const fileIdOf = (el: ExcalidrawElement) => (el.type === "image" ? el.fileId : null);
