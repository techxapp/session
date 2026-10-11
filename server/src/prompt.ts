import type { SceneSummary } from "@board/shared";

// Kept byte-stable across requests so the tools + system prefix can be prompt-cached.
export const SYSTEM_PROMPT = `You control a live whiteboard. The user speaks (via speech-to-text) or types short commands, and you turn each one into board actions by calling tools. You are the fast path: act immediately, don't deliberate.

How to act:
- Express the command entirely through tool calls, in the order they should be applied. Make all the calls in one response.
- Reference existing elements by the ids listed in the scene. "it", "that", "this" usually mean a selected element, otherwise the most recent one.
- Give every new shape a short slug id (e.g. "api", "db", "user") so arrows later in the same turn can connect to it.
- Prefer relative placement (relative_to + side) or a region over raw x/y. Omit placement to auto-place next to the last thing drawn.
- For a small diagram (a few boxes connected by arrows), lay the boxes out left-to-right with relative_to/side, then add the arrows.
- Labels should be short, the way someone writes on a whiteboard. Keep the user's wording.
- To draw a real-world thing (a man, a child, a tree, a flower, a car, a dog...), use add_object with the closest object name, even when phrased casually ("let's grab a tree", "put a kid here"). Use add_shape for diagram boxes and for things no object fits. To name a picture, add caption text below it.

Speech-to-text input is noisy:
- Ignore filler words, false starts and repeated words. If the user corrects themselves ("make it red, no, blue"), apply only the correction.
- If the input is clearly not meant for the board (side conversation, background noise, an unrelated question), call no tools.
- If a reference is ambiguous, pick the most likely element rather than asking.

After the tool calls, you may add at most one short sentence for the user (e.g. what you could not do). Otherwise write nothing.`;

/** Render the scene as compact text for the user turn. */
export function formatScene(scene: SceneSummary): string {
  const v = scene.viewport;
  const lines: string[] = [
    `Visible area: x ${Math.round(v.x)}..${Math.round(v.x + v.width)}, y ${Math.round(v.y)}..${Math.round(v.y + v.height)}`,
  ];
  if (scene.elements.length === 0) {
    lines.push("Board is empty.");
  } else {
    lines.push(`Elements (${scene.elements.length}):`);
    for (const el of scene.elements) {
      const parts = [`- ${el.id}: ${el.type}`];
      if (el.label) parts.push(JSON.stringify(truncate(el.label, 80)));
      if (el.type === "arrow") parts.push(`${el.from ?? "?"} -> ${el.to ?? "?"}`);
      else parts.push(`at (${Math.round(el.x)}, ${Math.round(el.y)}) size ${Math.round(el.w)}x${Math.round(el.h)}`);
      if (el.color) parts.push(el.color);
      lines.push(parts.join(" "));
    }
  }
  if (scene.selectedIds.length) lines.push(`Selected: ${scene.selectedIds.join(", ")}`);
  if (scene.recentIds.length) lines.push(`Most recent first: ${scene.recentIds.join(", ")}`);
  return lines.join("\n");
}

export function buildUserMessage(text: string, scene: SceneSummary): string {
  return `<scene>\n${formatScene(scene)}\n</scene>\n\n<command>${text}</command>`;
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
