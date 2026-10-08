# CLAUDE.md

Guidance for Claude Code when working in this repo. **Read this first; it is meant to replace re-exploring the project.**

## Keeping this file current (required)

This file is only useful if it is accurate. **With every change you make, update CLAUDE.md in the same change** if it affects anything recorded here:

- files/modules added, removed, renamed or repurposed (update the Layout and Key files sections)
- board actions added/changed in `shared/src/actions.ts` (update the Action vocabulary section)
- new/changed env vars, scripts, ports, providers, models or dependencies
- changes to the request flow, SSE event types, or architecture decisions
- new gotchas you hit, or a convention that changed
- milestone progress (update Status)

Keep entries short and factual; fix or delete anything that is now wrong rather than appending. Do not describe code that can be read at a glance. Record only what saves a future session from re-deriving it. README.md is the user-facing doc; keep it in sync for user-visible changes too.

## What this is

**voice-board**: a whiteboard that draws from natural-language commands. A small, fast LLM ("System 1") turns each command into **typed board actions** (`add_shape`, `add_arrow`, `move_element`, ...). The server streams them over SSE; the browser validates and applies them to an [Excalidraw](https://github.com/excalidraw/excalidraw) canvas as they arrive.

**Status: milestone 1 of 5** (typed text commands only), plus an optional local fast path (fine-tuned Laya sidecar, early M4 work). Voice input (Deepgram streaming, VAD, push-to-talk) is M2; diagram generation/images M3; noise/intent filtering and a fine-tuned router M4; persistence/auth/export M5. Roadmap, rationale and licence notes are in [docs/PLAN.md](docs/PLAN.md) (a planning doc, partly unverified; not a spec of current code).

## Stack

- npm workspaces monorepo (`shared`, `server`, `web`), TypeScript (strict, ESM, `moduleResolution: Bundler`), Node 22+.
- **server**: Fastify 5, `@anthropic-ai/sdk`, `openai`, zod 4. Run with `tsx`.
- **web**: React 18, Vite, `@excalidraw/excalidraw` 0.18, lucide-react. Tests: vitest + jsdom.
- **shared**: zod schemas + protocol types, consumed as TS source (`main`/`types` point at `src/index.ts`; no build step).
- Prettier: `printWidth: 140`.

## Commands (run from repo root)

| Command | Purpose |
|---|---|
| `npm install` | Install all workspaces |
| `npm run dev` | Server (`tsx watch`, :8787) + web (Vite, :5173; proxies `/api` to :8787) |
| `npm test` | vitest in `server` and `web` (`shared` has no tests) |
| `npm run typecheck` | `tsc --noEmit` in every workspace |
| `npm run format` / `format:check` | Prettier over `{shared,server,web}/src` |
| `npm run build --workspace web` | Production web build (prebuild copies fonts) |
| `npm run start --workspace server` | Run server without watch |

Single test file: `npx vitest run <path>` from inside `server/` or `web/`.

Setup: `cp .env.example .env` and set an API key. The server loads `../.env` via `--env-file-if-exists`. Without a key the app still starts; `/api/health` reports `hasKey: false` and the UI shows "API key missing".

### Env vars (server-side only)

`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (set at least one), `LLM_PROVIDER` (`anthropic`|`openai`; otherwise whichever key is set, Anthropic if both; any other value throws at startup), `SYSTEM1_MODEL` (defaults: `claude-haiku-4-5` / `gpt-4.1-mini`), `PORT` (8787), `LOG_LEVEL` (Fastify logger, default `info`), `FASTPATH_URL` (local Laya sidecar; unset = cloud only), `FASTPATH_TIMEOUT_MS` (1000). The sidecar has its own: `LAYA_CHECKPOINT` (required), `FASTPATH_PORT` (8788), `FASTPATH_HOST`, `FASTPATH_THRESHOLD` (0.8), `FASTPATH_KEEP_WARM_S` (5), `LAYA_DEVICE`.

## Architecture / request flow

```
web: CommandDock -> useCommandRunner.run -> summarize(scene) -> POST /api/command {text, scene}
server: app.ts validates body (zod) -> provider.run -> [withFastPath: POST sidecar /decide; fast/ignore answered locally]
        -> ONE streaming model call (tools only, no tool-result round trip)
        each completed tool call -> parseAction (zod) -> SSE `data: {CommandEvent}`
web: streamCommand parses SSE -> consume() -> executor.applyAction -> api.updateScene (one undo snapshot per command)
```

- The **zod schemas in `shared/src/actions.ts` are the single source of truth**: they generate the model tool definitions (`z.toJSONSchema(..., { io: "input" })`) and validate every incoming tool call. Never hand-write tool JSON; change the schema.
- **SSE events** (`shared/src/protocol.ts` `CommandEvent`): `route {source: local|cloud, model, detail, ms}` (always first: who decided and why; shown as the Local/Cloud badge in the activity panel), `action {action, ms}`, `say {text}`, `invalid {name, error}`, `error {message}`, `done {ms, model, actions}`.
- **Barge-in**: a new command aborts the in-flight fetch; the server aborts the model call on `res` close. Cancelled runs are marked `cancelled`.
- **Scene summary** (`web/src/board/summary.ts` -> `server/src/prompt.ts#formatScene`): compact text of ids, labels, positions, colour, selection, `recentIds` (newest first) so "it"/"that"/"the database" resolve. Capped at 500 elements / 100 selected / 50 recent by the server's body schema.
- **Prompt caching**: `SYSTEM_PROMPT` must stay byte-stable across requests (Anthropic path caches system + tools; the last tool carries `cache_control`). Don't interpolate per-request data into it; per-request data goes in `buildUserMessage`.
- **Providers** (`server/src/provider.ts`): `Provider { name, model, hasKey, run, describeError }`. `providerFromEnv()` picks the backend. `system1.ts` (Anthropic: `messages.stream`, `eager_input_streaming`, `contentBlock` events) and `system1-openai.ts` (OpenAI: chat completions streaming; tool-call deltas stitched per `index`, flushed when the next call starts or the stream ends). `OPENAI_TOOLS` is derived from the Anthropic `TOOLS`, so both share one schema.
- **Local fast path** (optional, `server/src/fastpath.ts` + `fastpath/`): `withFastPath(provider, fast)` wraps a provider (sets `fastPath: true`, reported by `/api/health`). It POSTs `{text, scene}` to the Python sidecar; `fast` actions are re-validated with `parseAction` and streamed (`done.model` = `laya:<checkpoint>`), `ignore` ends with 0 actions, and `llm`, a sidecar error/timeout or any invalid action falls through to the provider. Without a fast path, `app.ts` emits `route {source: "cloud"}` itself. The sidecar (`fastpath/server.py`, stdlib HTTP, one model behind a lock) runs Laya, then `resolve_target` and `route_why` from `fastpath/decide.py`, the same decision code the eval harness uses.

## Layout and key files

```
shared/src/actions.ts     Action zod schemas, ACTION_SCHEMAS/DESCRIPTIONS, BoardAction type, parseAction()
shared/src/protocol.ts    CommandRequest, SceneSummary, CommandEvent
server/src/index.ts       Entry: providerFromEnv() -> buildApp() -> listen 0.0.0.0:$PORT
server/src/app.ts         Fastify app: GET /api/health, POST /api/command (SSE via reply.hijack())
server/src/provider.ts    Provider interface, anthropicProvider/openaiProvider, providerFromEnv, error mapping
server/src/system1.ts     Anthropic streaming run + TOOLS + blockToEvents (exported for tests)
server/src/system1-openai.ts  OpenAI streaming run + OPENAI_TOOLS + toolCallToEvent
server/src/fastpath.ts    withFastPath (local-first provider wrapper), httpFastPath client, fastPathFromEnv
server/src/prompt.ts      SYSTEM_PROMPT, formatScene, buildUserMessage
server/src/server.test.ts Fake SDK streams; covers tools, SSE route, both providers, providerFromEnv
web/src/App.tsx           Excalidraw host, health polling (15s), localStorage autosave, theme, dev hook
web/src/api.ts            checkHealth, streamCommand (SSE parser)
web/src/board/executor.ts applyAction(): pure scene mutation per action; resolve(), place(), translate(), rerouteArrows()
web/src/board/geometry.ts Placement math: besides, regionPoint, findFreeSpot, connector/edgePoint, GAP
web/src/board/style.ts    PALETTE (named colours), sizes, NUDGE, fitLabel, FONT (Nunito), ROUGHNESS 0
web/src/board/summary.ts  summarize() scene -> SceneSummary, visibleArea()
web/src/board/useCommandRunner.ts  Streams events, applies actions, undo history, log, revealIfHidden zoom/scroll
web/src/components/       CommandDock (input, suggestions, `/` hotkey), ActivityPanel (collapsible right-side log, newest first; open state in localStorage `voice-board:activity-open`), StatusPill
web/src/board/executor.test.ts  Executor tests; web/src/test-setup.ts stubs canvas/FontFace for jsdom
web/scripts/copy-fonts.mjs  Copies Excalidraw fonts to web/public/fonts (gitignored) on predev/prebuild
fastpath/decide.py        Decision logic shared by sidecar and eval: questions, target/group rules, route/route_why, compose
fastpath/server.py        Laya sidecar: POST /decide, GET /health; id aliasing, keep-warm
eval/                     Python harness (not part of the app) testing self-hosted decision models as a System 1 fast path; make_train.py + train_laya.py fine-tune Laya
```

### eval/ (decision-model experiments, M4 groundwork)

- `samples.jsonl` (50 commands + expected answers) and `scenes.json` (4 SceneSummary-shaped boards) are shared test data. The questions, target rules, router (`ignore` / `fast` / `llm`) and action composition live in `fastpath/decide.py` (re-exported by `laya_eval.py`, which holds the run loop and report); `semif_eval.py` reuses them with SemIf.
- Setup notes are in each script's docstring. Gotchas: build the venv from `C:\Program Files\Python310` (Miniconda's Python breaks torch); SemIf is cloned to `eval/.semif` and put on `sys.path`, not pip-installed (it pins torch 2.10); llama-cpp-python must be built from source with CUDA (Ninja inside vcvars64, Miniconda off PATH or CMake picks its partial CUDA 11.6).
- `samples.jsonl` is the dev set; the question wording was diagnosed on it. `samples_heldout.jsonl` (33 commands, adds the `flow` scene) is the honest check. `samples_sets.jsonl` (18) tests group commands. An expected `target` can be an id, a list of ids (a group) or `"several"`. Results go to `eval/results/`, named by model, layout and sample set. `results/v1/` holds the runs made with the original multi_step wording.
- Results (RTX 3050 4 GB, zero-shot, current v2 question wording unless noted). "Done without LLM" means simple commands the decision model handled correctly on its own:

  | Model | Dev: done without LLM (of 33) / wrong | Held-out (of 24) / wrong | Per command | GPU |
  |---|---|---|---|---|
  | Laya english (v1 wording) | 11 / 1 at 0.5 | 9 / 1 at 0.5 | 185 ms | 2.4 GB |
  | SemIf MiniCPM5-2B Q4 (v1) | 0 | - | 0.8 s | 1.6 GB |
  | SemIf Qwen3.5-2B Q4 (v1) | 0 | - | 0.54 s | 1.4 GB |
  | SemIf Qwen3.5-4B Q4, command-first | 13 / 0 at 0.6 | 14 / 1 at 0.6, 12 / 0 at 0.7 | 1.2 s | 3.0 GB |
  | same, `--layout question-first` | 10 / 1 at 0.6 | 8 / 1 at 0.6 | 0.48 s | 3.1 GB |
  | SemIf Qwen3.5-4B, command-first, `--target-rules` (of 34 / 25) | 22 / 0 at 0.6 | 20 / 0 at 0.6, 17 / 0 at 0.7 | 1.2 s | 3.0 GB |
  | same, question-first, `--target-rules` | 17 / 1 at 0.6 | 16 / 1 at 0.6 | 0.48 s | 3.1 GB |
  | Laya english, `--target-rules` | 13 / 2 at 0.5 | 7 / 2 at 0.5 | 185 ms | 2.4 GB |

  | Laya english fine-tuned, heads only, `--target-rules` | 21 / 2 at 0.6 | 18 / 3 at 0.6 | 190 ms | 2.4 GB |
  | Laya english fine-tuned, heads + top 6 layers, `--target-rules` | 31 / 2 at 0.6, 28 / 0 at 0.8 | 20 / 0 at 0.6, 17 / 0 at 0.8 | 180 ms | 2.4 GB |

  With `--target-rules`, "all the notes" commands count as fast-eligible, so dev has 34 and held-out 25. On `samples_sets.jsonl` (18 group commands, written before the code), both SemIf orders handled 10 of the 10 simple groups with 0 wrong and sent all 7 that need the LLM to it; Laya applied 1 wrong.

  - The 2B models answer by option position, not meaning, so 4B is the minimum.
  - Question-first (cached prefixes) is about 2.5x faster in same-session timing; GPU speed varies run to run. It's better at action and target but routes fewer commands to the fast path. Its wrong actions are resize commands read as add_shape ("make the X box small/big").
  - Rewording multi_step from v1 to v2 (count the changes) fixed its question-first collapse (55% to 97% on held-out) and helped command-first too. But "make all the notes green" now slips through as a single update.
  - Target selection is the weak spot for every model, so `--target-rules` (`resolve_target` in `laya_eval.py`) picks it in code when the command names it: whole label, distinctive label word, unique element type, or it/this/that (selected, else most recent). Anything that could mean several elements is left to the model. The rules were 41/41 right where they fired; the models were right on 24-29 of those. The model's own target is kept per row as `model_target`. Remaining misses are action and needs_text (e.g. "make the title medium sized" reads as new text).
  - Groups (`resolve_set`): "all/every/each/both", plural type words ("the boxes") or "everything" resolve to a sorted id list. A colour before the type word filters it ("the yellow notes"). `compose` then returns one `delete_elements`, or one update/move per element (`compose` always returns a list of actions). A resolved group skips the multi_step gate. Groups with a condition or second clause ("and", "except", "on the right", "called"...), mixed types, no matches, or "both" without exactly two resolve to `SEVERAL`, which allows only undo/clear on the fast path. Risk: an action error now hits every element in the group; Laya turned "rename all the notes to done" into deleting all three. A higher action threshold for groups may be worth it.
  - `expected_route` is now `route()` over the expected answers, so the policy lives in one place.
  - Cached and uncached scores differ by up to 0.08, which is llama.cpp numerical noise.
