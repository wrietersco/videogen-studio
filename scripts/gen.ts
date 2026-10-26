/**
 * CLI entry — headless video generation without the UI.
 *
 *   npm run gen -- --prompt "explain X" --platform tiktok --style social
 *   npm run gen -- --prompt "..." --duration 45 --quality draft
 */
import { parseArgs } from 'node:util'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Orchestrator } from '../src/main/pipeline/orchestrator'
import { ProjectStore } from '../src/main/store/projectStore'
import { MockProvider } from '../src/main/providers/mock'
import { PLATFORM_PRESETS } from '../src/shared/presets'
import type { PlatformId, StyleFamily } from '../src/shared/spec'

const { values } = parseArgs({
  options: {
    prompt: { type: 'string', short: 'p' },
    platform: { type: 'string', short: 'l', default: 'tiktok' },
    style: { type: 'string', short: 's' },
    duration: { type: 'string', short: 'd' },
    quality: { type: 'string', short: 'q', default: 'standard' },
    out: { type: 'string', short: 'o', default: 'projects' }
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
const orchestrator = new Orchestrator(store, () => new MockProvider())

console.log(`▶ generating: "${values.prompt}" → ${platform}${style ? ` (${style})` : ''}`)
const started = Date.now()

try {
  const result = await orchestrator.generate({
    prompt: values.prompt,
    platform,
    styleHint: style,
    durationHintSec: values.duration ? Number(values.duration) : undefined,
    quality: (values.quality as 'draft' | 'standard' | 'delivery') ?? 'standard',
    onEvent: (e) => {
      switch (e.stage) {
        case 'plan':
          if (e.status === 'done') console.log(`✓ plan: "${e.title}" — ${e.scenes} scenes, ${e.durationSec}s`)
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
