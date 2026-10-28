/**
 * CLI entry — headless video generation without the UI.
 *
 *   npm run gen -- --prompt "explain X" --platform tiktok --style social
 *   npm run gen -- --prompt "..." --duration 45 --quality draft
 *   npm run gen -- --prompt "..." --craft classic          (template scenes)
 *   OPENAI_API_KEY=… npm run gen -- --prompt "..." --provider openai
 *     (real providers read their key from OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY;
 *      painted plates use the first keyed provider that can generate images)
 */
import { parseArgs } from 'node:util'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Orchestrator } from '../src/main/pipeline/orchestrator'
import { ProjectStore } from '../src/main/store/projectStore'
import { MockProvider } from '../src/main/providers/mock'
import { OpenAIProvider } from '../src/main/providers/openai'
import { AnthropicProvider } from '../src/main/providers/anthropic'
import { GeminiProvider } from '../src/main/providers/gemini'
import type { LLMProvider } from '../src/main/providers/types'
import { PLATFORM_PRESETS } from '../src/shared/presets'
import type { PlatformId, StyleFamily } from '../src/shared/spec'

const { values } = parseArgs({
  options: {
    prompt: { type: 'string', short: 'p' },
    platform: { type: 'string', short: 'l', default: 'tiktok' },
    style: { type: 'string', short: 's' },
    duration: { type: 'string', short: 'd' },
    quality: { type: 'string', short: 'q', default: 'standard' },
    out: { type: 'string', short: 'o', default: 'projects' },
    craft: { type: 'string', default: 'directed' },
    provider: { type: 'string', default: 'mock' }
  }
})

if (!values.prompt) {
  console.error('usage: npm run gen -- --prompt "..." [--platform tiktok|youtube|...] [--style social|explainer|motion3d] [--duration 30] [--quality draft|standard|delivery]')
  process.exit(1)
}

const platform = (values.platform as PlatformId) in PLATFORM_PRESETS ? (values.platform as PlatformId) : 'tiktok'
const style = values.style as StyleFamily | undefined
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const store = new ProjectStore(resolve(appRoot, values.out!))
const env = (k: string) => process.env[k] ?? ''
const keyed: Record<string, LLMProvider | null> = {
  openai: env('OPENAI_API_KEY') ? new OpenAIProvider(() => env('OPENAI_API_KEY'), () => env('OPENAI_MODEL') || undefined, () => env('OPENAI_IMAGE_MODEL') || undefined) : null,
  anthropic: env('ANTHROPIC_API_KEY') ? new AnthropicProvider(() => env('ANTHROPIC_API_KEY'), () => env('ANTHROPIC_MODEL') || undefined) : null,
  gemini: env('GEMINI_API_KEY') ? new GeminiProvider(() => env('GEMINI_API_KEY'), () => env('GEMINI_MODEL') || undefined, () => env('GEMINI_IMAGE_MODEL') || undefined) : null
}
const chat: LLMProvider = keyed[values.provider ?? 'mock'] ?? new MockProvider()
if (values.provider && values.provider !== 'mock' && chat.id === 'mock') {
  console.error(`! no key for ${values.provider} in the environment — using the mock engine`)
}
const painter = [chat, keyed.openai, keyed.gemini].find((p) => p && p.id !== 'mock' && p.generateImage) ?? null
const orchestrator = new Orchestrator(store, () => chat, () => painter)

console.log(`▶ generating: "${values.prompt}" → ${platform}${style ? ` (${style})` : ''}`)
const started = Date.now()

try {
  const result = await orchestrator.generate({
    prompt: values.prompt,
    platform,
    styleHint: style,
    durationHintSec: values.duration ? Number(values.duration) : undefined,
    quality: (values.quality as 'draft' | 'standard' | 'delivery') ?? 'standard',
    craft: values.craft === 'classic' ? 'classic' : 'directed',
    onEvent: (e) => {
      switch (e.stage) {
        case 'plan':
          if (e.status === 'done') console.log(`✓ plan: "${e.title}" — ${e.scenes} scenes, ${e.durationSec}s`)
          break
        case 'direct':
          if (e.status === 'film') console.log(`✓ film director: ${e.look} · "${e.series}"`)
          if (e.status === 'scene') console.log(`  · scene ${e.sceneIndex + 1}: "${e.headline}" [${e.background}${e.widgets.length ? ' · ' + e.widgets.join(' + ') : ''}]`)
          break
        case 'plates':
          if (e.status === 'scene') console.log(`  · plate ${e.sceneIndex + 1} painted + depth mapped`)
          if (e.status === 'failed') console.log(`  ⚠ plate ${e.sceneIndex + 1}: ${e.error}`)
          if (e.status === 'done') console.log(`✓ plates: ${e.made} ready`)
          break
        case 'critic':
          if (e.status === 'scene') console.log(`  · critic scene ${e.sceneIndex + 1}: ${e.score}/10 ${e.notes.join(' | ')}`)
          if (e.status === 'done') console.log(`✓ critic: ${e.revised} scene(s) revised`)
          break
        case 'compose':
          if (e.status === 'done') console.log('✓ compose: HyperFrames project written')
          break
        case 'qa':
          if (e.status === 'fixing') console.log(`… qa fix attempt ${e.attempt}: ${e.issues[0] ?? ''}`)
          if (e.status === 'done') console.log(`✓ qa: clean (${e.warnings} warnings)`)
          if (e.status === 'failed') console.log(`⚠ qa: unresolved — ${e.issues.slice(0, 3).join(' | ')}`)
          break
        case 'render':
          if (e.status === 'progress' && e.pct % 25 === 0) console.log(`… render ${e.pct}%`)
          if (e.status === 'done') console.log(`✓ render: ${e.output} (${e.wallSec.toFixed(1)}s)`)
          if (e.status === 'failed') console.error(`✗ render failed: ${e.error}`)
          break
        case 'done':
          console.log(`\n✔ done in ${((Date.now() - started) / 1000).toFixed(1)}s → ${e.output}`)
          break
      }
    }
  })
  console.log(`  project: ${result.projectId}`)
} catch (err) {
  console.error('✗ generation failed:', err)
  process.exit(1)
}