- Fine-tuning Laya: `make_train.py` generates synthetic `{state, questions, expected}` rows (random boards with labels from no eval scene, templated commands for every category plus fillers and self-corrections; exact eval texts dropped; group/multi/arrow targets left unlabelled). `train_laya.py` runs `laya.train.finetune` (`--freeze-encoder` or `--unfreeze-top N`); `laya_eval.py --checkpoint DIR` evaluates the result. Data and checkpoints live in `F:/temp/laya-train/` (8,000 rows = 67k question items).
  - Gotchas: laya 0.4.0's `finetune` scores the base model before moving it to CUDA and crashes; `train_laya.py` moves it at load. Full fine-tuning (Laya's own recipe: all layers, 4 epochs) needs ~7 GB, so on 4 GB train the top 6 layers (3.3 GB, ~0.5-0.7 s/step at micro-batch 8, 70-85 min per epoch; the laptop GPU throttles).
  - Top-6, 1 epoch at 0.6 still applies "rename all the notes to done" as delete-all (sets) and misses needs_text on "add a sticky note saying X" (dev). At 0.8 it applied 0 wrong on all three sets. The templates were written after seeing dev and held-out failures (e.g. "X, sorry, I mean Y"), so both sets are optimistic for the fine-tuned models; a fresh test set is needed.

