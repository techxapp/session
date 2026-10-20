import { CLIP_SOURCES, type ClipItem, type ClipSource, type ClipStatus } from "@board/shared";

/** The clips dashboard's filters: by where the transcript came from, by review state, and by text. */
export interface ClipFilters {
  source: "all" | ClipSource;
  status: "all" | ClipStatus;
  query: string;
}

export const DEFAULT_FILTERS: ClipFilters = { source: "all", status: "all", query: "" };
export const SOURCE_NAMES: Record<ClipSource, string> = { moonshine: "Moonshine", deepgram: "Deepgram", assemblyai: "AssemblyAI" };
export const STATUSES: ClipStatus[] = ["unreviewed", "fixed", "confirmed"];
export const STATUS_NAMES: Record<ClipStatus, string> = { unreviewed: "Unreviewed", fixed: "Fixed", confirmed: "Heard right" };

const hasQuery = (item: ClipItem, q: string) => {
  const needle = q.trim().toLowerCase();
  return !needle || [item.heard, item.text ?? "", item.key].some((s) => s.toLowerCase().includes(needle));
};

export const matches = (item: ClipItem, f: ClipFilters) =>
  (f.source === "all" || item.source === f.source) && (f.status === "all" || item.status === f.status) && hasQuery(item, f.query);

export const filterItems = (items: ClipItem[], f: ClipFilters) => items.filter((i) => matches(i, f));

/**
 * Counts for the filter chips. Each group is counted with the other filters applied, so a chip's number is what
 * picking it would show.
 */
export function facetCounts(items: ClipItem[], f: ClipFilters) {
  const sources = { all: 0 } as Record<"all" | ClipSource, number>;
  const statuses = { all: 0 } as Record<"all" | ClipStatus, number>;
  CLIP_SOURCES.forEach((s) => (sources[s] = 0));
  STATUSES.forEach((s) => (statuses[s] = 0));
  for (const i of items) {
    if (!hasQuery(i, f.query)) continue;
    if (f.status === "all" || i.status === f.status) {
      sources.all++;
      sources[i.source]++;
    }
    if (f.source === "all" || i.source === f.source) {
      statuses.all++;
      statuses[i.status]++;
    }
  }
  return { sources, statuses };
}

export const minutes = (items: ClipItem[]) => items.reduce((s, i) => s + i.seconds, 0) / 60;

/** The text box's starting value: the label, else what was heard. */
export const initialText = (item: ClipItem) => item.text ?? item.heard;
