import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { type Animation, translate } from "./executor";

const BOB_PX = 6;
const STEP_PX = 60;

export const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/**
 * Tween `anim.id` from its place in `start` to its place in `end` (the executor's result), one frame per
 * requestAnimationFrame. In-between frames use CaptureUpdateAction.NEVER so undo only sees the end state.
 * An abort (barge-in) jumps straight to `end`.
 */
export function playAnimation(
  api: ExcalidrawImperativeAPI,
  start: readonly ExcalidrawElement[],
  end: ExcalidrawElement[],
  anim: Animation,
  signal: AbortSignal,
): Promise<void> {
  const ids = new Set([anim.id]);
  const steps = Math.max(1, Math.round(Math.hypot(anim.dx, anim.dy) / STEP_PX));
  return new Promise((done) => {
    const t0 = performance.now();
    const finish = () => {
      signal.removeEventListener("abort", finish);
      api.updateScene({ elements: end, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      done();
    };
    if (signal.aborted) return finish();
    signal.addEventListener("abort", finish);
    const frame = (now: number) => {
      if (signal.aborted) return;
      const t = Math.min(1, (now - t0) / anim.durationMs);
      if (t >= 1) return finish();
      const p = easeInOut(t);
      const bob = anim.style === "walk" ? -Math.abs(Math.sin(t * Math.PI * steps)) * BOB_PX : 0;
      const els = translate(start, ids, anim.dx * p, anim.dy * p + bob);
      api.updateScene({ elements: els, captureUpdate: CaptureUpdateAction.NEVER });
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}
