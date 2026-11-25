import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { findChrome } from '../src/main/appRecon/browser'
import { renderScene, sceneHtml } from '../src/main/appRecon/scenes'
import { directBackground } from '../src/main/introBg/director'
import { designFilmBackgrounds } from '../src/main/introBg/film'
import { lintIntro, type Code } from '../src/main/introBg/kit'
import { IntroBackgroundLibrary } from '../src/main/introBg/library'
import type { GenerateJSONRequest, LLMProvider } from '../src/main/providers/types'

/**
 * The intro-background director: the title and closing scenes sit on art the
 * AI designs for THIS film. A scripted stand-in plays the model, so nothing is
 * paid for. The checks that need a browser are skipped where there is none.
 */

const root = mkdtempSync(join(tmpdir(), 'vg-introbg-dir-'))
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }))

const size = { width: 360, height: 640 }

const NL = String.fromCharCode(10)
const art = (kind: string): Draft => ({
  concept: `Calligraphic arcs draw themselves around a balance (${kind}).`,
  keywords: ['quran', 'balance', 'calligraphy', 'arc'],
  mood: 'contemplative',
  palette: ['#10200a', '#6aa629'],
  html: '',
  css: '',
  js: `var c=document.createElement('canvas');c.width=W;c.height=H;document.getElementById('stage').appendChild(c);var x=c.getContext('2d');
${Array.from({ length: 14 }, (_, i) => `var tag${i} = '${kind}-${i}';`).join(NL)}
window.__seek=function(t){var u=t/DURATION;var g=x.createLinearGradient(0,0,W,H);g.addColorStop(0,'#10200a');g.addColorStop(1,'#1d3a10');x.fillStyle=g;x.fillRect(0,0,W,H);
for(var i=0;i<14;i++){x.strokeStyle='rgba(140,210,60,'+(0.35+0.03*i)+')';x.lineWidth=5;x.beginPath();x.arc(W/2,H/2+i*3,40+i*22+u*30,0,Math.PI*2*(0.3+0.6*u));x.stroke()}
/* ${kind} */};`
})

interface Draft extends Code {
  concept: string
  keywords: string[]
  mood: string
  palette: string[]
}

/** a scripted model: answers each request with the next function's result, and keeps what it was asked */
function scripted(answers: Array<(req: GenerateJSONRequest) => unknown>, review = { score: 8, belongsToSubject: true, generic: false, titleReadable: true, issues: [] as string[] }): { chat: LLMProvider; asked: GenerateJSONRequest[] } {
  const asked: GenerateJSONRequest[] = []
  let n = 0
  const chat = {
    id: 'gemini',
    label: 'Scripted',
    supportsVision: () => true,
    generateJSON: async (req: GenerateJSONRequest) => {
      asked.push(req)
      if (req.schemaName === 'IntroBackgroundReview') return review
      const a = answers[Math.min(n++, answers.length - 1)]
      return a(req)
    }
  } as unknown as LLMProvider
  return { chat, asked }
}

const brief = {
  kind: 'title' as const,
  topic: "Taaweel's Mizan Tool: mathematically compare words in the Quran on an even-odd circle chart",
  product: "Taaweel's Mizan Tool",
  about: 'Compare ar-Rahman and ar-Rahim: how often each occurs, in what ratio, and where.',
  narration: 'We have always wondered how many times each word has occurred in Quran.',
  pill: 'NEW',
  headline: "Taaweel's Mizan Tool",
  sub: 'Mathematically Compare words in Quran',
  accent: '6aa629',
  colors: ['#6aa629']
}

