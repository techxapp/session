import { FONT_FAMILY } from "@excalidraw/excalidraw";
import type { Color } from "@board/shared";

/** Named colors -> Excalidraw palette (stroke, light fill). */
export const PALETTE: Record<Color, { stroke: string; fill: string }> = {
  black: { stroke: "#1e1e1e", fill: "#f1f3f5" },
  gray: { stroke: "#495057", fill: "#e9ecef" },
  red: { stroke: "#e03131", fill: "#ffc9c9" },
  orange: { stroke: "#e8590c", fill: "#ffd8a8" },
  yellow: { stroke: "#f08c00", fill: "#ffec99" },
  green: { stroke: "#2f9e44", fill: "#b2f2bb" },
  teal: { stroke: "#0c8599", fill: "#96f2d7" },
  blue: { stroke: "#1971c2", fill: "#a5d8ff" },
  purple: { stroke: "#6741d9", fill: "#d0bfff" },
  pink: { stroke: "#c2255c", fill: "#fcc2d7" },
};

export function colorName(stroke: string | undefined): Color | undefined {
  if (!stroke) return undefined;
  const hit = (Object.keys(PALETTE) as Color[]).find((c) => PALETTE[c].stroke.toLowerCase() === stroke.toLowerCase());
  return hit && hit !== "black" ? hit : undefined;
}

export const SHAPE_SIZES = {
  small: { w: 130, h: 64 },
  medium: { w: 180, h: 84 },
  large: { w: 260, h: 120 },
} as const;

export const TEXT_SIZES = { title: 36, heading: 28, body: 20, caption: 16 } as const;

export const NUDGE = { little: 40, some: 140, far: 320 } as const;

/** Grow a shape so its label fits roughly on 1-3 lines. */
export function fitLabel(base: { w: number; h: number }, label: string | undefined, kind: string) {
  if (!label) return { ...base };
  const longest = Math.max(...label.split("\n").map((l) => l.length));
  const pad = kind === "diamond" ? 2 : kind === "ellipse" ? 1.5 : 1;
  const w = Math.min(420, Math.max(base.w, (longest * 11 + 40) * pad));
  const lines = label.split("\n").length + Math.floor((longest * 11) / 420);
  const h = Math.max(base.h, (lines * 26 + 30) * (kind === "rectangle" || kind === "sticky" ? 1 : 1.4));
  return { w: Math.round(w), h: Math.round(h) };
}

/** AI-drawn elements use a clean sans font and smooth ("architect") strokes. */
export const FONT = FONT_FAMILY.Nunito;
export const ROUGHNESS = 0;