### Action vocabulary (8 actions)

`add_shape` (rectangle/ellipse/diamond/sticky), `add_text` (title/heading/body/caption), `add_arrow`, `move_element`, `update_element`, `delete_elements`, `undo_last_command`, `clear_board`. Placement is semantic (`relative_to`+`side`, `region`, or absolute `x`/`y`) rather than raw coordinates because LLM spatial reasoning is weak.

**Adding or changing an action touches:** `shared/src/actions.ts` (schema + description) -> `web/src/board/executor.ts` (`applyAction` switch) -> `server/src/prompt.ts` if the model needs guidance -> tests (`server.test.ts` asserts the exact ordered tool-name list; executor tests) -> this file.

## Conventions and gotchas

- **Element ids**: the model assigns short slug ids to new elements so later calls in the same turn can reference them. If a wanted id is taken, `allocateId` suffixes `-2` etc. and records it in `ctx.idMap`; always resolve refs through `resolve()` (id -> alias -> unique case-insensitive label match; else `ActionError`).
- **Top-level elements**: bound text labels (`containerId` set) are hidden from the model/summary via `isTopLevel`; read labels with `labelOf()`.
- **Shapes** store `customData.kind` (needed to tell `sticky` apart from `rectangle`). Updating a shape *rebuilds* it via `convertToExcalidrawElements` (keeps id/position/arrow bindings, bumps `version`) so labels re-wrap.
- **Arrows** are created with bindings to both ends (`startBinding`/`endBinding`, `boundElements` on the shapes) and are re-routed by `rerouteArrows` whenever a bound shape moves. They can't be moved directly.
- `executor.ts` is **pure** (returns new arrays); `undo_last_command` is handled in `useCommandRunner`, not the executor (it throws if it reaches it).
- **Undo** = scene snapshot per command that changed the board (max 50), restored by bumping versions via `updateScene` with `CaptureUpdateAction.IMMEDIATELY`.
- AI-drawn elements use Nunito and `roughness: 0`; the palette is the named-colour map in `style.ts` (`COLORS` in `shared` must match its keys).
- Excalidraw needs `process.env.IS_PREACT = "false"` (set in `vite.config.ts`) and vitest inlines `@excalidraw`/`roughjs` deps. Tests set a fake text-metrics provider because jsdom has no canvas.
- Board autosaves to `localStorage` key `voice-board:scene:v1` (400ms debounce).
- **Dev-only hook**: `window.__board.apply(text, actions)` runs actions through the same path as the model, so UI can be exercised without an API key.
- `StatusPill` exports `modelName()`: friendly names for Anthropic ids (`MODEL_NAMES`) and `laya:*` ("Laya"); other models, including OpenAI ones, show their raw id.
- Fast-path sidecar gotchas: Excalidraw ids are random 20-char strings Laya never saw, so `/decide` aliases them to `e1, e2, ...` and maps actions back. With more than 10 elements the target question is dropped (Laya's head budget) and only the code rules pick targets. A laptop GPU clocks down when idle: a decision takes ~0.2 s back to back but ~0.4 s after a pause and 1.3 s after minutes idle; `FASTPATH_KEEP_WARM_S` removes the 1.3 s case. A command over 30 words skips the model (`llm`).
- Root `dev` script uses `a & b`. On Windows npm runs scripts through `cmd.exe`, where `&` is sequential, so if the web app doesn't start run `npm run dev --workspace server` and `npm run dev --workspace web` in separate terminals. (Not verified on this machine.)
- Server tests never hit a real API: they pass fake SDK clients into `anthropicProvider`/`openaiProvider`.

## Testing notes

- `server/src/server.test.ts`: fake Anthropic `messages.stream` and fake OpenAI async-iterable stream; drives `app.inject` and parses the SSE body. Fast-path tests use fake `FastPath` functions plus a throwaway Fastify app as the HTTP sidecar. The Python sidecar has no automated tests; `eval/laya_eval.py` exercises its decision code.
- `web/src/board/executor.test.ts`: runs action sequences through `applyAction` and asserts on resulting Excalidraw elements.
- No tests yet for `useCommandRunner`, `App`, `CommandDock`, `ActivityPanel`, `api.ts` or `geometry.ts` directly.
- After changes run `npm run typecheck && npm test`.
