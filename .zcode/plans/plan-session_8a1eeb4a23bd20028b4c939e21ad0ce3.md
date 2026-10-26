# VideoGen Studio — Build Plan

Desktop video-generation app: freestyle text/image prompts → dynamic, editable videos for TikTok/YouTube/Instagram/Facebook. Generation is LLM-light (1–2 calls), rendering is deterministic (HyperFrames → MP4), and a resilient agent loop self-heals composition errors. Ships with a **MockProvider** so the whole pipeline is built and tested with me (ZCode) playing OpenAI/Claude/Gemini — real keys wire in later without code changes.

## Locked decisions
- **Shell**: Electron (electron-vite) + React + TypeScript + Tailwind. Electron because HyperFrames is Node-based (Puppeteer + FFmpeg) — the render pipeline runs natively in the main process.
- **Render engine**: HyperFrames (Apache-2.0; verified). Compositions = plain HTML + seekable GSAP/Three.js timelines; `lint`/`inspect` commands power QA; ~450-block catalog + `@hyperframes/{core,engine,producer,studio}` packages. Node 24.11.1 already installed (needs 22+).
- **Determinism contract**: same composition → byte-stable MP4. All dynamism lives in the generation layer (planner/composer); all editability lives in the VideoSpec + composition files.
- **Audio**: OpenAI TTS narration (word-level timestamps → beat-synced captions) + bundled royalty-free music with auto-mixing via HyperFrames audio tracks.
- **MVP style kits**: (1) kinetic typography / social, (2) explainer / product demo, (3) 3D / motion graphics (Three.js). Cinematic/documentary etc. slot in later — same architecture.
- **Providers**: OpenAI (Responses API), Anthropic (Messages API), Gemini (generateContent). Model IDs discovered at runtime from each provider's model-list endpoint + free-text override → future models supported without app updates. Keys stored via Electron `safeStorage` (Windows credential-protected), never leave the machine except as API auth.
- **Audio**: OpenAI TTS narration (word-level timestamps → beat-synced captions) + bundled royalty-free music with auto-mixing via HyperFrames audio tracks.
- **MVP style kits**: (1) kinetic typography / social, (2) explainer / product demo, (3) 3D / motion graphics (Three.js). Cinematic/documentary etc. slot in later — same architecture.

## Architecture

```
Electron Renderer (React UI)
  Prompt Studio (freestyle text + reference images + example gallery
                 showing "this prompt → this type of video")
  Agent Activity Feed (live per-stage/fixer logs)
  Timeline Editor (3 edit levels) · Project Library · Settings
        │ typed IPC
Main process (Node)
  Provider layer      LLMProvider interface → OpenAI/Anthropic/Gemini adapters
                      + MockProvider (fixtures authored by me during dev)
  Orchestrator       planner → composer → assets → audio → render → QA-loop
  Renderer service   wraps @hyperframes/producer (headless Chrome → MP4)
  Project store      projects/<id>/{spec.json, index.html, assets/, out/*.mp4}
```

### Pipeline stages (each idempotent + persisted → resumable projects)
1. **Planner** (1 LLM call, JSON-schema constrained): prompt + images + platform → `VideoSpec` — style, scene list with durations, narration lines, palette/typography, pacing profile, asset needs.
2. **Composer** (procedural-first, LLM optional): VideoSpec → composition. **Style kits** (curated design tokens: easing curves, type scales, motion physics, palettes per style family) assembled from HyperFrames blocks — zero LLM for standard briefs; bespoke LLM-authored HTML (mock-me in dev) for novel requests, always lint-gated.
3. **Assets** (escalation only): OpenAI image generation for photoreal stills; everything else procedural (CSS/SVG/Three.js/@hyperframes/shader-transitions).
4. **Audio**: OpenAI TTS → narration.wav + word timestamps → caption track; royalty-free music selection matched to pacing; mixed via HyperFrames audio elements (`data-start/duration/track/volume`).
5. **Render**: per-platform MP4 (TikTok 1080×1920, YouTube 1920×1080 + Shorts, Reels, FB 4:5/16:9). Job queue with progress events, cancelable.
6. **QA fix-loop (resilient agents)**: `hyperframes lint` + `inspect` + DOM checks (text overflow, contrast, off-screen elements, timing vs spec) + sampled-frame vision check. Error classifier routes to fixer subagents (**LintFixer, LayoutFixer, TimingFixer, RenderFixer**): deterministic auto-fix rules first, LLM-assisted patch second, bounded retries (3/stage, 8/project), full activity log surfaced in the UI.

### Editor (3 levels, all deterministic re-render)
(a) Conversational — "make scene 2 faster" → targeted VideoSpec/composition patch; (b) Structured forms — text, colors, timing, scene order, audio; (c) Code view. Live preview via embedded BrowserView running `hyperframes preview` (hot reload).

### Platform presets
TikTok / YouTube (+Shorts) / Instagram (Reels/Feed) / Facebook: resolution, duration guidance, pacing profile, caption style, safe-zone metadata.

## File layout
```
D:\video_generator_app\
  package.json · electron.vite.config.ts · tsconfig
  src/main/{providers,pipeline,rendererService,store,ipc,agents}/…
  src/renderer/src/{studio,editor,library,settings,components}/…
  kits/      style kits + design tokens (3 MVP families)
  blocks/    curated HyperFrames block wrappers
  presets/   platform presets
  music/     bundled royalty-free tracks
  fixtures/  mock-LLM fixtures
  projects/  runtime project output
  e2e/       integration + UI tests
```

## Build phases (each ends runnable + verified)
- **P0 Setup**: verify FFmpeg (fallback: npm `ffmpeg-static`); scaffold electron-vite + React + TS; HyperFrames smoke test (render a 2s sample MP4).
- **P1 Core pipeline (headless)**: MockProvider + Planner + Composer with the 3 style kits + render wrapper + lint QA + project store + CLI entry (`npm run gen -- --prompt … --platform tiktok --style social`). Gate: real MP4s produced, lint-clean, byte-stable across re-renders.
- **P2 App shell**: Electron UI — prompt studio, agent activity feed, project library, live preview, settings (key entry, dynamic model list, mock toggle).
- **P3 Real providers + fixer agents**: the three adapters, JSON-schema planning, vision QA, all four fixer subagents with retry budgets. ← point where temp keys from you are useful; everything before runs on mock.
- **P4 Audio**: OpenAI TTS narration + word-synced captions + music library + auto-mixing.
- **P5 Editor + polish**: structured editing, conversational edits, prompt/example gallery, multi-platform export.

## Testing
- **Unit**: VideoSpec schema, preset mapping, fixer rules, provider adapters (recorded responses).
- **Integration (mock)**: full pipeline → 2s/320×180 render → MP4 exists, frames non-black, lint clean, **byte-stable rerun (determinism gate)**.
- **Visual**: sampled-frame snapshots per style kit. **e2e**: Playwright happy path through the Electron UI.
- CI-style check script runnable locally: `npm run verify`.

## What I need from you, and when
- **Now**: nothing — development runs on MockProvider (I play the LLMs).
- **At P3**: temporary OpenAI/Claude/Gemini keys for live adapter testing.
- Optional: confirm FFmpeg is installed, or I auto-handle it (`ffmpeg-static` fallback).