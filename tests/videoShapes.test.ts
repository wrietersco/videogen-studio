import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import sharp from 'sharp'
import { buildCaptions, filmLayout, panAt, produce } from '../src/main/appRecon/produce'
import { sceneHtml } from '../src/main/appRecon/scenes'
import { ffmpegBin, SR } from '../src/main/audio/pcm'
import { filmFrame, isPlatformId, POST_APPS } from '../src/shared/shapes'
import { validateApp } from '../src/shared/appRecording'
import { cardPatchOf } from '../src/shared/marketing'
import type { Take } from '../src/shared/appRecon'

describe('video sizes for app films and marketing films', () => {
  it('a wide film keeps the window it always had', () => {
    const L = filmLayout()
    expect(L.win).toEqual({ x: 110, y: 40, w: 1700, bar: 46, h: 1002 })
    expect(L.page).toEqual({ x: 110, y: 86, w: 1700, h: 956 })
    expect(L.pillW).toBe(800)
    expect(L.cap).toEqual({ size: 54, side: 140, bottom: 64 })
  })

  it('tall, portrait and square films give the window the full width and keep it inside the frame', () => {
    for (const p of ['tiktok', 'instagram-feed', 'square'] as const) {
      const size = filmFrame(p)
      const L = filmLayout(size)
      expect(L.win.x + L.win.w).toBeLessThanOrEqual(size.width - 20)
      expect(L.win.y + L.win.h).toBeLessThanOrEqual(size.height)
      expect(L.page.w % 2 + L.page.h % 2).toBe(0)
      // the captions sit over the window's lower part, not under the phone's buttons
      expect(size.height - L.cap.bottom).toBeLessThan(L.win.y + L.win.h)
      expect(size.height - L.cap.bottom).toBeGreaterThan(L.page.y)
    }
    // a tall film leaves room at the top and bottom for the app's own buttons
    const t = filmLayout(filmFrame('tiktok'))
    expect(t.win.y).toBeGreaterThanOrEqual(180)
    expect(1920 - (t.win.y + t.win.h)).toBeGreaterThanOrEqual(420)
  })

  it('a narrow frame pans to what the camera is looking at', () => {
    expect(panAt({ z: 1, cx: 0.5, cy: 0.5 })).toBe(0.5)
    expect(panAt({ z: 1, cx: 0.1, cy: 0.5 })).toBeCloseTo(0.1)
    // zoomed in at the left edge: the view starts at the edge, the target is a fifth of the way across
    expect(panAt({ z: 2, cx: 0.1, cy: 0.5 })).toBeCloseTo(0.2)
    // zoomed in the middle: the view is centred on the target
    expect(panAt({ z: 1.5, cx: 0.5, cy: 0.5 })).toBeCloseTo(0.5)
    // a view kept inside the page still pans to the real target near the edge
    expect(panAt({ z: 1.5, cx: 1 / 3, cy: 0.5, tx: 0.125 })).toBeCloseTo(0.1875)
  })

  it('captions are laid out on the film\'s own frame', () => {
    const ass = buildCaptions([{ start: 0, end: 3, voiceStart: 0.4, voiceSec: 2, text: 'Open the reports page.', chapter: 'Reports', index: 1 }], 1080, 1920)
    expect(ass).toContain('PlayResX: 1080')
    expect(ass).toContain('PlayResY: 1920')
    expect(ass).toMatch(/Style: Cap,Arial,58,.*,70,70,550,1/)
  })

  it('animated scenes are sized to the frame', () => {
    const html = sceneHtml({ kind: 'title', motif: 'cards', headline: 'Hello', durationSec: 2, size: { width: 1080, height: 1920 } })
    expect(html).toContain('width:1080px;height:1920px')
    expect(html).toContain('<canvas id="c" width="1080" height="1920">')
    expect(html).toContain('"vw":1080,"vh":1920,"headLines":3')
    const wide = sceneHtml({ kind: 'title', motif: 'cards', headline: 'Hello', durationSec: 2 })
    expect(wide).toContain('width:1920px;height:1080px')
  })

  it('the platform is saved with an app and a card, and anything else is dropped', () => {
    const base = { name: 'Acme', url: 'https://acme.test', signIn: 'none' }
    const ok = validateApp({ ...base, platform: 'tiktok' })
    expect(ok.ok && ok.value.platform).toBe('tiktok')
    const junk = validateApp({ ...base, platform: 'myspace' })
    expect(junk.ok && junk.value.platform).toBeUndefined()
    expect(cardPatchOf({ platform: 'instagram-feed' }).platform).toBe('instagram-feed')
    expect(cardPatchOf({ platform: 'toString' }).platform).toBeUndefined()
    expect(POST_APPS.every((a) => isPlatformId(a.id))).toBe(true)
    expect(filmFrame()).toEqual({ width: 1920, height: 1080 })
    expect(filmFrame('tiktok')).toEqual({ width: 1080, height: 1920 })
  })

  it('makes a real tall film from a wide recording, following the click', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vg-shape-'))
    try {
      // a wide "page": grey, with a bright green button near the left edge
      const page = await sharp({ create: { width: 2560, height: 1440, channels: 3, background: '#d8dde4' } })
        .composite([{ input: await sharp({ create: { width: 320, height: 160, channels: 3, background: '#00c853' } }).png().toBuffer(), left: 160, top: 640 }])
        .png()
        .toFile(join(dir, 'f.png'))
      expect(page.width).toBe(2560)
      writeFileSync(join(dir, 'frames.txt'), `file '${join(dir, 'f.png').replace(/\\/g, '/')}'\nduration 4\nfile '${join(dir, 'f.png').replace(/\\/g, '/')}'\n`)
      const take: Take = {
        fps: 30,
        viewport: { width: 1920, height: 1080 },
        durationSec: 4,
        beats: [{ beat: 1, startSec: 0, endSec: 4, focus: { x: 120, y: 480, w: 240, h: 120, zoom: 1.5 }, url: 'https://acme.test/' }],
        navigations: [{ t: 0, url: 'https://acme.test/' }],
        log: [],
        redactionMisses: 0
      }
      // a short tone stands in for the voice (a silent film cannot be loudness-matched)
      const tone = Float32Array.from({ length: SR }, (_, i) => 0.2 * Math.sin((2 * Math.PI * 220 * i) / SR))
      const res = await produce({
        dir: join(dir, 'out'),
        framesList: join(dir, 'frames.txt'),
        offsetSec: 0,
        take,
        beats: [{ beat: 1, chapter: 'Start', text: 'Press the green button.', pcm: tone }],
        title: 'Test',
        noBuiltinMusic: true,
        outro: { headline: 'Acme', sub: 'Try it today', text: 'Thanks.', pcm: new Float32Array(0) },
        size: { width: 1080, height: 1920 }
      })
      const probe = spawnSync(ffmpegBin().replace(/ffmpeg(\.exe)?$/i, (m) => m.replace('ffmpeg', 'ffprobe')), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', res.file])
      if (probe.status === 0) expect(probe.stdout.toString().trim()).toBe('1080,1920')
      // a frame once the camera has settled on the button: the button is in the window, not cut off to the left
      const still = join(dir, 'still.png')
      const r = spawnSync(ffmpegBin(), ['-v', 'error', '-y', '-ss', '2.5', '-i', res.file, '-frames:v', '1', still])
      expect(r.status).toBe(0)
      const img = sharp(still)
      const meta = await img.metadata()
      expect([meta.width, meta.height]).toEqual([1080, 1920])
      const L = filmLayout({ width: 1080, height: 1920 })
      const { data, info } = await img.raw().toBuffer({ resolveWithObject: true })
      let green = 0
      let sumX = 0
      for (let y = L.page.y; y < L.page.y + L.page.h; y += 4) {
        for (let x = L.page.x; x < L.page.x + L.page.w; x += 4) {
          const o = (y * info.width + x) * info.channels
          if (data[o] < 80 && data[o + 1] > 150 && data[o + 2] < 120) { green++; sumX += x }
        }
      }
      expect(green).toBeGreaterThan(500)
      // the button is well inside the window, near its centre
      const cx = sumX / green
      expect(cx).toBeGreaterThan(L.page.x + 80)
      expect(cx).toBeLessThan(L.page.x + L.page.w - 80)
      writeFileSync(join(tmpdir(), 'vg-shape-last.txt'), still)
    } finally {
      if (!process.env.KEEP_SHAPE_TEST) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }, 180000)
})
