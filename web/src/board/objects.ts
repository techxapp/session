import type { ExcalidrawElement, FileId } from "@excalidraw/excalidraw/element/types";
import type { BinaryFileData, DataURL, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ObjectName } from "@board/shared";

/**
 * Clip-art for `add_object`. Each object is an image element whose fileId is fixed per object, so every
 * tree on the board shares one file and a saved scene only needs element JSON: the SVGs ship with the app
 * (web/public/objects) and are loaded into Excalidraw on demand.
 */
export const OBJECT_SIZES = { small: 64, medium: 120, large: 200 } as const;

const FILE_PREFIX = "object:";
/** Raster size of loaded clip-art. PNG, not SVG: Excalidraw colour-inverts SVG images in dark mode. */
const RASTER_PX = 512;

export const objectFileId = (name: ObjectName) => `${FILE_PREFIX}${name}` as FileId;
const objectUrl = (name: string) => `${import.meta.env.BASE_URL}objects/${name.replace(/ /g, "-")}.svg`;

/** The object an element draws, if it is one of ours. */
export function objectOf(el: ExcalidrawElement): ObjectName | undefined {
  return el.type === "image" && el.customData?.kind === "object" ? (el.customData.object as ObjectName) : undefined;
}

async function rasterize(svg: string): Promise<DataURL> {
  const img = new Image();
  img.src = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = RASTER_PX;
    canvas.height = Math.round((RASTER_PX * img.naturalHeight) / img.naturalWidth);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png") as DataURL;
  } finally {
    URL.revokeObjectURL(img.src);
  }
}

const loading = new Map<string, Promise<BinaryFileData | null>>();

function fetchObject(fileId: FileId): Promise<BinaryFileData | null> {
  let p = loading.get(fileId);
  if (!p) {
    p = fetch(objectUrl(fileId.slice(FILE_PREFIX.length)))
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))))
      .then(rasterize)
      .then((dataURL) => ({ id: fileId, mimeType: "image/png" as const, dataURL, created: Date.now() }))
      .catch((err) => {
        console.warn(`couldn't load ${fileId}`, err);
        loading.delete(fileId); // allow a retry later
        return null;
      });
    loading.set(fileId, p);
  }
  return p;
}

/** Add the image files for any object elements on the board that Excalidraw doesn't have yet. */
export async function loadObjectFiles(api: ExcalidrawImperativeAPI) {
  const have = api.getFiles();
  const missing = new Set<FileId>();
  for (const el of api.getSceneElements()) {
    if (el.type === "image" && el.fileId?.startsWith(FILE_PREFIX) && !have[el.fileId]) missing.add(el.fileId);
  }
  if (!missing.size) return;
  const files = (await Promise.all([...missing].map(fetchObject))).filter((f): f is BinaryFileData => f !== null);
  if (files.length) api.addFiles(files);
}
