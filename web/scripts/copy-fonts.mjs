// Self-host Excalidraw's fonts (it otherwise fetches them from a public CDN at runtime).
import { cpSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// The package entry resolves to dist/prod/index.js; fonts sit next to it.
const src = join(dirname(require.resolve("@excalidraw/excalidraw")), "fonts");
const dest = join(dirname(fileURLToPath(import.meta.url)), "../public/fonts");
if (!existsSync(src)) throw new Error(`Excalidraw fonts not found at ${src}`);
cpSync(src, dest, { recursive: true });
console.log(`copied Excalidraw fonts -> ${dest}`);
