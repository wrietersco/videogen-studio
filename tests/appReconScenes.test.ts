import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import sharp from 'sharp'
import { ffmpegBin } from '../src/main/audio/pcm'
import { findChrome } from '../src/main/appRecon/browser'
import { pickMotif, renderScene, sceneHtml, type SceneInput } from '../src/main/appRecon/scenes'

describe('pickMotif', () => {
  it('maps concepts to motifs', () => {
    expect(pickMotif('A Quran ontology graph of topics')).toBe('graph')
    expect(pickMotif('connect your knowledge network')).toBe('graph')
    expect(pickMotif('Automate your approval workflow')).toBe('flow')
    expect(pickMotif('a step by step pipeline')).toBe('flow')
    expect(pickMotif('Beautiful invoices for freelancers')).toBe('cards')
    expect(pickMotif('')).toBe('cards')
  })
})

describe('sceneHtml', () => {
  const base: SceneInput = { kind: 'title', motif: 'graph', headline: '<script>alert("x")</script> It\'s "great"', sub: 'a & b', pill: 'NEW', durationSec: 2 }
  it('escapes text and stays offline', () => {
    const html = sceneHtml(base)
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; It&#39;s &quot;great&quot;')
    expect(html).toContain('a &amp; b')
    expect(html).not.toMatch(/https?:\/\//i)
    expect(html).toContain('window.__seek')
  })
  it('rejects odd colours', () => {
    const html = sceneHtml({ ...base, backdrop: ['red;}</style><script>x', '#123456'], accent: 'zzzzzz' })
    expect(html).not.toContain('</style><script>x')
  })
})

function duration(file: string): number {
  const r = spawnSync(ffmpegBin(), ['-hide_banner', '-i', file], { encoding: 'utf8' })
  const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(r.stderr)
  if (!m) throw new Error('no duration: ' + r.stderr)
  return +m[1] * 3600 + +m[2] * 60 + +m[3]
}

async function frameAt(file: string, sec: number): Promise<Buffer> {
  const r = spawnSync(ffmpegBin(), ['-hide_banner', '-v', 'error', '-ss', String(sec), '-i', file, '-frames:v', '1', '-vf', 'scale=480:270', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 })
  return r.stdout
}

function meanDiff(a: Buffer, b: Buffer): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += Math.abs(a[i] - b[i])
  return s / n
}

describe.skipIf(!findChrome())('renderScene', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vg-scenes-test-'))
  const mk = (kind: SceneInput['kind'], motif: SceneInput['motif']): SceneInput => ({ kind, motif, pill: 'THE PROBLEM', headline: "Taaweel's Ontology feature", sub: 'Visually understand', accent: '6aa629', durationSec: 2 })

  it('renders a problem scene and a title scene deterministically', async () => {
    const p = await renderScene(mk('problem', 'graph'), join(dir, 'p1.mp4'))
    expect(existsSync(p.file)).toBe(true)
    expect(Math.abs(duration(p.file) - 2)).toBeLessThan(0.15)
    expect(meanDiff(await frameAt(p.file, 0.1), await frameAt(p.file, 1.9))).toBeGreaterThan(1)
    const p2 = await renderScene(mk('problem', 'graph'), join(dir, 'p2.mp4'))
    const a = await frameAt(p.file, 1), b = await frameAt(p2.file, 1)
    expect(meanDiff(a, b)).toBeLessThan(1)
    const sa = await sharp(a, { raw: { width: 480, height: 270, channels: 3 } }).stats()
    const sb = await sharp(b, { raw: { width: 480, height: 270, channels: 3 } }).stats()
    expect(Math.abs(sa.channels[0].mean - sb.channels[0].mean)).toBeLessThan(1)

    const t = await renderScene(mk('title', 'flow'), join(dir, 't.mp4'))
    expect(Math.abs(duration(t.file) - 2)).toBeLessThan(0.15)
    expect(meanDiff(await frameAt(t.file, 0.1), await frameAt(t.file, 1.9))).toBeGreaterThan(1)
  }, 180000)

  it('cleans up', () => rmSync(dir, { recursive: true, force: true }))
})
