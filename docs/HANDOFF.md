# VideoGen Studio — handoff for ZCode

Status as of **2026-10-29**, version **v0.3.7** (commit `182147f`, `main`, pushed; release published).
Repo: `D:\video_generator_app` · GitHub: `wrietersco/videogen-studio`.

## 1. What this app is

A Windows Electron desktop app: **prompt in → platform-ready video out** (TikTok, Reels, Shorts, YouTube, Facebook).
The owner is a self-described beginner who wants premium, high-fidelity short videos (dark UI infographics, editorial documentary reels with painted stills and HUD). Explain things in plain language, recommend one path, and show frames or an MP4 early.

Pipeline: planner (1 LLM call) → film director → scene directors (1 call per scene) → plate painter (image model → local Depth Anything V2 → vision locator) → composer (HTML/CSS/GSAP/Three.js, a HyperFrames composition) → QA agents + fix loop → vision critic → deterministic render (headless Chromium + FFmpeg). Renders are CPU/software-raster so the same project always produces the same pixels.

Stack: Electron + electron-vite, React renderer, TypeScript, zod VideoSpec schema, vitest. The README has the architecture diagram.

## 2. Decisions already made (do not re-litigate)

- **Small cheap chat models must work.** Directors fill schema-constrained forms (pick a widget, fill its data); quality lives in hand-built widgets, not model-authored HTML. Output is repaired and guarded and falls back to heuristics.
- **Two looks:** `infographic` (no photos, diagrams only, by design) and `documentary` (painted plates with a 2.5D depth camera).
- **Software rasterization for determinism.** Avoid full-frame per-frame repaints (drifting gradients, mix-blend grain and backdrop-filter were removed for cost). Never let a second `fromTo` on the same element default to `immediateRender`.
- **Cost control is a core value.** The user pays providers directly. Every video has a real cost receipt from a shipped price book. Reuse library assets before paying for new ones.
- **Autopilot rules** (decided by the user): an opt-in "Full autonomous agent" may tune options, but must **never change the LLM provider, the model ids or the keys, and never pick a heavier/costlier model or engine** than the user chose.
- **Test cheaply.** For any test that spends API money use the lightest model (`gemini-nano-banana-2.1` ≈ $0.03 for images), keep runs minimal, and state the expected cost first. Gemini Omni Flash is the only clip generator (≈ $0.80 per clip, so a 4-shot sequence ≈ $3.20). Prefer mock/stock where a real generation isn't needed.
- **Sora API is retired**, so clips are Gemini Omni or free stock only.

## 3. Built and shipped (in v0.3.5)

Everything below is committed, tested (58 tests pass, 11 files) and in the published installer.

| Area | What exists |
|---|---|
| Core pipeline | Planner, orchestrator, composer, QA fix-loop, deterministic MP4 render, crash-safe resumable stages, stop/cancel, re-render |
| Providers | mock (free, offline), OpenAI, Anthropic, Gemini; model lists fetched at runtime |
| Directed scenes (default) | Film director, per-scene directors, widget library (ring gauge, counter, bars, toggle, timeline, quote card, stat pair, slots, distance bar, waveform, annotation), painted plates + local depth map + subject locator, vision critic (1 round) |
| Audio | TTS narration with word-synced captions, procedural score and sound design, voice mix, Google Lyria music scored to the edit, ElevenLabs option |
| Moving clips | Gemini Omni Flash animates painted plates; the engine picks which scenes become clips (opening scene first, 1–3 per film); multi-shot sequences chain shots from each last frame into one clip; free stock clips (needs a Pexels/Pixabay key) |
| Asset library | Metadata sidecars, library-first media routing, stock search/download, uploads, reuse `smart`/`fresh` |
| **Stock engine (v0.3.6)** | Relevance-ranked results (`rankStock` in `src/main/media/stock.ts`): word coverage + orientation + resolution + clip length across Openverse, **Wikimedia Commons (new, keyless)**, Pexels, Pixabay, deduped by file; `stockQuery()` builds tight queries from the subject (camera words stripped). **On-the-go prefetch**: `MediaRouter.prefetchForSpec` (fired at the end of `runDirect`, awaited capped 45s in `runPlates`) downloads the ranked best photo per pending plate into the library — stamped with the plate reuse key, subject as tags — plus a stock clip for motion scenes when clips come from stock; 20s budget, best-effort, skipped when reuse is `fresh`. `findPlate` matches stock photos on subject tags; `paint`/`motionClip` stamp reuse keys on stock downloads. 7 tests in `tests/stock.test.ts` |
| **Money guard (v0.3.7)** | The vision critic's re-direction no longer throws away paid work. `preserveFinishedPlates` (`src/main/director/director.ts`) keeps a finished plate whose brief was only reworded (same subject, ≥60% word overlap) on the critic pass (`runDirect` with `keep: 'subject'`), and a finished clip always stays with its plate whatever the new motion pick; `pickClipScenes` never demotes a craft that already holds a clip; user-driven `reviseScene` still repaints on any brief change (`keep: 'exact'`). When a genuinely different shot retires paid work, generate() appends a `money guard: …` line to the activity log. 6 tests in `tests/moneyguard.test.ts` |
| Cost | Metered usage priced from the shipped price book, per-project `usage.json` receipt, media model picker with cost tags |
| Editing | Live storyboard while generating, per-scene feedback regeneration, timeline editor (reorder, retype, repaint, re-make), project history |
| UI | Playful redesign with plain-language labels, title-bar controls, close-to-tray |
| Distribution | NSIS installer, in-app updates from GitHub releases |
| **Autopilot (v0.3.5)** | Settings checkbox "Full autonomous agent" with a confirm step, off by default. Rule-based (no LLM call): picks look from the prompt, drops paid clips for non-motion ideas, forces smart reuse, logs reasons as `autopilot · …` in the project's activity log. Hard limits are enforced in `src/main/autopilot.ts` (`applyAutopilot` throws). 4 unit tests in `tests/autopilot.test.ts` |

