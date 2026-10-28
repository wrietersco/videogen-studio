import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { rmSync, mkdtempSync, readdirSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Orchestrator } from '../src/main/pipeline/orchestrator'
import { ProjectStore } from '../src/main/store/projectStore'
import { MockProvider } from '../src/main/providers/mock'
import { RenderService } from '../src/main/rendererService/hyperframes'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ffmpeg = resolve(appRoot, 'node_modules/ffmpeg-static/ffmpeg.exe')

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** extract ~n evenly spaced frames, return their PNG hashes (deterministic pixels → identical PNGs) */
function frameHashes(mp4: string, outDir: string, n: number, fps: number, durationSec: number): string[] {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const totalFrames = Math.floor(durationSec * fps)
  const picks: number[] = []
  for (let i = 1; i <= n; i++) picks.push(Math.min(totalFrames - 1, Math.round((i / (n + 1)) * totalFrames)))
  const select = [...new Set(picks)].map((f) => `eq(n\\,${f})`).join('+')
  execFileSync(
    ffmpeg,
    ['-y', '-loglevel', 'error', '-i', mp4, '-vf', `select='${select}',scale=160:284`, '-vsync', 'vfr', join(outDir, 'f%03d.png')],
    { stdio: 'pipe' }
  )
  const files = readdirSync(outDir).filter((f) => f.endsWith('.png')).sort()
  expect(files.length).toBeGreaterThan(3)
  return files.map((f) => sha256(join(outDir, f)))
}

/**
 * PSNR of two frame dirs (frame i of a vs frame i of b). Chromium raster can
 * jitter by ±2/255 on a sparse pixel scatter between a cold and warm browser
 * run, which flips downscaled-PNG hashes while being visually identical —
 * the gate accepts that jitter (PSNR ≥ 50 dB) but nothing structural.
 */
function framePairsPSNR(dirA: string, dirB: string): number[] {
  const a = readdirSync(dirA).filter((f) => f.endsWith('.png')).sort()
  const b = readdirSync(dirB).filter((f) => f.endsWith('.png')).sort()
  expect(a.length).toBe(b.length)
  return a.map((f, i) => {
    const r = spawnSync(
      ffmpeg,
      ['-hide_banner', '-i', join(dirA, f), '-i', join(dirB, f),
       '-filter_complex', 'psnr', '-f', 'null', '-'],
      { encoding: 'utf8' }
    )
    const m = /average:([\d.]+|inf)/.exec((r.stderr ?? '') + (r.stdout ?? ''))
    if (!m) return 0
    return m[1] === 'inf' ? Infinity : parseFloat(m[1])
  })
}

describe('full pipeline (mock provider, draft render)', () => {
  it('generates a real MP4 from a freestyle prompt and is deterministic on re-render', { timeout: 600_000 }, async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'vg-e2e-'))
    const store = new ProjectStore(join(workDir, 'projects'))
    const orch = new Orchestrator(store, () => new MockProvider())
    const result = await orch.generate({
      prompt: 'quick hype clip about retro gaming',
      platform: 'tiktok',
      quality: 'standard', // deterministic path: software GL + single worker
      onEvent: () => {}
    })
    expect(existsSync(result.output)).toBe(true)
    expect(result.spec.scenes.length).toBeGreaterThanOrEqual(3)
    expect(readFileSync(result.output).length).toBeGreaterThan(50_000) // real content, not black frames

    // ---- determinism gate: same project → pixel-identical re-render ----
    const dir = dirname(result.output)
    const render2 = join(dir, 'rerender.mp4')
    const svc = new RenderService()
    const again = await svc.render(store.dir(result.projectId), render2, { quality: 'standard', fps: result.spec.fps })
    expect(again.ok).toBe(true)

    const h1 = frameHashes(result.output, join(workDir, 'f1'), 6, result.spec.fps, result.spec.durationSec)
    const h2 = frameHashes(render2, join(workDir, 'f2'), 6, result.spec.fps, result.spec.durationSec)
    if (!h1.every((h, i) => h === h2[i])) {
      // cold-vs-warm Chromium raster jitter: ±2/255 on sparse pixels — visually
      // identical. Structural drift (fonts, layout, timing) fails PSNR 50 dB.
      for (const p of framePairsPSNR(join(workDir, 'f1'), join(workDir, 'f2'))) {
        expect(p).toBeGreaterThanOrEqual(50)
      }
    }

    // cleanup can EPERM on Windows while Chrome/ffmpeg handles are still closing
    try {
      rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
    } catch {
      /* leftover in %TEMP% is harmless */
    }
  })
})
