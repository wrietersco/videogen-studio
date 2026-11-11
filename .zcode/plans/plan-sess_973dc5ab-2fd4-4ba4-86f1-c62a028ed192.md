# DeepSeek provider + multi-provider role routing

## Context

Today all text/code/vision work routes through **one** chat provider (`settings.provider`, the "brain" tiles), and media generation through `settings.media.*` engine picks. The user wants:

1. **DeepSeek** as a new provider for code generation and image processing (OpenAI-compatible API → small adapter).
2. **Multiple providers enabled at once**, each with **checkbox roles** in a dropdown (text / code / image-gen / image-process / video-gen / video-process / audio-gen / audio-process) + an "all-rounder" shortcut. Unsupported roles are disabled per model (DeepSeek: generation roles off, code/text/image-processing on).
3. No production build — verify with `npm run verify`, run `npm run dev`.

Key seams to reuse: `LLMProvider` optional capabilities (`src/main/providers/types.ts:90`), `ProviderRegistry` (`src/main/providers/registry.ts`), the `OpenAIProvider` /chat/completions template (`src/main/providers/openai.ts`), and `settings.media.*` explicit engine picks (these stay authoritative for media generation; roles govern auto-resolution + the text/code/vision routing that has no per-kind setting).

**No backward-compat layer** (no live users): `roles` is a required settings field, defaulted to each provider's full capability set; `loadSettings()`'s existing defaults-merge applies it to any saved settings.json. One rule: the brain provider is always the final fallback for text/code/vision so a mis-configured role set can't brick AI.

## Capability matrix (NEW `src/shared/providerRoles.ts`)

```ts
export type ProviderRole = 'text' | 'code' | 'image-gen' | 'image-process'
  | 'video-gen' | 'video-process' | 'audio-gen' | 'audio-process'
export const ROLE_LABELS: Record<ProviderRole, string>
export const PROVIDER_CAPABILITIES: Record<ProviderId, ProviderRole[]> = {
  openai:    ['text','code','image-gen','image-process','video-process','audio-gen','audio-process'],
  anthropic: ['text','code','image-process','video-process'],
  gemini:    ['text','code','image-gen','image-process','video-gen','video-process','audio-gen'],
  deepseek:  ['text','code','image-process'],   // exactly per request
  mock:      ['text']
}
```
(DEFAULT_ROLES derived from it; type-only import of `ProviderId` — renderer already type-imports that path.)

## Changes by file

### 1. Provider plumbing
- **`src/main/providers/types.ts`** — `ProviderId` += `'deepseek'` (flows to `KeyId`, renderer, `BRAIN_HINT` via TS).
- **NEW `src/main/providers/deepseek.ts`** — chat half of `openai.ts`: base `https://api.deepseek.com/v1`, Bearer key, models `deepseek-chat` ($0.27/$1.10 per 1M) and `deepseek-reasoner` ($0.55/$2.19, no temperature, `supportsVision: true` per requested matrix). `generateJSON` via DeepSeek's `response_format:{type:'json_object'}` with the schema inlined into the system prompt, parsed by the same fence-stripper as `openai.ts:332` (no `json_schema` support). Images as OpenAI-style `image_url` data-URL parts. No `generateImage`/`tts`/`listImageModels`. Metered via `meter.record` (`kind:'text', provider:'deepseek'`); errors via `ProviderError` like `openai.ts:371`.
- **`src/main/providers/registry.ts`** — instantiate DeepSeek; export the class (testability); roles become part of `reconfigure`; add:
  - `forRole(role): LLMProvider | null` — candidates where `roles[id]` includes the role, capability-matrix + key filtered (`image-gen` also requires the method), ordered brain-first then `openai → anthropic → gemini → deepseek`; null when none (caller falls back to brain/active).
  - `roleEnabled(id, role): boolean` — pure `roles[id]?.includes(role)` lookup for boolean gates (elevenlabs voice/music, whisper transcription, gemini video clips).
- **`src/shared/pricing.ts`** — `ProviderKey` += `'deepseek'`; `RATES` for the two models.
- **`src/shared/plans.ts`** — `providerOfModel` += `^deepseek` branch.

