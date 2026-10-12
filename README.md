# session

Session helper: a whiteboard that draws diagrams from what you say. You describe boxes, arrows, notes or a whole diagram, and they appear on an [Excalidraw](https://github.com/excalidraw/excalidraw) canvas within about a second.

It's built as a "System 1" assistant (the idea behind TypeSafe's Jev). A small, fast model turns each command into **typed board actions** such as `add_shape`, `add_arrow` or `move_element`. The browser validates those actions and applies them as they stream in. The full roadmap is in [docs/PLAN.md](docs/PLAN.md).

**Status: milestone 1 of 5.** You type commands; voice input is milestone 2.

## Quick start

Requires Node 22+.

```bash
npm install
cp .env.example .env        # then set ANTHROPIC_API_KEY or OPENAI_API_KEY
npm run dev                 # server on :8787, web app on http://localhost:5173
```

Try: *"Draw a login flow: user, web app, auth service, database"*, then *"make the database green and move it down"*, then *"undo"*.

It can also draw everyday things: *"let's grab a tree"*, *"draw a man and a child next to the house"*, *"make the tree bigger"*. About 210 objects are built in (people, plants, animals, weather, food, buildings, vehicles, office items, symbols); the list is `shared/objects.json`.

Without an API key the app still loads. The status pill shows **API key missing** and commands report a clear error.

## How it works

```
 web (React + Excalidraw)                         server (Fastify)
 ┌───────────────────────────────┐   POST /api/command   ┌──────────────────────────────┐
 │ command bar ──► scene summary ├──────────────────────►│ System 1: Claude or OpenAI  │
 │                               │                       │ streaming tool calls         │
 │ executor ◄── validated actions│◄──── SSE events ──────┤ each call validated (zod)    │
 │ (placement, arrows, undo)     │                       │ and forwarded immediately    │
 └───────────────────────────────┘                       └──────────────────────────────┘
```

