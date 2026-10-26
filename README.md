# VideoGen Studio

Prompt in → platform-ready video out. A desktop app that turns freestyle text (and image) prompts into dynamic, editable videos for TikTok, YouTube/Shorts, Instagram Reels/Feed, and Facebook — with minimal LLM involvement, deterministic rendering, and self-healing generation agents.

## How it works

```
freestyle prompt ──▶ Planner (1 LLM call, JSON-schema constrained) ──▶ VideoSpec
                                                                           │
             ┌─────────────────────────────────────────────────────────────┘
             ▼
        Composer (procedural): style kits + scene renderers + animation DSL
             │  emits HTML/CSS/GSAP/Three.js — a HyperFrames composition
             ▼
        QA agents: `hyperframes check` (lint · layout · motion · WCAG contrast)
             │  deterministic auto-fixes → bounded fix loop
             ▼
        Renderer: headless Chromium frame-stepping + FFmpeg ──▶ MP4
```

- **Deterministic rendering**: the same project always renders to the same pixels (software rasterization + single capture worker for standard/delivery quality). That's what makes videos *editable* and the fix-loop *verifiable*.
- **Fully dynamic compositions**: no template grid — the composer writes bespoke HTML/CSS/GSAP (and Three.js scenes driven by `hf-seek`) from the spec, constrained by design-system craft (motion physics, type scales, safe zones, contrast).
- **Works without API keys**: the built-in **Mock engine** plans videos with built-in heuristics. Add OpenAI / Claude / Gemini keys in Settings for full creative generation; model lists are fetched at runtime so new models work without app updates.
- **No GPU required**: rendering is CPU-first. GPU fast mode is an opt-in (faster, but re-renders may differ by a few pixels). 3D-heavy videos are the slowest on CPU-only machines.

## Development

```bash
npm install
npm run setup-vendor   # fetch GSAP/Three + fonts into vendor/ (one-time)
npm run dev            # Electron app (studio · library · editor · settings)
```

### Headless CLI

```bash
npm run gen -- --prompt "snappy tiktok about why cats rule the internet" --platform tiktok
npm run gen -- --prompt "calm explainer about coffee" --platform youtube --duration 45 --quality draft
```

### Tests

```bash
npm run verify         # typecheck + unit + composer tests (fast)
npm run test:e2e       # full pipeline → MP4 + determinism gate (minutes)
```

## Layout

```
src/shared/       VideoSpec schema (zod) · platform presets
src/main/
  providers/      LLMProvider seam: mock · openai · anthropic · gemini (+registry)
  pipeline/       planner · orchestrator (QA fix-loop)
  composer/       layout engine · animation DSL · scene renderers · style kits · three.js
  rendererService HyperFrames render + check wrappers
  store/          project store (projects/<id>/spec.json · index.html · renders/)
src/renderer/     React UI (studio, library, editor, settings)
vendor/           gsap · three · fonts (self-contained compositions)
kits/…            (composer style kits live in src/main/composer)
```

## Roadmap

- [x] P0 — environment + HyperFrames smoke test
- [x] P1 — mock-provider pipeline → real MP4s, determinism gate
- [x] P2 — Electron app shell
- [x] P3 — real provider adapters (planner); LLM-assisted fixers
- [ ] P4 — audio: TTS narration + word-synced captions + music library
- [ ] P5 — full editor (structured + conversational edits), image asset escalation