### 2. Settings + main wiring
- **`src/main/settings.ts`** — `Settings.roles: Partial<Record<ProviderId, ProviderRole[]>>`; `DEFAULT_SETTINGS.roles` = full capability sets.
- **`src/main/index.ts`**:
  - `keyOf` (:44-53): `deepseek` joins the AI list; plan mode ⇒ `''` (no relay for it, like anthropic).
  - `applyAccess` own-keys branch (:120-126): += `deepseek: decryptKey(settings.keys.deepseek)`.
  - `settings:set` (:431): validate + store `patch.roles` (known providers × supported roles, dedupe).
  - `settings:keyStatus` (:428): += `'deepseek'`.
  - Orchestrator wiring (:77): `providerFor` → `forRole('text') ?? active()`; new `codeProviderFor` / `visionProviderFor` args → `forRole('code' | 'image-process') ?? active()`.
  - FootageService wiring (:63): text provider as above; new `visionProvider` dep; `whisperKey` gated by `roleEnabled('openai','audio-process')`; `chatModel` fallback map += deepseek.
- **`src/main/pipeline/orchestrator.ts`** — constructor += optional `codeProviderFor` / `visionProviderFor` (default `providerFor`). `runCustomScenes`: `needsCanvasCode`/`authorCanvasCode`/`authorCustomScene` → **code** provider; image-review `verdict` → **vision**; `chooseCustomScenes` stays text. `runPlates`: `relocatePlate` vision → **vision**.
- **`src/main/media/router.ts`** — deps += `providerForRole(role)` and `roleAllows(id, role)`. `scoreImage` → image-process (fallback `provider(settings.provider)` as today); `scoreVideo` → video-process; `speech()` auto-priority filtered by `roleAllows('audio-gen')` (explicit `media.voice` picks unchanged); `clipsAvailable()` gemini branch requires `roleAllows('gemini','video-gen')`.
- **`src/main/footage/service.ts`** — optional `visionProvider` dep; `understand()` uses it for `watchClip` (planning stays text).

### 3. Renderer
- **`src/renderer/src/api.ts`** — `SettingsView.roles` mirror + re-export `ProviderRole`.
- **`src/renderer/src/views/Settings.tsx`**:
  - `KEYS` += DeepSeek row (platform.deepseek.com); `BRAIN_HINT` += deepseek (TS-required); `defaultModel` += `'deepseek': 'deepseek-chat'`; model preloads += deepseek.
  - New **"Who does what"** Section (`insider && !onPlan`, after brain tiles): per-provider row — enable checkbox (checks/unchecks all supported roles), key-status chip, `<details>` dropdown (existing pattern, cf. :291) with a checkbox per role (disabled + "not supported" outside `PROVIDER_CAPABILITIES`), and an **All-rounder** button. Checkboxes bind directly to `settings.roles[pid]`; each toggle saves via `patch({ roles })`. Hint names resolution order: brain first, then OpenAI → Anthropic → Gemini → DeepSeek.

### 4. CLI + env
- **`scripts/gen.ts`** — `keyed` += `deepseek` reading `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL`.
- **`.env`** — add `DEEPSEEK_API_KEY=` slot (+ optional `DEEPSEEK_MODEL=`).

### 5. Tests (vitest, existing fake patterns)
- **NEW `tests/deepseek.test.ts`** — `vi.stubGlobal('fetch')` (pattern from `geminiVideo.test.ts`): text body/headers, JSON via `json_object` + fenced-JSON parse, vision content parts, 401 → `ProviderError('auth')`.
- **NEW `tests/providerRoles.test.ts`** — fresh `ProviderRegistry`: role filtering + priority (brain first; deepseek never for image-gen; unkeyed skipped); `roleEnabled` gates; defaults = full capabilities.
- Touch `tests/unit.test.ts` only if typecheck forces it.

## Verification
1. `npm run verify` (typecheck + unit suites).
2. `npm run test:e2e` (mock pipeline e2e).
3. `npm run dev` — Electron dev app (no exe): paste a DeepSeek key → enable code+text roles → confirm role checkboxes disable image/video/audio generation for DeepSeek, brain tiles list DeepSeek, and a mock run still works with roles saved.

**Out of scope:** relay/plan support for deepseek (direct key only); per-sub-kind audio roles (explicit media engine picks already cover that).