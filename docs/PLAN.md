# Voice-Driven AI Whiteboard — Project Plan

## Context
Build a whiteboard where the user speaks and the AI draws diagrams, adds/moves images, and places text in near-real-time. "System 1" = fast, reflexive, low-latency (sub-~1.5s to first stroke) via streaming small-model tool calls; a slower "System 2" planner is used only for complex layouts. The repo (`techxapp/session`) is empty (README only), so this is greenfield.

**What Jev is (from search results; datacamp.com itself was blocked here):** TypeSafe's Jev is a "System 1" model — a small, fast model that returns *typed decisions* (classification/routing/structured choices with probabilities) from text, instead of generating free text. Our version: the speech transcript goes to a System 1 model that instantly decides intent + typed args (e.g. `add_shape{kind:box,label}`, `move{target,dir}`, `ignore`), and only escalates to a generative LLM (System 2) when the request is open-ended ("draw a CI/CD pipeline").
Open Jev-style alternatives reported in search results (all unverified by me — check license, model size, and actual repo before adopting): **Kev** (Apache-2.0, 0.8B/4B/9B Qwen3.5-based checkpoints, trainable on own data), **Laya** (322M–421M, multilingual, fast local routing), **Nimble** (Bespoke Labs, typed decisions from text), **SemIf/OpenJev/mini-jev** (reads option probabilities from open LLMs, no training). Caveat: base models (e.g. Qwen) carry their own licenses; confirm commercial terms.
Pragmatic path: start System 1 = small hosted LLM (Haiku-class) with constrained tool-calling; once we have logged voice commands, fine-tune Kev/Laya-style model on our own action schema for <100ms routing, keeping the LLM as fallback.
All other license facts below are from memory — verify before committing.

## 1. Open-source with commercial-friendly license
| Need | Pick | License | Notes |
|---|---|---|---|
| Whiteboard canvas (recommended) | **Excalidraw** (`@excalidraw/excalidraw`) | MIT | Imperative API (`updateScene`, `scrollToContent`), JSON element format that LLMs generate well, hand-drawn look, image support. Best fit for MVP. |
| Alternative canvas | **tldraw** | Custom (NOT MIT) | Best SDK/agent ergonomics, but production/commercial use needs a paid license key. Choose only if budget allows. |
| Diagram DSL | **Mermaid** | MIT | LLM -> Mermaid -> convert to Excalidraw elements (`@excalidraw/mermaid-to-excalidraw`). Good for flowcharts/sequence. |
| Auto-layout | **ELK.js** (EPL-2.0) or **dagre** (MIT) | | LLM outputs graph (nodes/edges), we compute positions — avoids bad coordinates. |
| Low-level alt | Konva / Fabric.js / React Flow | MIT | If building custom canvas instead. |
| Real-time collab (later) | **Yjs** | MIT | |
| Voice pipeline framework | **LiveKit Agents** (Apache-2.0) or **Pipecat** (BSD-2) | | Handles streaming audio, VAD, barge-in. |

Recommendation: **Excalidraw + Mermaid + ELK/dagre**, all permissive.

## 2. Tech stack
- **Frontend**: React + TypeScript + Vite, Excalidraw embedded, Zustand for state, WebRTC/WebSocket for audio.
- **Backend**: Node (TypeScript, Fastify) or Python (FastAPI) — pick Python if self-hosting STT/models, Node if staying API-based. WebSocket gateway.
- **LLM (System 1)**: small/fast model with streaming tool-calling (e.g. Claude Haiku 4.5, or similar). Tools: `add_shape`, `add_text`, `add_arrow(from,to)`, `move(id,x,y)`, `resize`, `delete`, `add_image(query|url)`, `generate_diagram(mermaid)`, `group`, `undo`.
- **LLM (System 2)**: larger model (Sonnet-class) for "draw the architecture of X" — returns a graph/Mermaid, laid out by ELK.
- **Images**: Unsplash/Pexels API or generated image API; user uploads -> S3-compatible storage. Reference by id for "move that picture".
- **Storage/auth**: Postgres (scenes as JSON), Redis (session state), S3 for images; Clerk/Auth.js for auth.
- **Infra**: Docker, Fly.io/Railway/AWS; GPU box only if self-hosting Whisper.

## 3. Speech-to-text and noise handling
Pipeline: Mic (browser `getUserMedia` w/ echoCancellation + noiseSuppression + autoGainControl) -> optional denoise -> VAD -> streaming STT -> intent filter -> LLM.

