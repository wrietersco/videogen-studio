import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from '../appRecon/browser'
import { vendorDir } from '../paths'

/**
 * The shared machinery of every AI-coded opening: the marketing intro
 * director and the intro-background director both write a self-contained page
 * (HTML + CSS + SVG/canvas + JS, GSAP, optionally three.js) whose every frame
 * is window.__seek(t); both lint it, load it in a real browser at a few
 * moments and measure what is wrong. Neither may duplicate any of this.
 */

export interface Code {
  html: string
  css: string
  js: string
}

/** an AI-designed background a scene plays under its title text */
export interface SceneBackground {
  code: Code
  /** the idea, in words (for the notes) */
  concept?: string
  /** its entry in the library */
  id?: string
}

export const FONTS: Array<{ family: string; file: string; weight: string; style: string }> = [
  { family: 'Inter', file: 'Inter-Var.woff2', weight: '100 900', style: 'normal' },
  { family: 'Archivo Black', file: 'ArchivoBlack-Regular.woff2', weight: '400', style: 'normal' },
  { family: 'Barlow Condensed', file: 'BarlowCondensed-ExtraBold.woff2', weight: '800', style: 'normal' },
  { family: 'Instrument Serif', file: 'InstrumentSerif-Italic.woff2', weight: '400', style: 'italic' },
  { family: 'Playfair Display', file: 'PlayfairDisplay-Bold.woff2', weight: '700', style: 'normal' },
  { family: 'Space Grotesk', file: 'SpaceGrotesk-Bold.woff2', weight: '700', style: 'normal' },
  { family: 'Nunito', file: 'Nunito-ExtraBold.woff2', weight: '800', style: 'normal' }
]

export function fontCss(): string {
  return FONTS.map((f) => {
    const p = join(vendorDir, 'fonts', f.file)
    if (!existsSync(p)) return ''
    return `@font-face{font-family:'${f.family}';src:url(data:font/woff2;base64,${readFileSync(p).toString('base64')}) format('woff2');font-weight:${f.weight};font-style:${f.style};font-display:block}`
  }).join('\n')
}