## 4. Not shipped

Nothing is committed-but-unreleased or uncommitted: the working tree is clean after v0.3.6 (`docs/` stays untracked by convention).
Not verified live: the Wikimedia Commons connector was tested against a fixture (the dev sandbox blocks the network); first real run on a normal machine should be glanced at. The prefetch flow ran in unit tests only, not clicked through in the installed app.

## 5. Not built yet / known gaps

1. **Autopilot is narrow.** It only covers look, paid-clip on/off and reuse. It deliberately does not touch image/voice/music engines, quality, GPU mode, sharing or craft mode. It only applies to *new* generates; revise, re-render and resume use the user's own settings (the runtime override is cleared after each generate in `src/main/index.ts`).
2. **Autopilot never upgrades.** It will not turn on Gemini Omni for the user; they must pick Omni in Settings once (`media.video` is `stock` by default, and stock needs a Pexels/Pixabay key, so a user with only OpenAI/Gemini keys gets **no moving clips** until they change it). This is intentional but surprised the user; a clearer prompt or hint in the UI is a candidate.
3. **No visible Look choice in the Create screen.** The look comes from the director (or autopilot); users with Autopilot off get infographic for explainers and no imagery, which the user read as "templatish". The look hint is an LLM instruction plus a code override in `directFilm`; the mock provider always returns infographic.
4. **Autopilot's classifier is keyword regexes** (`DOC_RE`, `INFO_RE`, `MOTION_RE`). Vague prompts fall back to infographic. Not tuned on real prompts.
5. **README roadmap is stale.** It still lists P4 (audio) and P5 (full editor) as unchecked although audio and the timeline editor shipped. Fix it.
6. **Installer is not code-signed** (Windows SmartScreen warning). Windows x64 only; no macOS/Linux builds.
7. **No direct upload to TikTok/YouTube/etc.** The app outputs MP4s only.
8. **Conversational/structured whole-video editing** (the P5 vision) beyond the timeline editor and per-scene feedback is not built.
9. ~~Paid assets generated but never used in the video~~ — **fixed in v0.3.7** (money guard). The v0.3.5 astronaut run hit it: the critic re-direction dropped reworded-but-finished plates and deleted paid clips on motion flips.

## 6. Working rules for this repo

- **Shared checkout.** Other Claude sessions may edit `main` at the same time. Check `git status`, stage explicit paths (never `git add -A`), and build releases from a clean `git archive HEAD` snapshot.
- **Release recipe** (D: is tight on space): bump `package.json` version and commit just that file (`release: v0.3.x`); run full `npx vitest run` (~6–8 min); `git archive HEAD | tar -x` into a C: scratch folder (use bash, PowerShell mangles the pipe); copy git-ignored `vendor/fonts/*.woff2`; junction `node_modules` back to the main checkout; `npx electron-vite build` there; copy its `out/` into `D:\video_generator_app\out`; run `npx electron-builder --win nsis --x64 "-c.directories.output=<C: folder>"` from the **main** checkout (not inside the snapshot); smoke-test `win-unpacked` with `--remote-debugging-port` and an isolated `--user-data-dir` (the user's installed copy runs from `D:\videogen`); `git push`; `gh release create v0.3.x <exe> --target <full 40-char SHA>`; then remove the junction with `cmd /c rmdir` **before** deleting the snapshot, and delete `win-unpacked` with `rmdir /s /q "\\?\…"`.
- **Before a release:** delete scratch/test leftovers (`scripts/_*.ts`, temp test assets). Only `build-asset-pack.ts`, `gen.ts` and `setup-vendor.mjs` belong in `scripts/`.
- **Where user data lives:** projects in `Documents\VideoGen Studio\projects`, settings in `%APPDATA%\videogen-studio\settings.json` (keys encrypted; never print them), models in `~\.videogen-studio\models`.
- **Commit trailer:** end commits with the `Co-Authored-By` line the session provides; the owner's git name is Hassan Malik.

## 7. Useful entry points

| Need | File |
|---|---|
| Pipeline stages | `src/main/pipeline/orchestrator.ts` |
| Look / scene direction, clip picking | `src/main/director/director.ts` (`pickClipScenes`, `clipBudget`, `guardCraft`) |
| Media routing and "are clips available" | `src/main/media/router.ts` (`clipsAvailable`, `motionClip`) |
| Autopilot rules and limits | `src/main/autopilot.ts` |
| Settings shape and defaults | `src/main/settings.ts`, `src/shared/pricing.ts` (media model catalog) |
| IPC handlers | `src/main/index.ts` |
| Settings UI | `src/renderer/src/views/Settings.tsx` |
