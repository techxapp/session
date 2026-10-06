# session

Session helper: a whiteboard that draws diagrams from what you say. You describe boxes, arrows, notes or a whole diagram, and they appear on an [Excalidraw](https://github.com/excalidraw/excalidraw) canvas within about a second.

It's built as a "System 1" assistant (the idea behind TypeSafe's Jev). A small, fast model turns each command into **typed board actions** such as `add_shape`, `add_arrow` or `move_element`. The browser validates those actions and applies them as they stream in. The full roadmap is in [docs/PLAN.md](docs/PLAN.md).

**Status: milestone 1 of 5.** You type commands; voice input is milestone 2.

## Quick start

Requires Node 22+.

```bash
npm install
cp .env.example .env        # then set ANTHROPIC_API_KEY
npm run dev                 # server on :8787, web app on http://localhost:5173
```

Try: *"Draw a login flow: user, web app, auth service, database"*, then *"make the database green and move it down"*, then *"undo"*.

Without an API key the app still loads. The status pill shows **API key missing** and commands report a clear error.

## How it works

```
 web (React + Excalidraw)                         server (Fastify)
 ┌───────────────────────────────┐   POST /api/command   ┌──────────────────────────────┐
 │ command bar ──► scene summary ├──────────────────────►│ System 1: claude-haiku-4-5   │
 │                               │                       │ streaming tool calls         │
 │ executor ◄── validated actions│◄──── SSE events ──────┤ each call validated (zod)    │
 │ (placement, arrows, undo)     │                       │ and forwarded immediately    │
 └───────────────────────────────┘                       └──────────────────────────────┘
```

- **`shared/`**: the action vocabulary as zod schemas (`shared/src/actions.ts`). The same schemas generate the model's tool definitions and validate every tool call, so the model and the board can't drift apart.
- **`server/`**: one streaming model call per command, with no tool-result round trip. Each completed tool call becomes an SSE `action` event. If you send a new command while one is running, the old request is cancelled.
- **`web/`**: `board/executor.ts` turns actions into Excalidraw elements. It handles relative and region placement, overlap avoidance, arrows bound to shapes (they stay attached when you drag), re-routing on move, label edits and cascading deletes. `board/useCommandRunner.ts` streams events, records one undo step per command and scrolls new content into view.
- The model gets a compact text summary of the scene (ids, labels, positions, selection, recently touched elements), so references like "it", "the database" or "that box" resolve.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Server (tsx watch) and web (Vite) together |
| `npm test` | Executor tests (vitest + jsdom) and server tests (SSE route against a fake model stream) |
| `npm run typecheck` | `tsc --noEmit` in every workspace |
| `npm run format` | Prettier |

In dev builds, `window.__board.apply(text, actions)` feeds actions through the same path as the model. That's useful for demos and UI testing without an API key.

## Configuration (`.env`)

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required for commands; stays server-side |
| `SYSTEM1_MODEL` | `claude-haiku-4-5` | Fast-path model |
| `PORT` | `8787` | Server port (Vite proxies `/api` to it) |

## Licenses

Excalidraw (MIT), React (MIT), Fastify (MIT), zod (MIT), lucide-react (ISC), Anthropic SDK (MIT). Excalidraw's fonts are self-hosted from the npm package (OFL).