describe('what the director asks the model', () => {
  it('puts the topic, the product, the words over the art, the brand colour and the rules in the request', async () => {
    const { chat, asked } = scripted([() => { throw new Error('offline') }])
    const r = await directBackground({ chat, brief, size, durationSec: 4, dir: join(root, 'p1'), rounds: 1 })
    expect(r.background).toBeNull()
    expect(r.why).toMatch(/could not write the code/)
    const q = asked[0]
    expect(q.prompt).toMatch(/Mizan Tool/)
    expect(q.prompt).toMatch(/even-odd circle/)
    expect(q.prompt).toMatch(/ar-Rahman/)
    expect(q.prompt).toMatch(/How many times|many times each word/i)
    expect(q.prompt).toMatch(/headline "Taaweel's Mizan Tool"/)
    expect(q.prompt).toMatch(/label "NEW"/)
    expect(q.prompt).toMatch(/#6aa629/)
    expect(q.prompt).toMatch(/TITLE scene/)
    expect(q.prompt).toMatch(/360×640 \(tall/)
    // the rules: made for the subject, never a stock backdrop, offline code only
    expect(q.system).toMatch(/NOT a stock backdrop/)
    expect(q.system).toMatch(/constellations/)
    expect(q.system).toMatch(/window\.__seek/)
    expect(q.system).toMatch(/three\.js/)
    expect(q.schemaName).toBe('IntroBackgroundCode')
  })

  it('shows the model pictures of the product pages', async () => {
    const pic = join(root, 'page.jpg')
    writeFileSync(pic, await sharp({ create: { width: 200, height: 120, channels: 3, background: '#335533' } }).jpeg().toBuffer())
    const { chat, asked } = scripted([() => { throw new Error('offline') }])
    await directBackground({ chat, brief, size, durationSec: 4, dir: join(root, 'p2'), rounds: 1, pictures: [pic, join(root, 'missing.jpg')] })
    expect(asked[0].images).toHaveLength(1)
    expect(asked[0].prompt).toMatch(/screenshot\(s\) of the product's own pages/)
  })

  it('offers a close stored background as a starting point to adapt, and nothing when none is close', async () => {
    const lib = new IntroBackgroundLibrary(join(root, 'lib-prompt'))
    const stored = art('stored')
    lib.save({ topic: 'A tool comparing words of the Quran by ratio', keywords: ['quran', 'word', 'ratio', 'balance'], mood: 'contemplative', palette: ['#10200a'], concept: 'Balance beam over verse cells.', model: 't', score: 8, aspects: ['tall'], size, durationSec: 4, kind: 'title', usesThree: false }, stored, 'x')
    const near = scripted([() => { throw new Error('offline') }])
    await directBackground({ chat: near.chat, brief, size, durationSec: 4, dir: join(root, 'p3'), rounds: 1, library: lib })
    expect(near.asked[0].prompt).toMatch(/STARTING POINT/)
    expect(near.asked[0].prompt).toMatch(/Do not hand it back unchanged/)
    expect(near.asked[0].prompt).toContain('Balance beam over verse cells.')
    const far = scripted([() => { throw new Error('offline') }])
    await directBackground({ chat: far.chat, brief: { ...brief, topic: 'PulseTrack fitness tracker: heart rate and activity rings', product: 'PulseTrack', about: 'workouts and weekly progress', narration: 'Every rep counts.', headline: 'PulseTrack' }, size, durationSec: 4, dir: join(root, 'p4'), rounds: 1, library: lib })
    expect(far.asked[0].prompt).not.toMatch(/STARTING POINT/)
  })

  it('asks the closing scene for the title scene’s family, settled', async () => {
    const { chat, asked } = scripted([() => { throw new Error('offline') }])
    await directBackground({ chat, brief: { ...brief, kind: 'outro', headline: "Taaweel's Mizan Tool", sub: 'Try it today' }, size, durationSec: 4, dir: join(root, 'p5'), rounds: 1, family: { code: art('title'), concept: 'Calligraphic arcs around a balance.' } })
    expect(asked[0].prompt).toMatch(/CLOSING scene/)
    expect(asked[0].prompt).toMatch(/BELONG with the title scene/)
    expect(asked[0].prompt).toContain('Calligraphic arcs around a balance.')
  })
})

describe('the code rules', () => {
  const base: Code = { html: '', css: '', js: 'window.__seek=function(t){}' }
  it('allows three.js only as the one import', () => {
    expect(lintIntro({ ...base, js: "import * as THREE from 'three';\nwindow.__seek=function(t){}" })).toEqual([])
    expect(lintIntro({ ...base, js: "import x from 'https://cdn.example/three.js';\nwindow.__seek=function(t){}" }).join(' ')).toMatch(/only module you may import is 'three'/)
    expect(lintIntro({ ...base, js: "const m = await import('three');\nwindow.__seek=function(t){}" }).join(' ')).toMatch(/network/)
  })
})

describe('when no model can do it, the drawn motif is the last resort and the notes say so', () => {
  it('a mock engine or no writer designs nothing', async () => {
    const none = await designFilmBackgrounds({ chat: null, library: null, dir: join(root, 'f1'), size, topic: 't', title: { headline: 'H' }, drawnName: 'graph' })
    expect(none.title).toBeUndefined()
    expect(none.notes.join(' ')).toMatch(/No AI writer is set up, so the title and closing scenes use the drawn "graph" motif/)
    const mock = await designFilmBackgrounds({ chat: { id: 'mock' } as unknown as LLMProvider, library: null, dir: join(root, 'f2'), size, topic: 't', title: { headline: 'H' }, drawnName: 'flow' })
    expect(mock.notes.join(' ')).toMatch(/drawn "flow" motif/)
  })

  it('every round failing gives no background, and the notes name the motif and the reason', async () => {
    const { chat } = scripted([() => { throw new Error('quota exceeded') }])
    const r = await designFilmBackgrounds({ chat, library: null, dir: join(root, 'f3'), size, topic: 'A topic', title: { headline: 'H' }, outro: { headline: 'H' }, drawnName: 'cards', rounds: 2 })
    expect(r.title).toBeUndefined()
    expect(r.outro).toBeUndefined()
    expect(r.notes.join(' ')).toMatch(/could not design a background for this film \(the director could not write the code \(quota exceeded\)\), so the title and closing scenes use the drawn "cards" motif/)
  })

  it('a draft that breaks the code rules in every round is not used', async () => {
    const { chat, asked } = scripted([() => ({ ...art('x'), js: 'setTimeout(function(){},10); window.__seek=function(t){}' })])
    const r = await directBackground({ chat, brief, size, durationSec: 4, dir: join(root, 'f4'), rounds: 2 })
    expect(r.background).toBeNull()
    expect(r.why).toMatch(/broke the rules/)
    // the second round was told what was wrong
    expect(asked[1].prompt).toMatch(/Do not use requestAnimationFrame, timers or the clock/)
  })
})

describe('scenes over a designed background', () => {
  it('is its own page in a frame with the words over it, and none of the drawn motif', () => {
    const html = sceneHtml({ kind: 'title', motif: 'graph', pill: 'NEW', headline: "Taaweel's Mizan Tool", sub: 'Compare words', accent: '6aa629', durationSec: 4, size, background: { code: art('t'), concept: 'c' } })
    expect(html).toContain('<iframe id="bgf"')
    expect(html).toContain('srcdoc=')
    expect(html).toContain("Taaweel&#39;s Mizan Tool")
    expect(html).not.toContain('graphResolved')
    expect(html).not.toContain('mkGlow')
    // the drawn motif page is unchanged for scenes with no background
    expect(sceneHtml({ kind: 'title', motif: 'graph', headline: 'H', durationSec: 4 })).toContain('graphResolved')
  })
})

describe.skipIf(!findChrome())('the intro-background director with a browser', () => {
  it('writes, checks and reviews the art with the title over it, keeps it in the library, and adapts it for a later film', async () => {
    const lib = new IntroBackgroundLibrary(join(root, 'lib-real'))
    const t = scripted([() => art('first')])
    const r = await directBackground({ chat: t.chat, brief, size, durationSec: 2, dir: join(root, 'r1'), rounds: 2, library: lib, modelName: 'scripted-model' })
    expect(r.background).not.toBeNull()
    expect(r.score).toBeGreaterThanOrEqual(7)
    expect(r.savedId).toBeTruthy()
    // the review saw four frames with the words over them
    const review = t.asked.find((q) => q.schemaName === 'IntroBackgroundReview')!
    expect(review.images).toHaveLength(4)
    expect(review.system).toMatch(/stock backdrop/)
    // kept with detailed notes
    const saved = lib.list()[0]
    expect(saved).toMatchObject({ kind: 'title', model: 'scripted-model', aspects: ['tall'], mood: 'contemplative' })
    expect(saved.keywords).toEqual(expect.arrayContaining(['quran', 'balance']))
    expect(existsSync(join(lib.root, saved.id, 'index.html'))).toBe(true)
    expect(readFileSync(join(lib.root, saved.id, 'index.html'), 'utf8')).toContain('window.__seek')
    expect(existsSync(join(lib.root, saved.id, 'preview.jpg'))).toBe(true)

    // a later film on a similar topic: the model hands the stored code back unchanged first, which is refused; its redesign is accepted
    const stored = lib.get(saved.id)!.code
    const t2 = scripted([() => ({ ...art('first'), ...stored }), () => art('redesigned for the new film')])
    const r2 = await directBackground({ chat: t2.chat, brief: { ...brief, product: 'Mizan 2', headline: 'Mizan 2' }, size, durationSec: 2, dir: join(root, 'r2'), rounds: 3, library: lib })
    expect(t2.asked[0].prompt).toMatch(/STARTING POINT/)
    const writes = t2.asked.filter((q) => q.schemaName === 'IntroBackgroundCode')
    expect(writes).toHaveLength(2)
    expect(writes[1].prompt).toMatch(/handed back the stored background unchanged/)
    expect(r2.background?.code.js).toContain('redesigned for the new film')
    expect(r2.adaptedFrom?.id).toBe(saved.id)
    expect(lib.list().find((e) => e.id === saved.id)?.adaptedCount).toBe(1)
  }, 180000)

  it('fixes a draft with a script error, using what the browser saw', async () => {
    const t = scripted([() => ({ ...art('broken'), js: 'window.__seek=function(t){ nothingHere.go(t) }' }), () => art('fixed')])
    const r = await directBackground({ chat: t.chat, brief, size, durationSec: 2, dir: join(root, 'r3'), rounds: 3 })
    expect(r.background?.code.js).toContain('fixed')
    expect(r.rounds).toBe(2)
    const writes = t.asked.filter((q) => q.schemaName === 'IntroBackgroundCode')
    expect(writes[1].prompt).toMatch(/Script error/)
  }, 180000)

  it('turns a stock-backdrop verdict into a redesign, and a closing scene may not copy the title scene', async () => {
    const generic = { score: 9, belongsToSubject: false, generic: true, titleReadable: true, issues: ['Dots and lines'] }
    const t = scripted([() => art('stars'), () => art('about the subject')], generic)
    const r = await directBackground({ chat: t.chat, brief, size, durationSec: 2, dir: join(root, 'r4'), rounds: 2 })
    // never accepted as it was, whatever its score, while it reads as generic
    const writes = t.asked.filter((q) => q.schemaName === 'IntroBackgroundCode')
    expect(writes[1].prompt).toMatch(/stock backdrop/)
    expect(r.rounds).toBe(2)

    const title = art('title')
    const t2 = scripted([() => title, () => art('settled ending')])
    const o = await directBackground({ chat: t2.chat, brief: { ...brief, kind: 'outro', sub: 'Try it today' }, size, durationSec: 2, dir: join(root, 'r5'), rounds: 3, family: { code: title, concept: 'arcs' } })
    const ow = t2.asked.filter((q) => q.schemaName === 'IntroBackgroundCode')
    expect(ow[1].prompt).toMatch(/handed back the title scene's background unchanged/)
    expect(o.background?.code.js).toContain('settled ending')
  }, 180000)

  it('designs a title and a closing background for a film and says what it designed', async () => {
    const lib = new IntroBackgroundLibrary(join(root, 'lib-film'))
    const t = scripted([() => art('title'), () => art('closing')])
    const d = await designFilmBackgrounds({ chat: t.chat, library: lib, dir: join(root, 'film'), size, topic: brief.topic, product: brief.product, about: brief.about, narration: brief.narration, title: { pill: 'NEW', headline: brief.headline, sub: brief.sub }, outro: { headline: brief.headline, sub: 'Try it today' }, accent: '6aa629', titleSec: 2, outroSec: 2, drawnName: 'graph' })
    expect(d.title).toBeDefined()
    expect(d.outro).toBeDefined()
    expect(d.outro).not.toBe(d.title)
    expect(d.notes.join(' ')).toMatch(/title scene's background was designed for this film: Calligraphic arcs/)
    expect(d.notes.join(' ')).toMatch(/closing scene's background was designed for this film/)
    expect(d.notes.join(' ')).not.toMatch(/drawn/)
    expect(lib.list().map((e) => e.kind).sort()).toEqual(['outro', 'title'])
  }, 240000)

  it('renders a scene over the designed background to a video', async () => {
    const out = join(root, 'scene.mp4')
    const r = await renderScene({ kind: 'title', motif: 'graph', pill: 'NEW', headline: 'Hello', accent: '6aa629', durationSec: 1, size, background: { code: art('render') } }, out)
    expect(existsSync(r.file)).toBe(true)
    expect(r.durationSec).toBeGreaterThan(0.9)
  }, 120000)
})
