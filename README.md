# session

Session helper: a whiteboard that draws diagrams from what you say. You describe boxes, arrows, notes or a whole diagram, and they appear on an [Excalidraw](https://github.com/excalidraw/excalidraw) canvas within about a second.

It's built as a "System 1" assistant (the idea behind TypeSafe's Jev). A small, fast model turns each command into **typed board actions** such as `add_shape`, `add_arrow` or `move_element`. The browser validates those actions and applies them as they stream in. The full roadmap is in [docs/PLAN.md](docs/PLAN.md).

**Status: milestone 1 of 5.** You type commands, or speak them with the optional local speech recognition (early milestone 2 work; see [Voice input](#optional-voice-input-local-moonshine-or-cloud)).

## Quick start

Requires Node 22+.

```bash
npm install
cp .env.example .env        # then set ANTHROPIC_API_KEY or OPENAI_API_KEY (or add a key in the app's Settings)
npm run dev                 # server on :8787, web app on http://localhost:5173
```

Try: *"Draw a login flow: user, web app, auth service, database"*, then *"make the database green and move it down"*, then *"undo"*.

It can also draw everyday things: *"let's grab a tree"*, *"draw a man and a child next to the house"*, *"make the tree bigger"*. About 190 hand-picked objects are built in (people, plants, animals, weather, food, buildings, vehicles, office items, symbols; `shared/objects.json`). With object mode `text` the whole Fluent Emoji set, about 1,600 pictures, is available (`shared/objects-more.json`, generated).

Without an API key the app still loads. The status pill shows **API key missing** and commands report a clear error.

### Model settings (in the app)

The gear button next to the status pill opens **Model settings**. They are saved in the browser (localStorage) and override `.env` for every command; anything left on *Default* uses `.env`.

- **Provider**: *Server .env*, Anthropic, OpenAI, Cerebras, xAI, Groq or OpenRouter, or **+ Custom URL** for any other OpenAI-compatible API. Each base URL keeps its own saved key, model, effort and object mode, so switching back and forth keeps them.
- **API key**: per provider. If `.env` already has a key for that endpoint, leave it empty and the server's key is used. The server only sends its `.env` keys to the endpoint `.env` configures them for, never to another URL.
- **Model**: pick from the list (loaded from the provider's `/models` with the refresh button, or automatically the first time) or choose *Other…* to type an id.
- **Reasoning effort**, **Objects** (`enum` / `text`) and **Tools** (`auto` / `all`): the same as `REASONING_EFFORT`, `OBJECT_MODE` and `TOOL_ROUTER` below.
- **Auto-centre view on new items** (On / Off, default On): after a command, the canvas glides so the last item it created or changed sits in the middle of the free screen area (the zoom only drops if the item doesn't fit). Plain code, no model call. Off: the view only moves when something lands out of sight.

Keys typed here are stored in plain text in this browser's localStorage and sent to this app's server with each command. That's fine for a local app; don't use it on a shared machine or a public deployment. On a public server, anyone could also use it to send requests to any URL.

Each cloud command in the activity panel shows which object mode it used (`objects: enum` or `objects: text`).

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
- **Diagrams** (`generate_diagram`): "draw a login flowchart" or "sketch the architecture of a web shop" makes the model send the whole diagram in one call: boxes (decisions as diamonds, start/end as ellipses) and the arrows between them. The layout is computed with [dagre](https://github.com/dagrejs/dagre) (top-down, or left-to-right for pipelines), placed clear of what's already on the board, and built from ordinary shapes and bound arrows, so you can move, recolour or rename any part afterwards. It's one undo step.
- **Objects** (`add_object`): clip-art from [Fluent Emoji](https://github.com/microsoft/fluentui-emoji) (Flat style), from the `@iconify-json/fluent-emoji-flat` package pinned in `web/package.json`. `npm run dev` and `npm run build` write the SVGs to `web/public/objects/` (gitignored), so nothing is fetched at runtime and it works offline once `npm install` has run. To add an object, add a line to `shared/objects.json` (name, Fluent icon name, aliases) and restart `npm run dev`.
- **Motion** (`animate_element`): "the boy walks towards the girl" or "the dog runs away from the cat" plays the move as an animation. The element glides there (pictures bob as if walking), connected arrows follow it, and it stops beside what it walked to. Several motions in one command play in order. Undo puts it back in one step, and typing a new command mid-animation jumps straight to the end.
- **Graphs** (`plot_graph`): "plot y = x^2", "graph sin x and cos x from -2π to 2π" or "y = 2x + 1 from 0 to 5" draws the curves on labelled axes (several per graph, up to 6; "also plot y = x^3 on it" adds one). Equations are parsed by a small built-in parser (no `eval`): `^`, implicit products like `2x` and `3(x+1)`, `|x|`, and functions such as `sin`, `sqrt`, `abs`, `ln`, `log`, `exp`. The y range fits the curves unless you give one, and gaps such as the asymptotes of `tan x` or `1/x` are left open. Only `y = f(x)` can be plotted (no circles or parametric curves).
- **Charts** (`add_chart`): "a pie chart of rent 40%, food 30%, other 30%", "column chart of sales: Q1 10, Q2 15, Q3 12" or "line chart of visitors this week" draws a column, bar, line, area, pie or donut chart, with several series for grouped columns or lines. Without numbers the model makes up example data and says so. You can edit a chart by voice too: "set Q2 to 20", "add April: 14", "remove food", "add a 2025 series: 3, 4, 5" or "make it a pie chart". The model sees each chart's data and redraws it in place with the change, so it keeps its position, size, arrows, title and colours. To edit the data by hand, select a chart and click *Edit data* (or double-click it, or press Enter): a table of labels and values opens with the chart kind, title, unit and colours and a live preview. You can add rows and series, paste cells straight from a spreadsheet, press Enter to move down a row and Ctrl+Enter to apply. Applying redraws the chart in place and is one undo step.
- **Hover readouts**: move the mouse over a graph to see a crosshair, the x under the pointer and every curve's y there. Over a chart you get the value of the bar, point or slice under the pointer (and its share for pies). A graph or chart is one picture on the board, so you can move, resize, connect, recolour ("make the graph red": its first curve/series) or retitle it like anything else.
- **Scrolling** (`scroll_view`): "scroll down", "pan left a bit", "scroll down a page", "go to the database", "back to the top" or "show everything" glides the view there. It only moves the camera, so it adds no undo step. With the local fast path these are answered by rules; anything they don't cover goes to the cloud model.
- **Zooming** (`zoom_view`): "zoom in", "zoom out a bit", "zoom to 150%", "set the zoom to 2x", "reset the zoom" or "zoom in on the database" glides to that zoom level (10% to 3000%), keeping the middle of the screen in place or centring the named element. Like scrolling, it adds no undo step, and the local rules answer the common phrasings.
- The model gets a compact text summary of the scene (ids, labels, positions, selection, recently touched elements), so references like "it", "the database" or "that box" resolve.

### Optional: local fast path (rules + Laya)

Simple commands can be settled locally instead of by the cloud LLM, with no API cost. `fastpath/server.py` is a sidecar with three tiers; when `FASTPATH_URL` is set, the server asks it first:

1. **Rules** (code, under 1 ms, no GPU): commands that follow a small fixed grammar, where every word has to be accounted for. These cover undo and clear; delete, recolor, resize and move of a named element ("make the API red", "nudge it a bit left", "delete all the notes"); new shapes with an optional colour, size, region and label ("add a pink sticky saying call the bank"); titles and captions ("add a title that says Q3 plan"); renames ("rename the cache to Redis"); arrows ("connect the API to the cache"); clip-art ("draw a tree"); simple motion ("the boy walks towards the girl"); and simple measurements ("the tree is 10 ft tall"). Any leftover word, second clause or unclear reference passes the command on.
2. **Laya** (optional, about 0.2 s on a 4 GB laptop GPU): a fine-tuned [Laya](https://huggingface.co/convaiinnovations/laya) checkpoint (Apache 2.0) handles what the rules can't parse. It drops chatter ("can everyone see my screen"), handles synonyms and paraphrases ("delete the database" when the box is labelled Postgres), and checks casual object commands ("let's grab a tree" vs. "let's grab a coffee").
3. **Cloud**: anything else (several changes, motion the rules can't parse (Laya can't animate yet), placement next to other elements, generating diagrams (the rules send any command with a diagram word like "flowchart" or "architecture" there), graphs and charts (any command with "graph", "plot", "chart", "equation" or a `y =`, or naming a category or series of a chart on the board), low confidence) goes to the cloud model. So does every command when the sidecar is down or slower than `FASTPATH_TIMEOUT_MS`.

Local actions are validated with the same zod schemas and streamed to the board. Each command in the activity panel (right side; collapse it with its header button) shows a **Local** or **Cloud** badge with the reason, for example "Handled locally (rule: recolor)" or "Sent to the cloud (local model passed: several changes)". The status pill reads "System 1 · Haiku 4.5 + local" when the fast path is on.

Run it. Without a checkpoint the sidecar runs the rules only and needs plain Python 3.10+. With Laya it also needs CUDA PyTorch (see `fastpath/requirements.txt`):

```
python fastpath/server.py                                            # rules only
LAYA_CHECKPOINT=/path/to/laya-checkpoint python fastpath/server.py   # rules + Laya; listens on 127.0.0.1:8788
FASTPATH_URL=http://127.0.0.1:8788 npm run dev
```

The checkpoint is produced by `eval/make_train.py` + `eval/train_laya.py` (see `eval/`); it is not in the repo.

### Optional: voice input (local Moonshine or cloud)

The mic button in the command bar streams your microphone to `stt/server.py`, which runs [Moonshine](https://github.com/moonshine-ai/moonshine) speech recognition on the CPU. Nothing leaves the machine, there is no per-hour cost and it uses no GPU memory. While you talk, the words being recognised show in the command bar. When you pause, the finished sentence runs as a command, exactly as if you had typed it. If you pause mid-command, after a word like "and", "with", "to", "the" or "labelled", the app waits about 1.5 seconds for the rest (the command bar shows the sentence with "…") and joins the two parts into one command. If you don't carry on, the part you said runs as it is. Both waits are under *Join a command split by a pause* in Settings: *Wait for the rest* (default 1,500 ms; 0 turns joining off) and *Wait while still speaking* (default 8,000 ms, the limit once you've carried on). They apply the next time the mic starts, with no server restart. Sentences spoken while a command is still running wait their turn instead of cancelling it. Labels on the board (such as "Postgres") are passed to the recogniser so it spells them the way the board does.

Set it up once, in its own Python 3.10+ environment (no PyTorch needed):

```
uv venv .venv-stt                     # or: python -m venv .venv-stt
uv pip install --python .venv-stt -r stt/requirements.txt
.venv-stt/Scripts/python stt/server.py    # listens on 127.0.0.1:8789; downloads the model (~140 MB) on first start
```

Then run `npm run dev` as usual. Vite forwards `/stt` to port 8789. Click the mic, allow microphone access and say a command. Click the mic again to stop; whatever you were saying still finishes and runs. After 30 seconds with nothing recognised, listening pauses: the mic button dims and the speech service is disconnected, but the browser keeps the mic open and checks how loud it is. As soon as you start speaking it reconnects and sends the last 2 seconds of audio first, so the words that woke it still count. Set the delay (5 s to 30 s, or Never) and how loud speech must be to wake it under *Pause listening after silence* and *Wake sensitivity* in Settings. With the *Browser* provider the first word after a pause can be lost, because its recognition can't be given the earlier audio.

- `STT_MODEL=small` (default): text arrives about 0.5–0.8 s after you stop talking. It uses about half a CPU core and 310 MB of RAM (Ryzen 7 4800H). `medium` is a little more accurate but slower: 0.8–1.2 s, about 0.8 core and 500 MB.
- Other variables: `STT_PORT` (8789; Vite's proxy expects 8789), `STT_HOST` (127.0.0.1), `MOONSHINE_VOICE_CACHE` (where models are kept).
- It doesn't yet tell your voice apart from other people's: anything the mic hears clearly can run as a command. A headset helps.
- One tab listens at a time. Starting the mic in another tab stops it in the first.

**Cloud instead (Deepgram or AssemblyAI).** No sidecar or Python needed: the API server relays the mic to the service. Pick the provider under *Speech to text* in Settings (the gear next to the status pill) and paste a key there, or set them in `.env`:

```
STT_PROVIDER=deepgram            # moonshine (default) | deepgram | assemblyai | browser
DEEPGRAM_API_KEY=...             # or ASSEMBLYAI_API_KEY=...
# DEEPGRAM_MODEL=nova-3   ASSEMBLYAI_MODEL=universal-streaming-english
```

The Settings choice overrides `STT_PROVIDER` for that browser and applies the next time the mic starts. A `.env` key is only sent to its own service. Board labels are passed as key terms to both services. Deepgram takes them only when the mic starts; AssemblyAI is updated as the board changes. Audio goes to the service you pick, and it is billed by the minute while it is connected, which stops when listening pauses.

With AssemblyAI, *AssemblyAI turn detection* in Settings sets when a pause ends a command: the end-of-turn confidence (0-1, default 0.4), the silence needed when the model is confident (default 400 ms) and the longest silence allowed (default 1280 ms). Leave a field empty to use AssemblyAI's default. If commands get cut in half when you pause mid-sentence, raise the minimum silence to around 700-800 ms. Every command then arrives that much later.

**Browser.** The *Browser* choice uses the browser's own speech recognition (the Web Speech API). It needs no key, no sidecar and no server. It works in Chrome, Edge and Safari, but not Firefox, and Brave has no speech service. Chrome sends the audio to Google and Edge to Microsoft. It ignores board key terms. Browsers end recognition after a pause, so it restarts on its own, and a word spoken right at a restart can be lost.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Server (tsx watch) and web (Vite) together |
| `npm test` | Executor tests (vitest + jsdom) and server tests (SSE route against a fake model stream) |
| `npm run typecheck` | `tsc --noEmit` in every workspace |
| `npm run format` | Prettier |
| `npm run objects --workspace web` | Regenerate `shared/objects-more.json` and `web/public/objects/*.svg` from `shared/objects.json` and the icon package (also runs automatically before dev and build) |

In dev builds, `window.__board.apply(text, actions)` feeds actions through the same path as the model. That's useful for demos and UI testing without an API key.

## Configuration (`.env`)

The in-app Model settings (above) override these per browser.

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Anthropic key; stays server-side |
| `OPENAI_API_KEY` | — | OpenAI key; stays server-side. Set either key (at least one is required for commands) |
| `OPENAI_BASE_URL` | OpenAI | Use another OpenAI-compatible API, e.g. `https://api.cerebras.ai/v1` (put that service's key in `OPENAI_API_KEY`, set `LLM_PROVIDER=openai` and `SYSTEM1_MODEL` to one of its model ids) |
| `LLM_PROVIDER` | auto | `anthropic` or `openai`. By default the provider whose key is set is used, Anthropic if both |
| `REASONING_EFFORT` | `low` | `low`, `medium`, `high` or `off`. Sent as `reasoning_effort` (OpenAI-compatible, e.g. gpt-oss/gpt-5/o-series/Cerebras qwen-3.8; `off` is sent as `none` to Qwen, nothing to the others) or `output_config.effort` (newer Claude models); ignored for models that don't support it (gpt-4.1-mini, Haiku 4.5) |
| `OBJECT_MODE` | `enum` | How the model names clip-art. `enum`: the `add_object` tool lists the ~190 curated objects, and the model picks one. `text`: the model writes a plain word ("puppy", "red sports car"), the server maps it to the curated objects or the rest of the icon set, about 1,600 pictures in all (names, aliases, plurals, the last word, one-letter typos), and draws a labelled box when nothing fits. `text` sends about 1,800 fewer characters per request. Known miss: the last-word rule can pick another sense ("cricket bat" draws the animal). |
| `TOOL_ROUTER` | `auto` | Which tools each cloud request carries. `auto`: the core tools (shapes, text, arrows, move, edit, delete, undo, clear) plus only the extra groups the command's words and the board call for (diagram, objects, measurements, motion, graphs, charts, scrolling/zooming), with only those groups' prompt instructions: about 8k characters for a plain command instead of about 26k. The pick is plain code (keywords), shown in the activity log as "tools: core+chart". A missed word means the model draws a labelled box instead; say it differently or switch to `all`. `all`: every tool, every time. Helps with free tiers whose per-request token limit is smaller than the full tool list (Groq answers 413). |
| `SYSTEM1_MAX_TURNS` | `6` | OpenAI-compatible providers only. Some models (gpt-oss on Cerebras) make one tool call per request, so a command like "draw a tree and a flower" gets extra requests, one per step. Lower it, or set `1`, if you hit a requests-per-minute limit (Cerebras free tier). |
| `SYSTEM1_MODEL` | `claude-haiku-4-5` / `gpt-4.1-mini` | Fast-path model (default depends on the provider) |
| `PORT` | `8787` | Server port (Vite proxies `/api` to it) |
| `FASTPATH_URL` | — | Local fast-path sidecar, e.g. `http://127.0.0.1:8788`. Unset = every command goes to the cloud model |
| `FASTPATH_TIMEOUT_MS` | `1000` | How long to wait for the sidecar before using the cloud model |

The sidecar reads its own variables: `LAYA_CHECKPOINT` (unset = rules only), `FASTPATH_PORT` (8788), `FASTPATH_HOST` (127.0.0.1), `FASTPATH_THRESHOLD` (0.8), `FASTPATH_KEEP_WARM_S` (5), `FASTPATH_IDLE_UNLOAD_S` (900; unload the model from the GPU after this many idle seconds, the next command wakes it and is answered by the cloud model; 0 = never), `LAYA_DEVICE`.

## Licenses

Excalidraw (MIT), React (MIT), Fastify (MIT), zod (MIT), lucide-react (ISC), Anthropic SDK (MIT), OpenAI SDK (Apache-2.0). Optional fast path: Laya and its ModernBERT base (Apache-2.0), PyTorch (BSD). Optional voice input: Moonshine `moonshine-voice` and its English streaming models (MIT), websockets (BSD-3-Clause), NumPy (BSD); cloud speech relay: ws (MIT). Excalidraw's fonts are self-hosted from the npm package (OFL). Object clip-art: Microsoft Fluent Emoji (MIT), see `web/public/objects/LICENSE.md` (generated).