export function gsapJs(): string {
  const p = join(vendorDir, 'gsap.min.js')
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

export const dataUri = (file: string): string => `data:image/${/\.png$/i.test(file) ? 'png' : 'jpeg'};base64,${readFileSync(file).toString('base64')}`

/** the page's code asks for three.js (an ES-module import of 'three') */
export const usesThree = (js: string): boolean => /\bfrom\s*['"]three['"]/.test(js)

let threeCache: string | null = null
/** three.js, offline, as an import map (data URLs): its two vendor files, the second renamed so the first can import it */
export function threeImportMap(): string {
  if (threeCache !== null) return threeCache
  const mod = join(vendorDir, 'three.module.js')
  const core = join(vendorDir, 'three.core.js')
  if (!existsSync(mod) || !existsSync(core)) return (threeCache = '')
  const b64 = (s: string): string => `data:text/javascript;base64,${Buffer.from(s, 'utf8').toString('base64')}`
  const moduleText = readFileSync(mod, 'utf8').replace(/(['"])\.\/three\.core\.js\1/g, '"three-core"')
  threeCache = `<script type="importmap">${JSON.stringify({ imports: { three: b64(moduleText), 'three-core': b64(readFileSync(core, 'utf8')) } })}</script>`
  return threeCache
}

export interface Embed {
  fonts: string
  gsap: string
}

/** the model's page inside the harness: fonts, GSAP, a seeded Math.random, the frame size and the assets */
export function introPage(d: Code, size: { width: number; height: number }, durationSec: number, assets: { picture?: string; logo?: string }, embed: Embed = { fonts: fontCss(), gsap: gsapJs() }): string {
  const A = JSON.stringify({ picture: assets.picture ? dataUri(assets.picture) : '', logo: assets.logo ? dataUri(assets.logo) : '' })
  // a "</script" inside the model's code would end the script early
  const js = d.js.replace(/<\/script/gi, '<\\/script')
  const three = usesThree(d.js)
  const importMap = three ? threeImportMap() : ''
  return `<!doctype html><html><head><meta charset="utf-8"><style>${embed.fonts}
html,body{margin:0;padding:0;width:${size.width}px;height:${size.height}px;overflow:hidden;background:#000}
#stage{position:relative;width:${size.width}px;height:${size.height}px;overflow:hidden}
${d.css}</style>${importMap}</head><body><div id="stage">${d.html}</div>
<script>${embed.gsap}</script>
<script>(function(){var s=20261119;Math.random=function(){s=(s*1664525+1013904223)>>>0;return s/4294967296};})();
window.W=${size.width};window.H=${size.height};window.DURATION=${durationSec.toFixed(3)};window.ASSETS=${A};</script>
<script${three && importMap ? ' type="module"' : ''}>${js}</script></body></html>`
}

/** what must not be in the model's code: anything that makes a frame depend on the wall clock or the network */
export function lintIntro(d: Code): string[] {
  const all = `${d.html}\n${d.css}\n${d.js}`
  const issues: string[] = []
  if (!/window\.__seek\s*=/.test(d.js)) issues.push('The JS must assign window.__seek = function (t) {...} that draws the frame at t seconds.')
  if (/\b(requestAnimationFrame|setTimeout|setInterval|Date\.now|performance\.now|new Date)\b/.test(d.js)) issues.push('Do not use requestAnimationFrame, timers or the clock: every frame must come only from window.__seek(t).')
  if (/\b(fetch|XMLHttpRequest|WebSocket)\b|\bimport\s*\(/.test(d.js)) issues.push('No network: do not fetch or import anything.')
  if (/\bimport\b[^;\n]*\bfrom\s*['"](?!three['"])/.test(d.js)) issues.push("The only module you may import is 'three' (import * as THREE from 'three').")
  if (usesThree(d.js) && !threeImportMap()) issues.push('three.js is not available on this computer: draw with canvas, SVG or CSS instead.')
  if (/(?:src|href)\s*=\s*["']?https?:|url\(\s*["']?https?:|@import/i.test(all)) issues.push('No external files (links, images, fonts, @import): use ASSETS, the fonts listed and drawn shapes only.')
  if (/<script/i.test(d.html)) issues.push('Put all code in js, not <script> tags inside html.')
  if (/\b(animation\s*:|animation-name|transition\s*:)/i.test(d.css)) issues.push('CSS animations and transitions do not follow the seek; drive every change from window.__seek(t) (or a paused GSAP timeline seeked there).')
  if (d.js.length + d.css.length + d.html.length > 60000) issues.push('The code is too long; keep it under 60,000 characters.')
  return issues
}

/** the slowest average a frame may take to draw and capture (CPU rendering; ~180 frames per scene) */
export const SLOW_FRAME_MS = 1000

export interface Preview {
  errors: string[]
  frames: string[]
  measured: string[]
}

export interface PreviewOptions {
  /** the moments to look at (seconds); default four spread over the duration */
  at?: number[]
  /** words that must be on screen as real text (the hook / the headline); '' = no check */
  hook?: string
  /** where the words are (default the model's own '#stage') */
  textRoot?: string
  /** a page with no words of its own (a background): no off-frame or missing-words checks */
  noText?: boolean
  /** the frames' file prefix */
  prefix?: string
}

/** load the page in a real browser, step it to a few moments, and measure what is wrong */
export async function previewPage(html: string, size: { width: number; height: number }, durationSec: number, dir: string, round: number, opts: PreviewOptions = {}): Promise<Preview> {
  const errors: string[] = []
  const frames: string[] = []
  const measured: string[] = []
  const at = opts.at ?? [0.2, durationSec * 0.38, durationSec * 0.7, Math.max(0.3, durationSec - 0.1)]
  const prefix = opts.prefix ?? ''
  const root = opts.textRoot ?? '#stage'
  const browser = await launch({ width: size.width, height: size.height, scale: 1, userDataDir: join(dir, `profile-${prefix}${round}`) })
  try {
    const page = await browser.newPage()
    page.on('pageerror', (e) => errors.push(String((e as Error)?.message ?? e).slice(0, 200)))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })
    await page.setViewport({ width: size.width, height: size.height, deviceScaleFactor: 1 })
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 })
    // a module script (three.js) may still be starting
    await page.waitForFunction('typeof window.__seek === "function"', { timeout: 8000 }).catch(() => undefined)
    await page.evaluate('document.fonts && document.fonts.ready')
    const hasSeek = await page.evaluate('typeof window.__seek === "function"')
    if (!hasSeek) return { errors: [...errors, 'window.__seek is not a function after the page loaded (a script error stopped it?)'], frames, measured }
    const sharp = (await import('sharp')).default
    const means: number[][] = []
    const thumbs: Buffer[] = []
    const spent: number[] = []
    for (const [k, t] of at.entries()) {
      const began = Date.now()
      try {
        await page.evaluate(`window.__seek(${t.toFixed(3)})`)
      } catch (e) {
        errors.push(`__seek(${t.toFixed(2)}) threw: ${String((e as Error)?.message ?? e).slice(0, 160)}`)
        continue
      }
      const buf = Buffer.from(await page.screenshot({ type: 'jpeg', quality: 85 }))
      spent.push(Date.now() - began)
      const file = join(dir, `${prefix}round${round}-frame${k}.jpg`)
      writeFileSync(file, buf)
      frames.push(file)
      const st = await sharp(buf).stats()
      means.push(st.channels.slice(0, 3).map((c) => c.mean))
      thumbs.push(await sharp(buf).resize(48, 48, { fit: 'fill' }).greyscale().raw().toBuffer())
      if (st.channels.slice(0, 3).every((c) => c.stdev < 6)) measured.push(`At ${t.toFixed(1)}s the frame is one flat colour (nothing visible, or so faint it cannot be seen: make the art clearly visible).`)
      // text that runs off the frame
      if (!opts.noText) {
        const off = (await page.evaluate(`(() => {
          const out = [];
          const W = innerWidth, H = innerHeight;
          for (const el of document.querySelectorAll(${JSON.stringify(root + ' *')})) {
            if (!el.childNodes || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
            const cs = getComputedStyle(el);
            if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.2) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) continue;
            if (r.left < -4 || r.top < -4 || r.right > W + 4 || r.bottom > H + 4) out.push(el.textContent.trim().slice(0, 40));
          }
          return out.slice(0, 3);
        })()`)) as string[]
        if (k === 2 && off.length) measured.push(`Text runs off the frame at ${t.toFixed(1)}s: "${off.join('", "')}". Keep every word inside the frame with a margin.`)
      }
    }
    // a film is ~30 frames a second: a frame that takes seconds to draw makes the render take far too long
    if (spent.length >= 3) {
      const avg = spent.reduce((a, b) => a + b, 0) / spent.length
      if (avg > SLOW_FRAME_MS) measured.push(`Too slow to render: each frame took about ${(avg / 1000).toFixed(1)} s to draw and the film needs ~180 of them. Draw far less per frame (fewer shapes, no three.js unless tiny, smaller canvas scaled up) so a frame takes well under ${(SLOW_FRAME_MS / 1000).toFixed(1)} s.`)
    }
    // motion: pixels change from moment to moment (a rotating or drifting picture keeps the same average colour, so compare the pictures themselves)
    if (thumbs.length >= 3) {
      const change = (a: Buffer, b: Buffer): number => {
        let d = 0
        for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i])
        return d / a.length
      }
      const moves = thumbs.slice(1).map((t, i) => change(thumbs[i], t))
      if (Math.max(...moves) < 0.5) measured.push('Nothing moves: the frames are almost the same from start to end. The opening must be in motion all the way through.')
    }
    // the hook must actually be on screen as words
    const hook = opts.hook ?? ''
    if (hook && !opts.noText) {
      const text = String(await page.evaluate(`(document.querySelector(${JSON.stringify(root)}).innerText || '') + ' ' + [...document.querySelectorAll('svg text')].map((t) => t.textContent).join(' ')`)).toLowerCase()
      const key = hook.toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).filter((w) => w.length > 3)
      const shown = key.filter((w) => text.includes(w)).length
      if (key.length && shown < Math.ceil(key.length * 0.6)) measured.push(`The hook "${hook}" is not on screen as real text (HTML or SVG text, not drawn on a canvas).`)
    }
  } finally {
    await browser.close().catch(() => undefined)
  }
  return { errors: errors.slice(0, 6), frames, measured }
}