**STT options**
- Managed (fastest to ship, best streaming latency): **Deepgram Nova-3**, **AssemblyAI Universal-Streaming**, Google/Azure STT. Commercial, pay-per-minute, built-in endpointing and keyterm boosting.
- Self-hosted (MIT/Apache): **faster-whisper** / **whisper.cpp** (MIT; use `large-v3-turbo` or `distil`), **Vosk** (Apache-2.0, lightweight), **Moonshine** (MIT, very low latency edge). NVIDIA Parakeet is CC-BY-4.0 (attribution OK commercially).
- Recommendation: MVP on Deepgram streaming; keep an STT interface so faster-whisper can be swapped in for cost/privacy.

**Noise / filtering**
1. Browser built-ins (echo cancel, NS, AGC) — free, do first.
2. **RNNoise** (BSD-3) in WASM, or **DeepFilterNet** (MIT/Apache) server-side, for heavy background noise. (Krisp is commercial.)
3. **Silero VAD** (MIT) to cut non-speech and detect end-of-utterance; avoids Whisper hallucinating on silence.
4. **Transcript filtering** (the "filtering noise from text" part):
   - Drop low-confidence segments and known Whisper hallucinations ("Thanks for watching").
   - Strip fillers (um, uh), merge restarts/self-corrections ("no, make it blue").
   - **Intent gate**: cheap classifier/LLM check — is this a drawing command or side-talk? Ignore chatter; optional wake word / push-to-talk / "hey board" for noisy rooms.
   - Domain vocabulary boosting (shape names, "arrow", "swimlane").
5. Use partial (interim) transcripts to start speculative LLM calls; commit on final.

## 4. Architecture (System 1 / System 2)
1. Client streams audio -> STT -> final/interim text.
2. **Router (the System 1 model)**: emits typed decision {intent, confidence, args}; low confidence or `complex` -> System 2; `ignore` -> drop side-talk (doubles as the intent gate in §3). Simple command ("move the logo left", "add a box labeled API") -> System 1 fast path; complex ("draw a CI/CD pipeline") -> System 2.
3. LLM receives compact **scene summary** (element ids, types, labels, positions, current selection/viewport) + utterance; streams tool calls.
4. Client applies each tool call as it arrives (progressive drawing) with Excalidraw `updateScene`; every action is an undoable command.
5. Reference resolution: "that", "the blue one", "move it up" resolved via selection + last-touched element + labels.
6. Optional TTS/short confirmation; barge-in cancels in-flight generation.

## 5. Milestones
1. **M1 (week 1–2)**: Vite+React+Excalidraw shell; typed-text command box -> LLM tool calls -> canvas (add/move/text/arrow). Defines tool schema.
2. **M2**: Voice in: Deepgram streaming, VAD, push-to-talk, interim transcript UI.
3. **M3**: Diagram generation (Mermaid/graph -> ELK layout -> Excalidraw), images (search + upload, move/resize).
4. **M4**: Noise/intent filtering, log commands -> fine-tune/evaluate Kev/Laya-style System 1 router vs. hosted LLM, correction handling, undo/redo, eval set of ~100 recorded commands (latency + accuracy).
5. **M5**: Persistence, auth, export (PNG/SVG/.excalidraw), deployment. (Collab and self-hosted STT deferred post-v1.)

## 6. Risks
- Latency budget: target STT <300ms, LLM first tool call <700ms. Use prompt caching, small scene summaries.
- LLM spatial reasoning is weak -> prefer semantic tools (`place_right_of(id)`) and auto-layout over raw coordinates.
- tldraw license if chosen; Excalidraw avoids it.
- Privacy: audio retention policy; offer self-host STT.

## 7. Verification
- Unit tests for tool executor (scene mutations) and transcript filter.
- Recorded-audio eval harness: WER, command success rate, p50/p95 latency.
- Manual: noisy-room test (fan/music/cross-talk), accent variety, "move that" disambiguation.
- Before kickoff: confirm licenses (Excalidraw MIT, Mermaid MIT, tldraw terms, STT vendor ToS).

## Decisions (from user)
- **Web only** (no mobile in v1). **Managed STT** (Deepgram streaming; keep STT interface swappable). **No multi-user collaboration in v1** (drop Yjs/M5 collab; single-user save/load only).
- Still open: tldraw license budget — default to Excalidraw (MIT) so not needed.