- **`shared/`**: the action vocabulary as zod schemas (`shared/src/actions.ts`). The same schemas generate the model's tool definitions and validate every tool call, so the model and the board can't drift apart.
- **`server/`**: one streaming model call per command, with no tool-result round trip. Each completed tool call becomes an SSE `action` event. If you send a new command while one is running, the old request is cancelled.
- **`web/`**: `board/executor.ts` turns actions into Excalidraw elements. It handles relative and region placement, overlap avoidance, arrows bound to shapes (they stay attached when you drag), re-routing on move, label edits and cascading deletes. `board/useCommandRunner.ts` streams events, records one undo step per command and scrolls new content into view.
- **Objects** (`add_object`): clip-art from [Fluent Emoji](https://github.com/microsoft/fluentui-emoji) (Flat style), from the `@iconify-json/fluent-emoji-flat` package pinned in `web/package.json`. `npm run dev` and `npm run build` write the SVGs to `web/public/objects/` (gitignored), so nothing is fetched at runtime and it works offline once `npm install` has run. To add an object, add a line to `shared/objects.json` (name, Fluent icon name, aliases) and restart `npm run dev`.
- The model gets a compact text summary of the scene (ids, labels, positions, selection, recently touched elements), so references like "it", "the database" or "that box" resolve.

### Optional: local fast path (rules + Laya)

Simple commands can be settled locally instead of by the cloud LLM, with no API cost. `fastpath/server.py` is a sidecar with three tiers; when `FASTPATH_URL` is set, the server asks it first:

1. **Rules** (code, under 1 ms, no GPU): commands that follow a small fixed grammar, where every word has to be accounted for. These cover undo and clear; delete, recolor, resize and move of a named element ("make the API red", "nudge it a bit left", "delete all the notes"); new shapes with an optional colour, size, region and label ("add a pink sticky saying call the bank"); titles and captions ("add a title that says Q3 plan"); renames ("rename the cache to Redis"); arrows ("connect the API to the cache"); clip-art ("draw a tree"); and simple measurements ("the tree is 10 ft tall"). Any leftover word, second clause or unclear reference passes the command on.
2. **Laya** (optional, about 0.2 s on a 4 GB laptop GPU): a fine-tuned [Laya](https://huggingface.co/convaiinnovations/laya) checkpoint (Apache 2.0) handles what the rules can't parse. It drops chatter ("can everyone see my screen"), handles synonyms and paraphrases ("delete the database" when the box is labelled Postgres), and checks casual object commands ("let's grab a tree" vs. "let's grab a coffee").
3. **Cloud**: anything else (several changes, placement next to other elements, generating diagrams, low confidence) goes to the cloud model. So does every command when the sidecar is down or slower than `FASTPATH_TIMEOUT_MS`.

Local actions are validated with the same zod schemas and streamed to the board. Each command in the activity panel (right side; collapse it with its header button) shows a **Local** or **Cloud** badge with the reason, for example "Handled locally (rule: recolor)" or "Sent to the cloud (local model passed: several changes)". The status pill reads "System 1 · Haiku 4.5 + local" when the fast path is on.

Run it. Without a checkpoint the sidecar runs the rules only and needs plain Python 3.10+. With Laya it also needs CUDA PyTorch (see `fastpath/requirements.txt`):

```
python fastpath/server.py                                            # rules only
LAYA_CHECKPOINT=/path/to/laya-checkpoint python fastpath/server.py   # rules + Laya; listens on 127.0.0.1:8788
FASTPATH_URL=http://127.0.0.1:8788 npm run dev
```

The checkpoint is produced by `eval/make_train.py` + `eval/train_laya.py` (see `eval/`); it is not in the repo.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Server (tsx watch) and web (Vite) together |
| `npm test` | Executor tests (vitest + jsdom) and server tests (SSE route against a fake model stream) |
| `npm run typecheck` | `tsc --noEmit` in every workspace |
| `npm run format` | Prettier |
| `npm run objects --workspace web` | Regenerate `web/public/objects/*.svg` from `shared/objects.json` (also runs automatically before dev and build) |

In dev builds, `window.__board.apply(text, actions)` feeds actions through the same path as the model. That's useful for demos and UI testing without an API key.

## Configuration (`.env`)

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Anthropic key; stays server-side |
| `OPENAI_API_KEY` | — | OpenAI key; stays server-side. Set either key (at least one is required for commands) |
| `LLM_PROVIDER` | auto | `anthropic` or `openai`. By default the provider whose key is set is used, Anthropic if both |
| `SYSTEM1_MODEL` | `claude-haiku-4-5` / `gpt-4.1-mini` | Fast-path model (default depends on the provider) |
| `PORT` | `8787` | Server port (Vite proxies `/api` to it) |
| `FASTPATH_URL` | — | Local fast-path sidecar, e.g. `http://127.0.0.1:8788`. Unset = every command goes to the cloud model |
| `FASTPATH_TIMEOUT_MS` | `1000` | How long to wait for the sidecar before using the cloud model |

The sidecar reads its own variables: `LAYA_CHECKPOINT` (unset = rules only), `FASTPATH_PORT` (8788), `FASTPATH_HOST` (127.0.0.1), `FASTPATH_THRESHOLD` (0.8), `FASTPATH_KEEP_WARM_S` (5), `FASTPATH_IDLE_UNLOAD_S` (900; unload the model from the GPU after this many idle seconds, the next command wakes it and is answered by the cloud model; 0 = never), `LAYA_DEVICE`.

## Licenses

Excalidraw (MIT), React (MIT), Fastify (MIT), zod (MIT), lucide-react (ISC), Anthropic SDK (MIT), OpenAI SDK (Apache-2.0). Optional fast path: Laya and its ModernBERT base (Apache-2.0), PyTorch (BSD). Excalidraw's fonts are self-hosted from the npm package (OFL). Object clip-art: Microsoft Fluent Emoji (MIT), see `web/public/objects/LICENSE.md` (generated).
